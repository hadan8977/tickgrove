use crate::App;
use serde_json::{Value, json};
use sqlx::Row;
use tokio::time::{Duration, sleep};
pub async fn queue(app: App) {
    loop {
        let owned = app.clone();
        match tokio::spawn(async move { next(&owned).await }).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("queue: {e}"),
            Err(error) => {
                eprintln!("queue worker failed: {error}");
                if let Ok(Some(id)) = sqlx::query_scalar::<_, String>(
                    "SELECT id FROM jobs WHERE status='running' ORDER BY rowid LIMIT 1",
                )
                .fetch_optional(&app.db)
                .await
                {
                    let _ = finish(
                        &app,
                        &id,
                        "failed",
                        None,
                        Some("Worker internal failure; no successful result committed".into()),
                    )
                    .await;
                }
            }
        }
        sleep(Duration::from_millis(200)).await;
    }
}
async fn next(app: &App) -> anyhow::Result<()> {
    let Some(row)=sqlx::query("SELECT j.*,v.source,v.kind,v.library_lock,s.payload FROM jobs j JOIN strategy_versions v ON v.id=j.version_id JOIN snapshots s ON s.id=j.snapshot_id WHERE j.status='queued' ORDER BY j.rowid LIMIT 1").fetch_optional(&app.db).await? else{return Ok(())};
    let id: String = row.get("id");
    if row.get::<i64, _>("cancel_requested") != 0 {
        return finish(
            app,
            &id,
            "cancelled",
            None,
            Some("Cancelled before execution".into()),
        )
        .await;
    }
    let claimed = sqlx::query(
        "UPDATE jobs SET status='running' WHERE id=? AND status='queued' AND cancel_requested=0",
    )
    .bind(&id)
    .execute(&app.db)
    .await?
    .rows_affected();
    if claimed == 0 {
        return Ok(());
    }
    event(app, &id, "running", json!({"progress":0})).await?;
    let manifest: Value = serde_json::from_str(&row.get::<String, _>("manifest"))?;
    let data: Value = serde_json::from_str(&row.get::<String, _>("payload"))?;
    let adapter = match crate::commands::adapter_hash(app, &row.get::<String, _>("kind")) {
        Ok(hash) => hash,
        Err(error) => {
            return finish(
                app,
                &id,
                "failed",
                None,
                Some(format!("Worker adapter unavailable: {error}")),
            )
            .await;
        }
    };
    if manifest["adapter_hash"].as_str() != Some(adapter.as_str()) {
        return finish(
            app,
            &id,
            "failed",
            None,
            Some(
                "Worker adapter changed since manifest creation; create a new reproducible run"
                    .into(),
            ),
        )
        .await;
    }

    let request = json!({"kind":row.get::<String,_>("kind"),"source":row.get::<String,_>("source"),"data":data,"inputs":manifest["inputs"],"continuous":manifest["continuous"],"libraryLock":row.get::<Option<String>,_>("library_lock").map(|text|serde_json::from_str::<Value>(&text)).transpose()?});
    let mut outcome = tokio::time::timeout(Duration::from_secs(32), run(app, &id, request))
        .await
        .unwrap_or_else(|_| {
            Ok((
                "timed_out".into(),
                None,
                Some("Worker total deadline exceeded".into()),
            ))
        });
    if let Ok((status, Some(result), _)) = &outcome {
        if status == "succeeded" {
            if let Some(previous) = manifest["previous_job_id"].as_str() {
                let old: String =
                    sqlx::query_scalar("SELECT result FROM jobs WHERE id=? AND status='succeeded'")
                        .bind(previous)
                        .fetch_one(&app.db)
                        .await?;
                let old: Value = serde_json::from_str(&old)?;
                if let Err(e) = validate_prefix(&old, result) {
                    outcome = Ok(("failed".into(), None, Some(e.to_string())));
                }
            }
        }
    }
    match outcome {
        Ok((status, result, error)) => finish(app, &id, &status, result, error).await,
        Err(e) => finish(app, &id, "failed", None, Some(e.to_string())).await,
    }
}
async fn run(
    app: &App,
    id: &str,
    request: Value,
) -> anyhow::Result<(String, Option<Value>, Option<String>)> {
    let _permit = app.execution_budget.acquire().await?;
    let mounts =
        ["src", "scripts", "node_modules"].map(|p| (app.root.join(p), format!("/app/{p}")));
    let command =
        crate::sandbox::command(&app.node, &mounts, "/app/scripts/service-worker.cjs", 256);
    let output = crate::sandbox::execute(
        command,
        request.to_string().into_bytes(),
        30,
        32_000_000,
        Some((app, id)),
    )
    .await?;
    if ["cancelled", "timed_out"].contains(&output.status.as_str()) {
        return Ok((
            output.status,
            None,
            Some("Worker cancelled or total deadline exceeded".into()),
        ));
    }
    let result: Value = serde_json::from_slice(&output.stdout).map_err(|e| {
        anyhow::anyhow!(
            "Invalid worker response: {e}; {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    if output.status == "succeeded" && result["ok"] == true {
        Ok(("succeeded".into(), Some(result), None))
    } else {
        Ok(("failed".into(), None, Some(result["error"].to_string())))
    }
}

async fn event(app: &App, id: &str, kind: &str, payload: Value) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO events(job_id,kind,payload) VALUES(?,?,?)")
        .bind(id)
        .bind(kind)
        .bind(payload.to_string())
        .execute(&app.db)
        .await?;
    Ok(())
}
async fn finish(
    app: &App,
    id: &str,
    status: &str,
    result: Option<Value>,
    error: Option<String>,
) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    let cancelled = sqlx::query_scalar::<_, i64>("SELECT cancel_requested FROM jobs WHERE id=?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
        != 0;
    let status = if cancelled { "cancelled" } else { status };
    let result = if cancelled { None } else { result };
    sqlx::query(
        "UPDATE jobs SET status=?,result=?,error=? WHERE id=? AND status IN ('running','queued')",
    )
    .bind(status)
    .bind(result.as_ref().map(|r| r.to_string()))
    .bind(&error)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO events(job_id,kind,payload) VALUES(?,?,?)")
        .bind(id)
        .bind(status)
        .bind(json!({"error":error,"progress":1}).to_string())
        .execute(&mut *tx)
        .await?;
    if status == "succeeded" {
        if let Some(result) = result {
            if let Some(session) =
                sqlx::query("SELECT id,last_job_id FROM paper_sessions WHERE pending_job_id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
            {
                if let Some(previous) = session.get::<Option<String>, _>("last_job_id") {
                    let old: String = sqlx::query_scalar("SELECT result FROM jobs WHERE id=?")
                        .bind(previous)
                        .fetch_one(&mut *tx)
                        .await?;
                    let old: Value = serde_json::from_str(&old)?;
                    let cutoff = old["backtest"]["replayFrames"]
                        .as_array()
                        .or_else(|| old["frames"].as_array())
                        .and_then(|f| f.last())
                        .and_then(|f| f["time"].as_i64())
                        .unwrap_or(i64::MAX)
                        .saturating_mul(1000);
                    for (index, alert) in result["alerts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .enumerate()
                    {
                        if let Some(time) = alert["time"].as_i64().filter(|t| *t > cutoff) {
                            let session_id: String = session.get("id");
                            let alert_id = crate::commands::hash(&format!(
                                "{session_id}:{time}:{index}:{}:{}",
                                alert["id"], alert["message"]
                            ));
                            sqlx::query(
                                "INSERT OR IGNORE INTO pine_alert_history(id,session_id,job_id,event_time,payload,received_at) VALUES(?,?,?,?,?,?)",
                            )
                            .bind(alert_id)
                            .bind(session_id)
                            .bind(id)
                            .bind(time)
                            .bind(alert.to_string())
                            .bind(crate::market::now())
                            .execute(&mut *tx)
                            .await?;
                        }
                    }
                }
            }
        }
        sqlx::query("UPDATE paper_sessions SET snapshot_id=(SELECT snapshot_id FROM jobs WHERE id=?),last_job_id=?,pending_job_id=NULL,status=CASE WHEN status='initializing' THEN 'active' ELSE status END WHERE pending_job_id=?").bind(id).bind(id).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

fn validate_prefix(old: &Value, new: &Value) -> anyhow::Result<()> {
    let before = old["backtest"]["replayFrames"]
        .as_array()
        .or_else(|| old["frames"].as_array())
        .ok_or_else(|| anyhow::anyhow!("Committed result missing authoritative frames"))?;
    let after = new["backtest"]["replayFrames"]
        .as_array()
        .or_else(|| new["frames"].as_array())
        .ok_or_else(|| anyhow::anyhow!("Continuous result missing authoritative frames"))?;
    anyhow::ensure!(
        after.len() >= before.len() && before.iter().zip(after).all(|(a, b)| a == b),
        "Continuous prefix changed committed historical state; repainting strategy rejected"
    );
    if let Some(trades) = old["backtest"]["trades"].as_array() {
        let next = new["backtest"]["trades"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing native trades"))?;
        anyhow::ensure!(
            next.len() >= trades.len() && trades.iter().zip(next).all(|(a, b)| a == b),
            "Continuous rebuild changed committed trade identity/price/fee"
        );
        for position in old["backtest"]["openPositions"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let qty = position["qty"].as_f64().unwrap_or(0.);
            let mut remaining = 0.;
            for open in new["backtest"]["openPositions"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if open["entryId"] == position["entryId"]
                    && open["time"] == position["time"]
                    && open["price"] == position["price"]
                {
                    remaining += open["qty"].as_f64().unwrap_or(0.);
                }
            }
            for trade in next.iter().skip(trades.len()) {
                if trade["entryId"] == position["entryId"]
                    && trade["entryTime"] == position["time"]
                    && trade["entryPrice"] == position["price"]
                {
                    remaining += trade["qty"].as_f64().unwrap_or(0.)
                        * if trade["side"] == "short" { -1. } else { 1. };
                }
            }
            anyhow::ensure!(
                (remaining - qty).abs() < 1e-8,
                "Continuous rebuild changed an existing entry identity/price/quantity"
            );
        }
    }
    Ok(())
}
