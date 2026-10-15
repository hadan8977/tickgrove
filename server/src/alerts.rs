use crate::{App, commands::required, market};
use serde_json::{Value, json};
use sqlx::Row;
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "alerts.create" => {
            let provider = required(p, "provider")?;
            let symbol = required(p, "symbol")?;
            let timeframe = p["timeframe"].as_str().unwrap_or("1m");
            market::identity(provider, symbol, timeframe, "alert", "none")?;
            anyhow::ensure!(
                ["above", "below", "cross"].contains(&required(p, "kind")?),
                "Unsupported alert kind"
            );
            anyhow::ensure!(
                ["once", "once_per_bar"].contains(&required(p, "frequency")?),
                "Unsupported frequency"
            );
            anyhow::ensure!(
                p["price"].as_f64().is_some_and(|n| n.is_finite() && n > 0.),
                "Positive finite alert price required"
            );
            if !p["expiresAt"].is_null() {
                anyhow::ensure!(
                    p["expiresAt"].as_i64().is_some_and(|t| t > market::now()),
                    "expiresAt must be future Unix milliseconds"
                );
            }
            let subscription = crate::market::execute(
                app,
                "market.subscribe",
                &json!({"provider":provider,"symbol":symbol,"timeframe":timeframe,"feed":p["feed"],"session":p["session"]}),
            )
            .await?;
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO alerts(id,provider,symbol,params,status,created_at,subscription_id,source_cursor) VALUES(?,?,?,?,'active',?,?,(SELECT COALESCE(MAX(cursor),0) FROM market_events))").bind(&id).bind(provider).bind(symbol).bind(p.to_string()).bind(market::now()).bind(required(&subscription,"subscription_id")?).execute(&app.db).await?;
            Ok(json!({"id":id,"status":"active"}))
        }
        "alerts.list" => {
            let rows = sqlx::query("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 1000")
                .fetch_all(&app.db)
                .await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"status":r.get::<String,_>("status"),"params":serde_json::from_str::<Value>(&r.get::<String,_>("params")).unwrap(),"createdAt":r.get::<i64,_>("created_at"),"sourceCursor":r.get::<i64,_>("source_cursor"),"error":r.get::<Option<String>,_>("error")})).collect::<Vec<_>>()))
        }
        "alerts.delete" => {
            let n = sqlx::query("UPDATE alerts SET status='deleted' WHERE id=?")
                .bind(required(p, "id")?)
                .execute(&app.db)
                .await?
                .rows_affected();
            Ok(json!({"deleted":n>0}))
        }
        "alerts.pause" => {
            let status = if p["paused"].as_bool().unwrap_or(true) {
                "paused"
            } else {
                "active"
            };
            let id = required(p, "id")?;
            let subscription = if status == "active" {
                let row=sqlx::query("SELECT params FROM alerts WHERE id=? AND status NOT IN ('deleted','expired','triggered')").bind(id).fetch_optional(&app.db).await?;
                let Some(row) = row else {
                    return Ok(json!({"updated":false,"status":status}));
                };
                let params: Value = serde_json::from_str(&row.get::<String, _>("params"))?;
                let source = crate::market::execute(app, "market.subscribe", &params).await?;
                Some(required(&source, "subscription_id")?.to_string())
            } else {
                None
            };
            let n=sqlx::query("UPDATE alerts SET status=?,subscription_id=COALESCE(?,subscription_id),source_cursor=(SELECT COALESCE(MAX(cursor),0) FROM market_events),previous_price=NULL,last_event_time=NULL,error=NULL WHERE id=? AND status NOT IN ('deleted','expired','triggered')").bind(status).bind(subscription).bind(id).execute(&app.db).await?.rows_affected();
            Ok(json!({"updated":n>0,"status":status}))
        }
        "alerts.strategyHistory" => {
            let rows = sqlx::query(
                "SELECT * FROM pine_alert_history ORDER BY received_at DESC LIMIT 1000",
            )
            .fetch_all(&app.db)
            .await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"session_id":r.get::<String,_>("session_id"),"job_id":r.get::<String,_>("job_id"),"eventTime":r.get::<i64,_>("event_time"),"receivedAt":r.get::<i64,_>("received_at"),"alert":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap_or(Value::Null),"context":r.get::<Option<String>,_>("context").and_then(|s|serde_json::from_str::<Value>(&s).ok())})).collect::<Vec<_>>()))
        }
        "alerts.history" => {
            let rows =
                sqlx::query("SELECT * FROM alert_history ORDER BY received_at DESC LIMIT 1000")
                    .fetch_all(&app.db)
                    .await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"alertId":r.get::<String,_>("alert_id"),"marketCursor":r.get::<i64,_>("market_cursor"),"price":r.get::<f64,_>("price"),"eventTime":r.get::<i64,_>("event_time"),"receivedAt":r.get::<i64,_>("received_at"),"message":r.get::<String,_>("message")})).collect::<Vec<_>>()))
        }
        _ => anyhow::bail!("Unknown alerts command"),
    }
}
#[cfg(test)]
async fn on_quote(
    app: &App,
    cursor: i64,
    provider: &str,
    symbol: &str,
    feed: &str,
    time: i64,
    received: i64,
    quote: &Value,
) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    on_quote_in_tx(
        &mut tx, None, cursor, provider, symbol, feed, time, received, quote,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
async fn on_quote_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    alert_id: Option<&str>,
    cursor: i64,
    provider: &str,
    symbol: &str,
    feed: &str,
    time: i64,
    received: i64,
    quote: &Value,
) -> anyhow::Result<()> {
    if received - time > 15000 || time > received + 5000 {
        return Ok(());
    }
    let Some(price) = crate::account::quote_mark(quote) else {
        return Ok(());
    };
    let rows =
        sqlx::query("SELECT * FROM alerts WHERE provider=? AND symbol=? AND status='active' AND (? IS NULL OR id=?) AND created_at<=?")
            .bind(provider)
            .bind(symbol)
            .bind(alert_id).bind(alert_id).bind(received)
            .fetch_all(&mut **tx)
            .await?;
    for r in rows {
        let id: String = r.get("id");
        let p: Value = serde_json::from_str(&r.get::<String, _>("params"))?;
        let expected_feed = p["feed"].as_str().unwrap_or(if provider == "coinbase" {
            "public-websocket"
        } else if provider == "alpaca" {
            "iex"
        } else {
            "public-pricing-websocket"
        });
        if expected_feed != feed {
            continue;
        }
        if p["expiresAt"].as_i64().is_some_and(|t| received >= t) {
            sqlx::query("UPDATE alerts SET status='expired' WHERE id=?")
                .bind(&id)
                .execute(&mut **tx)
                .await?;
            continue;
        }
        if r.get::<Option<i64>, _>("last_event_time")
            .is_some_and(|t| time < t)
        {
            continue;
        }
        let mut identity = market::identity(
            provider,
            symbol,
            p["timeframe"].as_str().unwrap_or("1m"),
            feed,
            "none",
        )?;
        if let Some(session) = p["session"].as_str() {
            identity["session"] = json!(session);
        }
        let Some((bucket, _)) = crate::market::period::bounds(&identity, time / 1000)? else {
            continue;
        };
        let target = p["price"].as_f64().unwrap();
        let previous: Option<f64> = r.get("previous_price");
        let hit = match p["kind"].as_str().unwrap() {
            "above" => price > target,
            "below" => price < target,
            _ => previous.is_some_and(|v| {
                (v < target && price >= target) || (v > target && price <= target)
            }),
        };
        let last: Option<i64> = r.get("last_bar");
        let allowed = p["frequency"] == "once" || last != Some(bucket);
        if hit && allowed {
            sqlx::query("INSERT OR IGNORE INTO alert_history VALUES(?,?,?,?,?,?,?)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(&id)
                .bind(cursor)
                .bind(price)
                .bind(time)
                .bind(received)
                .bind(format!("{} {} {} at {}", symbol, p["kind"], target, price))
                .execute(&mut **tx)
                .await?;
            sqlx::query("UPDATE alerts SET last_bar=?,status=? WHERE id=?")
                .bind(bucket)
                .bind(if p["frequency"] == "once" {
                    "triggered"
                } else {
                    "active"
                })
                .bind(&id)
                .execute(&mut **tx)
                .await?;
        }
        sqlx::query("UPDATE alerts SET previous_price=?,last_event_time=? WHERE id=?")
            .bind(price)
            .bind(time)
            .bind(&id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Replay durable source events, independently of websocket and browser lifetime.
pub async fn run(app: App) {
    loop {
        if let Err(error) = tick(&app).await {
            eprintln!("alert consumer: {error}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
async fn tick(app: &App) -> anyhow::Result<()> {
    let ids = sqlx::query_scalar::<_, String>(
        "SELECT id FROM alerts WHERE status='active' ORDER BY created_at LIMIT 1000",
    )
    .fetch_all(&app.db)
    .await?;
    for id in ids {
        if let Err(error) = consume(app, &id).await {
            // A transient storage failure must retry the same source cursor.
            // Marking it terminal would require resetting the observation window.
            if error.downcast_ref::<sqlx::Error>().is_some() {
                return Err(error);
            }
            sqlx::query("UPDATE alerts SET status='failed',error=? WHERE id=? AND status='active'")
                .bind(error.to_string())
                .bind(id)
                .execute(&app.db)
                .await?;
        }
    }
    Ok(())
}
async fn consume(app: &App, id: &str) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    let alert = sqlx::query("SELECT * FROM alerts WHERE id=? AND status='active'")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(alert) = alert else {
        return Ok(());
    };
    let params: Value = serde_json::from_str(&alert.get::<String, _>("params"))?;
    let provider: String = alert.get("provider");
    let symbol: String = alert.get("symbol");
    let feed = params["feed"].as_str().unwrap_or(match provider.as_str() {
        "coinbase" => "public-websocket",
        "alpaca" => "iex",
        _ => "public-pricing-websocket",
    });
    let subscription = match alert.get::<Option<String>,_>("subscription_id") {
        Some(value) => value,
        None => sqlx::query_scalar::<_,String>("SELECT id FROM market_subscriptions WHERE provider=? AND symbol=? AND timeframe=? AND json_extract(identity,'$.feed')=? AND desired=1 ORDER BY rowid DESC LIMIT 1")
            .bind(&provider).bind(&symbol).bind(params["timeframe"].as_str().unwrap_or("1m")).bind(feed).fetch_optional(&mut *tx).await?
            .ok_or_else(||anyhow::anyhow!("Alert source subscription is unavailable; reconnect and resume"))?,
    };
    let source = sqlx::query("SELECT desired,pruned_cursor FROM market_subscriptions WHERE id=?")
        .bind(&subscription)
        .fetch_one(&mut *tx)
        .await?;
    anyhow::ensure!(
        source.get::<i64, _>("desired") == 1,
        "Alert source subscription stopped; reconnect and resume"
    );
    let cursor: i64 = alert.get("source_cursor");
    anyhow::ensure!(
        cursor >= source.get::<i64, _>("pruned_cursor"),
        "Alert source cursor expired; trigger continuity unknown. Resume explicitly to start a new observation window"
    );
    let events = sqlx::query("SELECT * FROM market_events WHERE subscription_id=? AND cursor>? ORDER BY cursor LIMIT 200").bind(&subscription).bind(cursor).fetch_all(&mut *tx).await?;
    let mut next = cursor;
    for event in events {
        next = event.get("cursor");
        if event.get::<String, _>("type") != "quote" {
            continue;
        }
        let quality: Value = serde_json::from_str(&event.get::<String, _>("quality"))?;
        if quality["complete"] != true || quality["stale"] == true {
            continue;
        }
        let quote: Value = serde_json::from_str(&event.get::<String, _>("payload"))?;
        on_quote_in_tx(
            &mut tx,
            Some(id),
            next,
            &provider,
            &symbol,
            feed,
            event.get("event_time"),
            event.get("received_at"),
            &quote,
        )
        .await?;
    }
    sqlx::query("UPDATE alerts SET source_cursor=?,subscription_id=?,error=NULL WHERE id=?")
        .bind(next)
        .bind(subscription)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // Expiration is checked after catch-up: a trigger received before expiry is preserved.
    if params["expiresAt"]
        .as_i64()
        .is_some_and(|t| t <= market::now())
    {
        let pending: i64=sqlx::query_scalar("SELECT COUNT(*) FROM market_events WHERE subscription_id=(SELECT subscription_id FROM alerts WHERE id=?) AND cursor>?").bind(id).bind(next).fetch_one(&mut *tx).await?;
        if pending == 0 {
            sqlx::query("UPDATE alerts SET status='expired' WHERE id=? AND status='active'")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn crossing_deduplicates_and_lifecycle() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "test-only".into(),
            root: std::path::PathBuf::from(".."),
            node: std::path::PathBuf::from("/usr/bin/node"),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let p = json!({"kind":"cross","price":100.,"frequency":"once_per_bar","timeframe":"1m"});
        sqlx::query("INSERT INTO alerts(id,provider,symbol,params,status,created_at) VALUES('a','coinbase','LTC-USD',?,'active',0)").bind(p.to_string()).execute(&app.db).await?;
        let now = market::now();
        on_quote(
            &app,
            1,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &json!({"price":99}),
        )
        .await?;
        on_quote(
            &app,
            2,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &json!({"price":101}),
        )
        .await?;
        on_quote(
            &app,
            2,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &json!({"price":101}),
        )
        .await?;
        on_quote(
            &app,
            3,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &json!({"price":99}),
        )
        .await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alert_history")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(count, 1);
        execute(&app, "alerts.pause", &json!({"id":"a","paused":true})).await?;
        on_quote(
            &app,
            4,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now + 60000,
            now + 60000,
            &json!({"price":101}),
        )
        .await?;
        assert_eq!(
            execute(&app, "alerts.history", &json!({}))
                .await?
                .as_array()
                .unwrap()
                .len(),
            1
        );
        Ok(())
    }
    #[tokio::test]
    async fn durable_cursor_rolls_back_with_trigger_and_recovers() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "fixture-only".into(),
            root: "..".into(),
            node: "/usr/bin/node".into(),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status) VALUES('s','coinbase','TEST-USD','1m','{}','connected')").execute(&app.db).await?;
        sqlx::query("INSERT INTO alerts(id,provider,symbol,params,status,created_at,subscription_id) VALUES('a','coinbase','TEST-USD',?,'active',0,'s')").bind(json!({"kind":"cross","price":100,"frequency":"once","timeframe":"1m"}).to_string()).execute(&app.db).await?;
        let time = market::now() - 60000; // Catch-up uses receipt freshness, not today's wall time.
        for (cursor, price) in [(1, 99), (2, 101), (3, 99)] {
            sqlx::query("INSERT INTO market_events(cursor,subscription_id,type,event_time,received_at,payload,quality) VALUES(?,'s','quote',?,?,?,'{\"complete\":true,\"stale\":false}')").bind(cursor).bind(time+cursor).bind(time+cursor).bind(json!({"price":price}).to_string()).execute(&app.db).await?;
        }
        sqlx::query("CREATE TRIGGER test_alert_crash BEFORE INSERT ON alert_history BEGIN SELECT RAISE(ABORT,'fixture crash before trigger commit'); END").execute(&app.db).await?;
        assert!(consume(&app, "a").await.is_err());
        let cursor: i64 = sqlx::query_scalar("SELECT source_cursor FROM alerts WHERE id='a'")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(cursor, 0);
        let previous: Option<f64> =
            sqlx::query_scalar("SELECT previous_price FROM alerts WHERE id='a'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(previous, None);
        sqlx::query("DROP TRIGGER test_alert_crash")
            .execute(&app.db)
            .await?;
        consume(&app.clone(), "a").await?;
        consume(&app, "a").await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alert_history")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(count, 1);
        let cursor: i64 = sqlx::query_scalar("SELECT source_cursor FROM alerts WHERE id='a'")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(cursor, 3);
        let status: String = sqlx::query_scalar("SELECT status FROM alerts WHERE id='a'")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(status, "triggered");
        Ok(())
    }
    #[tokio::test]
    async fn expired_source_cursor_is_visible_failure_and_resume_resets_window()
    -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "fixture-only".into(),
            root: "..".into(),
            node: "/usr/bin/node".into(),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,pruned_cursor) VALUES('s','coinbase','TEST-USD','1m','{}','connected',10)").execute(&app.db).await?;
        sqlx::query("INSERT INTO alerts(id,provider,symbol,params,status,created_at,subscription_id) VALUES('a','coinbase','TEST-USD',?,'active',0,'s')").bind(json!({"provider":"coinbase","symbol":"TEST-USD","kind":"above","price":100,"frequency":"once","timeframe":"1m"}).to_string()).execute(&app.db).await?;
        tick(&app).await?;
        let status = execute(&app, "alerts.list", &json!({})).await?;
        assert_eq!(status[0]["status"], "failed");
        assert!(
            status[0]["error"]
                .as_str()
                .unwrap()
                .contains("cursor expired")
        );
        sqlx::query("UPDATE market_subscriptions SET desired=0 WHERE id='s'")
            .execute(&app.db)
            .await?;
        let identity = market::identity("coinbase", "TEST-USD", "1m", "public-websocket", "none")?;
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('fresh','coinbase','TEST-USD','1m',?,'connected','public-websocket')").bind(identity.to_string()).execute(&app.db).await?;
        assert_eq!(
            execute(&app, "alerts.pause", &json!({"id":"a","paused":false})).await?["updated"],
            true
        );
        tick(&app).await?;
        let rebound =
            sqlx::query("SELECT status,subscription_id,previous_price FROM alerts WHERE id='a'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(rebound.get::<String, _>("status"), "active");
        assert_eq!(rebound.get::<String, _>("subscription_id"), "fresh");
        assert_eq!(rebound.get::<Option<f64>, _>("previous_price"), None);
        Ok(())
    }
}
