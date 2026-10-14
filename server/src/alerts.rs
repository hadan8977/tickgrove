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
            crate::market::execute(
                app,
                "market.subscribe",
                &json!({"provider":provider,"symbol":symbol,"timeframe":timeframe,"feed":p["feed"],"session":p["session"]}),
            )
            .await?;
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO alerts(id,provider,symbol,params,status,created_at) VALUES(?,?,?,?,'active',?)").bind(&id).bind(provider).bind(symbol).bind(p.to_string()).bind(market::now()).execute(&app.db).await?;
            Ok(json!({"id":id,"status":"active"}))
        }
        "alerts.list" => {
            let rows = sqlx::query("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 1000")
                .fetch_all(&app.db)
                .await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"status":r.get::<String,_>("status"),"params":serde_json::from_str::<Value>(&r.get::<String,_>("params")).unwrap(),"createdAt":r.get::<i64,_>("created_at")})).collect::<Vec<_>>()))
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
            let n=sqlx::query("UPDATE alerts SET status=? WHERE id=? AND status NOT IN ('deleted','expired','triggered')").bind(status).bind(required(p,"id")?).execute(&app.db).await?.rows_affected();
            Ok(json!({"updated":n>0,"status":status}))
        }
        "alerts.strategyHistory" => {
            let rows = sqlx::query(
                "SELECT * FROM pine_alert_history ORDER BY received_at DESC LIMIT 1000",
            )
            .fetch_all(&app.db)
            .await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"session_id":r.get::<String,_>("session_id"),"job_id":r.get::<String,_>("job_id"),"eventTime":r.get::<i64,_>("event_time"),"receivedAt":r.get::<i64,_>("received_at"),"alert":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap_or(Value::Null)})).collect::<Vec<_>>()))
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
pub async fn on_quote(
    app: &App,
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
    let mut tx = app.db.begin().await?;
    let rows =
        sqlx::query("SELECT * FROM alerts WHERE provider=? AND symbol=? AND status='active'")
            .bind(provider)
            .bind(symbol)
            .fetch_all(&mut *tx)
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
                .execute(&mut *tx)
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
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE alerts SET last_bar=?,status=? WHERE id=?")
                .bind(bucket)
                .bind(if p["frequency"] == "once" {
                    "triggered"
                } else {
                    "active"
                })
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE alerts SET previous_price=?,last_event_time=? WHERE id=?")
            .bind(price)
            .bind(time)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
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
}
