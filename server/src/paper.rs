use crate::{
    App,
    commands::{hash, required, validate_data},
};
use serde_json::{Value, json};
use sqlx::Row;
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "paper.deploy" => {
            let version = required(p, "version_id")?;
            let snapshot = required(p, "snapshot_id")?;
            anyhow::ensure!(
                p["execution"].as_str().unwrap_or("closed_bar_native") == "closed_bar_native",
                "Only closed_bar_native supports reconstruction; ticks and external fills are unsupported"
            );
            anyhow::ensure!(
                p.get("inputs").is_none_or(|v| v.is_object()),
                "inputs must be object"
            );
            let row = sqlx::query(
                "SELECT kind,source,name,library_lock FROM strategy_versions WHERE id=?",
            )
            .bind(version)
            .fetch_one(&app.db)
            .await?;
            let dataset: Value = serde_json::from_str(
                &sqlx::query_scalar::<_, String>("SELECT payload FROM snapshots WHERE id=?")
                    .bind(snapshot)
                    .fetch_one(&app.db)
                    .await?,
            )?;
            anyhow::ensure!(
                dataset["metadata"]["provenance"]["gaps"]
                    .as_array()
                    .is_none_or(|g| g.is_empty()),
                "Snapshot gaps prevent continuous deployment"
            );
            if let Some(extra) = dataset["datasets"].as_array() {
                let mut symbols = std::collections::HashSet::new();
                symbols.insert(dataset["symbol"].as_str().unwrap_or(""));
                for d in extra {
                    anyhow::ensure!(
                        d["timeframe"] == dataset["timeframe"],
                        "Continuous initial release requires a single timeframe; multi-timeframe requests remain available for backtests"
                    );
                    anyhow::ensure!(
                        symbols.insert(d["symbol"].as_str().unwrap_or("")),
                        "Continuous datasets require unique symbols"
                    );
                }
            }
            anyhow::ensure!(
                p.get("subscription_id")
                    .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| !s.is_empty())),
                "subscription_id must be a string"
            );
            let bindings = if let Some(id) = p["subscription_id"].as_str() {
                crate::paper_stream::bindings(app, &dataset, id).await?
            } else {
                Vec::new()
            };
            let adapter = crate::commands::adapter_hash(app, &row.get::<String, _>("kind"))?;
            let id = uuid::Uuid::new_v4().to_string();
            let job = uuid::Uuid::new_v4().to_string();
            let inputs = Value::Object(p["inputs"].as_object().cloned().unwrap_or_default());
            let mut tx = app.db.begin().await?;
            let strategy_hash: String =
                sqlx::query_scalar("SELECT hash FROM strategy_versions WHERE id=?")
                    .bind(version)
                    .fetch_one(&mut *tx)
                    .await?;
            let snapshot_hash: String = sqlx::query_scalar("SELECT hash FROM snapshots WHERE id=?")
                .bind(snapshot)
                .fetch_one(&mut *tx)
                .await?;
            let manifest = json!({"version_id":version,"snapshot_id":snapshot,"strategy_hash":strategy_hash,"snapshot_hash":snapshot_hash,"inputs":inputs,"paper_session":id,"continuous":true,"execution":"closed_bar_native","engine":"pinets@0.11.1 / composer-v1","adapter_hash":adapter,"library_lock":crate::commands::lock_summary(row.get::<Option<String>,_>("library_lock").as_deref())?});
            sqlx::query("INSERT INTO jobs(id,version_id,snapshot_id,manifest,status) VALUES(?,?,?,?,'queued')").bind(&job).bind(version).bind(snapshot).bind(manifest.to_string()).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO paper_sessions(id,version_id,snapshot_id,inputs,status,pending_job_id,subscription_id,stream_cursor,name) VALUES(?,?,?,?,'initializing',?,?,(SELECT COALESCE(MAX(cursor),0) FROM market_events),?)").bind(&id).bind(version).bind(snapshot).bind(inputs.to_string()).bind(&job).bind(p["subscription_id"].as_str()).bind(p["name"].as_str().unwrap_or(&row.get::<String,_>("name"))).execute(&mut *tx).await?;
            for (subscription, symbol) in &bindings {
                sqlx::query("INSERT INTO paper_bindings VALUES(?,?,?)")
                    .bind(&id)
                    .bind(subscription)
                    .bind(symbol)
                    .execute(&mut *tx)
                    .await?;
                let series = if dataset["symbol"] == symbol.as_str() {
                    &dataset
                } else {
                    dataset["datasets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|d| d["symbol"] == symbol.as_str())
                        .unwrap()
                };
                let last = series["bars"].as_array().unwrap().last().unwrap()["time"]
                    .as_i64()
                    .unwrap();
                let cached=sqlx::query("SELECT time,payload FROM market_bars WHERE subscription_id=? AND closed=1 AND json_extract(quality,'$.complete')=1 AND time>? ORDER BY time LIMIT 2048").bind(subscription).bind(last).fetch_all(&mut *tx).await?;
                for bar in cached {
                    sqlx::query("INSERT INTO paper_market_pending(session_id,symbol,time,payload,cursor) VALUES(?,?,?,?,(SELECT stream_cursor FROM paper_sessions WHERE id=?))").bind(&id).bind(symbol).bind(bar.get::<i64,_>("time")).bind(bar.get::<String,_>("payload")).bind(&id).execute(&mut *tx).await?;
                }
            }
            tx.commit().await?;
            Ok(
                json!({"job_id":job,"session_id":id,"status":"initializing","contract":"closed_bar_native: append-only visible bars; reconstruct native ledger; no external orders"}),
            )
        }
        "paper.list" => {
            let rows = sqlx::query("SELECT ps.id,ps.version_id,ps.snapshot_id,ps.status,ps.last_job_id,ps.pending_job_id,ps.subscription_id,ps.stream_cursor,ps.error,ps.name,pj.status AS pending_job_status,pj.error AS pending_job_error FROM paper_sessions ps LEFT JOIN jobs pj ON pj.id=ps.pending_job_id ORDER BY ps.rowid DESC LIMIT 100")
                .fetch_all(&app.db)
                .await?;
            Ok(json!(rows.iter().map(|r|json!({"session_id":r.get::<String,_>("id"),"version_id":r.get::<String,_>("version_id"),"snapshot_id":r.get::<String,_>("snapshot_id"),"status":r.get::<String,_>("status"),"last_job_id":r.get::<Option<String>,_>("last_job_id"),"pending_job_id":r.get::<Option<String>,_>("pending_job_id"),"pending_job_status":r.get::<Option<String>,_>("pending_job_status"),"name":r.get::<Option<String>,_>("name"),"subscription_id":r.get::<Option<String>,_>("subscription_id"),"stream_cursor":r.get::<i64,_>("stream_cursor"),"error":r.get::<Option<String>,_>("error").or(r.get::<Option<String>,_>("pending_job_error"))})).collect::<Vec<_>>()))
        }
        "paper.discard" => {
            let id = required(p, "session_id")?;
            let mut tx = app.db.begin().await?;
            let pending: Option<String> =
                sqlx::query_scalar("SELECT pending_job_id FROM paper_sessions WHERE id=?")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            if let Some(job) = pending {
                let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id=?")
                    .bind(&job)
                    .fetch_one(&mut *tx)
                    .await?;
                anyhow::ensure!(
                    !["queued", "running"].contains(&status.as_str()),
                    "Cancel/wait for pending computation before discard"
                );
                sqlx::query("UPDATE paper_sessions SET pending_job_id=NULL WHERE id=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE paper_sessions SET status='paused',error='Bound source event discarded; deploy a fresh verified snapshot before resuming' WHERE id=? AND subscription_id IS NOT NULL AND status!='stopped'").bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(json!({"discarded":true}))
        }
        "paper.retry" => {
            let id = required(p, "session_id")?;
            let state: String = sqlx::query_scalar("SELECT status FROM paper_sessions WHERE id=?")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
            anyhow::ensure!(
                state != "stopped",
                "Stopped session cannot retry; deploy a new session"
            );
            let job: String =
                sqlx::query_scalar("SELECT pending_job_id FROM paper_sessions WHERE id=?")
                    .bind(id)
                    .fetch_one(&app.db)
                    .await?;
            let n=sqlx::query("UPDATE jobs SET status='queued',cancel_requested=0,error=NULL,result=NULL WHERE id=? AND status IN ('failed','interrupted','timed_out','cancelled')").bind(&job).execute(&app.db).await?.rows_affected();
            anyhow::ensure!(n == 1, "Pending job cannot be retried in current state");
            Ok(json!({"job_id":job,"status":"queued"}))
        }
        "paper.pause" | "paper.resume" | "paper.stop" => {
            let id = required(p, "session_id")?;
            let current: String =
                sqlx::query_scalar("SELECT status FROM paper_sessions WHERE id=?")
                    .bind(id)
                    .fetch_one(&app.db)
                    .await?;
            if current == "stopped" && method == "paper.stop" {
                return Ok(json!({"status":"stopped","duplicate":true}));
            }
            anyhow::ensure!(
                current != "stopped",
                "Stopped sessions cannot resume; deploy a new session"
            );
            if method == "paper.resume" {
                let error: Option<String> =
                    sqlx::query_scalar("SELECT error FROM paper_sessions WHERE id=?")
                        .bind(id)
                        .fetch_one(&app.db)
                        .await?;
                anyhow::ensure!(
                    error.is_none(),
                    "Frozen session requires a fresh verified deployment: {}",
                    error.unwrap_or_default()
                );
            }
            let status = if method == "paper.stop" {
                "stopped"
            } else if method == "paper.pause" {
                "paused"
            } else {
                "active"
            };
            let mut tx = app.db.begin().await?;
            let changed =
                sqlx::query("UPDATE paper_sessions SET status=? WHERE id=? AND status!='stopped'")
                    .bind(status)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
            anyhow::ensure!(changed == 1, "Session already stopped");
            if method == "paper.stop" {
                sqlx::query("UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,error=CASE WHEN status='queued' THEN 'Session stopped' ELSE error END WHERE id=(SELECT pending_job_id FROM paper_sessions WHERE id=?) AND status IN ('queued','running')").bind(id).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            Ok(json!({"status":status}))
        }
        "paper.append" => {
            let id = required(p, "session_id")?;
            let event_id = required(p, "event_id")?;
            let fingerprint = hash(&p["bars"].to_string());
            let mut tx = app.db.begin().await?;
            if let Some(r) =
                sqlx::query("SELECT * FROM paper_events WHERE session_id=? AND event_id=?")
                    .bind(id)
                    .bind(event_id)
                    .fetch_optional(&mut *tx)
                    .await?
            {
                anyhow::ensure!(
                    r.get::<String, _>("fingerprint") == fingerprint,
                    "Event ID conflict"
                );
                return Ok(
                    json!({"job_id":r.get::<String,_>("job_id"),"snapshot_id":r.get::<String,_>("snapshot_id"),"duplicate":true}),
                );
            }
            let session=sqlx::query("SELECT ps.*,s.payload FROM paper_sessions ps JOIN snapshots s ON s.id=ps.snapshot_id WHERE ps.id=?").bind(id).fetch_one(&mut *tx).await?;
            anyhow::ensure!(
                session.get::<String, _>("status") == "active",
                "Session is paused"
            );
            anyhow::ensure!(
                session.get::<Option<String>, _>("pending_job_id").is_none(),
                "Session has pending event; wait, retry or discard it"
            );
            if let Some(previous) = session.get::<Option<String>, _>("last_job_id") {
                let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id=?")
                    .bind(previous)
                    .fetch_one(&mut *tx)
                    .await?;
                anyhow::ensure!(
                    status == "succeeded",
                    "Previous event must finish successfully; inspect/retry interrupted or failed job before advancing"
                );
            }
            let mut data: Value = serde_json::from_str(&session.get::<String, _>("payload"))?;
            let symbols = p["bars"]
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("bars must map symbol to one closed OHLCV bar"))?;
            let symbol = data["symbol"].as_str().unwrap().to_string();
            let bar = symbols
                .get(&symbol)
                .ok_or_else(|| anyhow::anyhow!("Missing primary bar"))?
                .clone();
            let time = bar["time"].as_f64();
            data["bars"].as_array_mut().unwrap().push(bar);
            if let Some(datasets) = data.get_mut("datasets").and_then(Value::as_array_mut) {
                for d in datasets {
                    let sym = d["symbol"].as_str().unwrap();
                    let bar = symbols
                        .get(sym)
                        .ok_or_else(|| anyhow::anyhow!("Missing appended bar for {sym}"))?
                        .clone();
                    anyhow::ensure!(
                        bar["time"].as_f64() == time,
                        "Append requires aligned event timestamps"
                    );
                    d["bars"].as_array_mut().unwrap().push(bar);
                }
            }
            validate_data(&data)?;
            if let Some(datasets) = data["datasets"].as_array() {
                for d in datasets {
                    let mut validate = d.clone();
                    validate["timeframe"] = data["timeframe"].clone();
                    validate_data(&validate)?;
                }
            }
            let payload = data.to_string();
            let digest = hash(&payload);
            let snapshot = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO snapshots VALUES(?,?,?,CURRENT_TIMESTAMP)")
                .bind(&snapshot)
                .bind(payload)
                .bind(&digest)
                .execute(&mut *tx)
                .await?;
            let version: String = session.get("version_id");
            let kind: String = sqlx::query_scalar("SELECT kind FROM strategy_versions WHERE id=?")
                .bind(&version)
                .fetch_one(&mut *tx)
                .await?;
            let adapter = crate::commands::adapter_hash(app, &kind)?;
            let strategy_hash: String =
                sqlx::query_scalar("SELECT hash FROM strategy_versions WHERE id=?")
                    .bind(&version)
                    .fetch_one(&mut *tx)
                    .await?;
            let inputs: Value = serde_json::from_str(&session.get::<String, _>("inputs"))?;
            let job = uuid::Uuid::new_v4().to_string();
            let lock: Option<String> =
                sqlx::query_scalar("SELECT library_lock FROM strategy_versions WHERE id=?")
                    .bind(&version)
                    .fetch_one(&mut *tx)
                    .await?;
            let manifest = json!({"version_id":version,"strategy_hash":strategy_hash,"snapshot_id":snapshot,"snapshot_hash":digest,"inputs":inputs,"paper_session":id,"event_id":event_id,"previous_job_id":session.get::<Option<String>,_>("last_job_id"),"execution":"closed_bar_native","engine":"pinets@0.11.1 / composer-v1","adapter_hash":adapter,"continuous":true,"library_lock":crate::commands::lock_summary(lock.as_deref())?});
            sqlx::query("INSERT INTO jobs(id,version_id,snapshot_id,manifest,status) VALUES(?,?,?,?,'queued')").bind(&job).bind(version).bind(&snapshot).bind(manifest.to_string()).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO paper_events VALUES(?,?,?,?,?)")
                .bind(id)
                .bind(event_id)
                .bind(fingerprint)
                .bind(&job)
                .bind(&snapshot)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE paper_sessions SET pending_job_id=? WHERE id=?")
                .bind(&job)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO events(job_id,kind,payload) VALUES(?,'market_append',?)")
                .bind(&job)
                .bind(manifest.to_string())
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(json!({"job_id":job,"snapshot_id":snapshot,"duplicate":false}))
        }
        _ => anyhow::bail!("Unknown paper command"),
    }
}
