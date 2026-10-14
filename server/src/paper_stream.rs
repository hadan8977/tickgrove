//! Durable market-to-strategy delivery. Native Pine/Composer ledgers remain authoritative.
use crate::{App, commands::required};
use serde_json::{Value, json};
use sqlx::Row;
fn same_bar(a: &Value, b: &Value) -> bool {
    match (
        serde_json::from_value::<crate::market::Bar>(a.clone()),
        serde_json::from_value::<crate::market::Bar>(b.clone()),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}
pub async fn bindings(
    app: &App,
    data: &Value,
    primary: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut series = vec![data];
    if let Some(extra) = data["datasets"].as_array() {
        series.extend(extra)
    }
    let mut result = Vec::new();
    for (index, d) in series.iter().enumerate() {
        let baseline_times: Vec<i64> = data["bars"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["time"].as_i64().unwrap_or(-1))
            .collect();
        let series_times: Vec<i64> = d["bars"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["time"].as_i64().unwrap_or(-2))
            .collect();
        anyhow::ensure!(
            baseline_times == series_times,
            "Continuous bound datasets must have aligned historical timestamps"
        );
        let identity = &d["metadata"]["identity"];
        let provider = required(identity, "provider")?;
        let symbol = required(identity, "symbol")?;
        let tf = required(identity, "timeframe")?;
        anyhow::ensure!(
            d["symbol"] == symbol && d["timeframe"] == tf,
            "Snapshot series identity mismatch"
        );
        anyhow::ensure!(
            d["metadata"]["provenance"]["gaps"]
                .as_array()
                .is_none_or(|g| g.is_empty()),
            "Gapped series cannot bind continuous strategy"
        );
        let id = if index == 0 {
            primary.to_string()
        } else {
            let feed = if provider == "yahoo" {
                "public-pricing-websocket"
            } else if provider == "coinbase" {
                "public-websocket"
            } else {
                required(identity, "feed")?
            };
            let mut request =
                json!({"provider":provider,"symbol":symbol,"timeframe":tf,"feed":feed});
            if provider == "yahoo" {
                request["session"] = identity["session"].clone();
            }
            crate::market::execute(app, "market.subscribe", &request).await?["subscription_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing subscription id"))?
                .to_string()
        };
        let row = sqlx::query("SELECT identity,desired FROM market_subscriptions WHERE id=?")
            .bind(&id)
            .fetch_one(&app.db)
            .await?;
        anyhow::ensure!(row.get::<i64, _>("desired") == 1, "Subscription is stopped");
        let target: Value = serde_json::from_str(&row.get::<String, _>("identity"))?;
        for key in [
            "provider", "symbol", "venue", "currency", "session", "timezone",
        ] {
            anyhow::ensure!(
                identity[key] == target[key],
                "Subscription identity mismatch: {key}"
            );
        }
        anyhow::ensure!(
            crate::market::seconds(tf)? == crate::market::seconds(required(&target, "timeframe")?)?,
            "Subscription timeframe mismatch"
        );
        if provider == "alpaca" {
            anyhow::ensure!(identity["feed"] == target["feed"], "Alpaca feed mismatch");
        }
        result.push((id, symbol.to_string()));
    }
    Ok(result)
}
pub async fn run(app: App) {
    loop {
        if let Err(e) = tick(&app).await {
            eprintln!("paper market coordinator: {e}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
async fn freeze(app: &App, id: &str, error: &str) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "UPDATE paper_sessions SET status='paused',error=? WHERE id=? AND status!='stopped'",
    )
    .bind(error)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE jobs SET cancel_requested=1 WHERE id=(SELECT pending_job_id FROM paper_sessions WHERE id=?) AND status IN ('queued','running')").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn tick(app: &App) -> anyhow::Result<()> {
    let sessions=sqlx::query("SELECT ps.id,ps.stream_cursor,ps.pending_job_id,ps.snapshot_id,pj.snapshot_id AS pending_snapshot_id FROM paper_sessions ps LEFT JOIN jobs pj ON pj.id=ps.pending_job_id WHERE ps.subscription_id IS NOT NULL AND ps.status='active' ORDER BY ps.rowid LIMIT 128").fetch_all(&app.db).await?;
    for session in sessions {
        let id: String = session.get("id");
        let cursor: i64 = session.get("stream_cursor");
        let data: Value = serde_json::from_str(
            &sqlx::query_scalar::<_, String>("SELECT payload FROM snapshots WHERE id=?")
                .bind(session.get::<String, _>("snapshot_id"))
                .fetch_one(&app.db)
                .await?,
        )?;
        let approved: Option<Value> =
            if let Some(snapshot) = session.get::<Option<String>, _>("pending_snapshot_id") {
                Some(serde_json::from_str(
                    &sqlx::query_scalar::<_, String>("SELECT payload FROM snapshots WHERE id=?")
                        .bind(snapshot)
                        .fetch_one(&app.db)
                        .await?,
                )?)
            } else {
                None
            };
        let floor:i64=sqlx::query_scalar("SELECT COALESCE(MAX(s.pruned_cursor),0) FROM paper_bindings b JOIN market_subscriptions s ON s.id=b.subscription_id WHERE b.session_id=?").bind(&id).fetch_one(&app.db).await?;
        if cursor > 0 && cursor < floor {
            freeze(app,&id,"Market cursor expired; source continuity unverified. Deploy a fresh verified snapshot.").await?;
            continue;
        }
        let events=sqlx::query("SELECT e.*,b.symbol FROM market_events e JOIN paper_bindings b ON b.subscription_id=e.subscription_id WHERE b.session_id=? AND e.cursor>? ORDER BY e.cursor LIMIT 200").bind(&id).bind(cursor).fetch_all(&app.db).await?;
        let mut failed = false;
        for e in events {
            let kind: String = e.get("type");
            let next: i64 = e.get("cursor");
            if ["bar.closed", "bar.revised"].contains(&kind.as_str()) {
                let payload: Value = serde_json::from_str(&e.get::<String, _>("payload"))?;
                let quality: Value = serde_json::from_str(&e.get::<String, _>("quality"))?;
                let bar = if kind == "bar.revised" {
                    &payload["bar"]
                } else {
                    &payload
                };
                if quality["complete"] == true {
                    let symbol: String = e.get("symbol");
                    let time = bar["time"]
                        .as_i64()
                        .ok_or_else(|| anyhow::anyhow!("Missing closed bar time"))?;
                    let series = if data["symbol"] == symbol {
                        Some(&data)
                    } else {
                        data["datasets"]
                            .as_array()
                            .and_then(|all| all.iter().find(|d| d["symbol"] == symbol))
                    };
                    let Some(series) = series else {
                        freeze(
                            app,
                            &id,
                            "Bound market symbol missing from committed snapshot",
                        )
                        .await?;
                        failed = true;
                        break;
                    };
                    let history = series["bars"].as_array().unwrap();
                    let last = history.last().unwrap()["time"].as_i64().unwrap();
                    if let Some(approved) = &approved {
                        let accepted_series = if approved["symbol"] == symbol {
                            Some(approved)
                        } else {
                            approved["datasets"]
                                .as_array()
                                .and_then(|all| all.iter().find(|d| d["symbol"] == symbol))
                        };
                        if accepted_series
                            .and_then(|d| d["bars"].as_array())
                            .and_then(|all| all.iter().find(|b| b["time"] == time))
                            .is_some_and(|old| !same_bar(old, bar))
                        {
                            freeze(app,&id,"Source revised an accepted pending strategy bar; job cancelled, deploy verified snapshot").await?;
                            failed = true;
                            break;
                        }
                    }
                    if time <= last {
                        if let Some(old) = history.iter().find(|b| b["time"] == time) {
                            if !same_bar(old, bar) {
                                freeze(app,&id,&format!("Source revised committed {symbol} bar {time}; native ledger frozen, deploy fresh snapshot")).await?;
                                failed = true;
                                break;
                            }
                        }
                    } else {
                        let mut tx = app.db.begin().await?;
                        sqlx::query("INSERT INTO paper_market_pending VALUES(?,?,?,?,?) ON CONFLICT(session_id,symbol,time) DO UPDATE SET payload=excluded.payload,cursor=excluded.cursor").bind(&id).bind(symbol).bind(time).bind(bar.to_string()).bind(next).execute(&mut *tx).await?;
                        sqlx::query("UPDATE paper_sessions SET stream_cursor=? WHERE id=?")
                            .bind(next)
                            .bind(&id)
                            .execute(&mut *tx)
                            .await?;
                        tx.commit().await?;
                        continue;
                    }
                }
            }
            sqlx::query("UPDATE paper_sessions SET stream_cursor=? WHERE id=?")
                .bind(next)
                .bind(&id)
                .execute(&app.db)
                .await?;
        }
        if failed || session.get::<Option<String>, _>("pending_job_id").is_some() {
            continue;
        }
        let committed_time = data["bars"].as_array().unwrap().last().unwrap()["time"]
            .as_i64()
            .unwrap();
        sqlx::query("DELETE FROM paper_market_pending WHERE session_id=? AND time<=?")
            .bind(&id)
            .bind(committed_time)
            .execute(&app.db)
            .await?;
        let pending=sqlx::query("SELECT symbol,time,payload,cursor FROM paper_market_pending WHERE session_id=? ORDER BY time,symbol LIMIT 2048").bind(&id).fetch_all(&app.db).await?;
        if pending.is_empty() {
            continue;
        }
        let symbols: Vec<String> = sqlx::query_scalar(
            "SELECT symbol FROM paper_bindings WHERE session_id=? ORDER BY symbol",
        )
        .bind(&id)
        .fetch_all(&app.db)
        .await?;
        let time: i64 = pending[0].get("time");
        let last_bar = data["bars"].as_array().unwrap().last().unwrap();
        let expected = crate::market::period::next(
            &data["metadata"]["identity"],
            last_bar["closeTime"].as_i64().unwrap(),
        )?
        .ok_or_else(|| anyhow::anyhow!("No next market period in calendar"))?
        .0;
        if time != expected {
            if data["metadata"]["identity"]["provider"] == "coinbase"
                && expected
                    + crate::market::seconds(data["timeframe"].as_str().unwrap())?
                    + crate::market::confirmation_seconds()
                    + 60
                    > crate::market::now() / 1000
            {
                continue;
            }
            freeze(app,&id,&format!("Missing complete market period: expected {expected}, received {time}; no synthesized bars")).await?;
            continue;
        }
        let mut bars = serde_json::Map::new();
        let mut cursors = Vec::new();
        for r in pending.iter().filter(|r| r.get::<i64, _>("time") == time) {
            bars.insert(
                r.get("symbol"),
                serde_json::from_str(&r.get::<String, _>("payload"))?,
            );
            cursors.push(r.get::<i64, _>("cursor"));
        }
        if symbols.iter().any(|s| !bars.contains_key(s)) {
            continue;
        }
        let event_id = format!("market:{time}:{}", cursors.iter().max().unwrap());
        let params = json!({"session_id":id,"event_id":event_id,"bars":bars});
        match crate::paper::execute(app, "paper.append", &params).await {
            Ok(_) => {
                sqlx::query("DELETE FROM paper_market_pending WHERE session_id=? AND time=?")
                    .bind(&id)
                    .bind(time)
                    .execute(&app.db)
                    .await?;
            }
            Err(e) => {
                freeze(app, &id, &format!("Market append rejected: {e}")).await?;
            }
        }
    }
    Ok(())
}
