//! Bounded, rebuildable history cache; immutable strategy snapshots remain separate.
use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
};
use tokio::sync::{Mutex, OwnedMutexGuard};
static LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub async fn lock(app: &App, key: &str) -> OwnedMutexGuard<()> {
    let scope = format!("{:p}:{key}", Arc::as_ptr(&app.db.connect_options()));
    let slot = {
        let mut slots = LOCKS.lock().await;
        if slots.len() > 512 {
            slots.retain(|_, v| Arc::strong_count(v) > 1);
        }
        slots
            .entry(scope)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    slot.lock_owned().await
}
pub fn max_bytes() -> i64 {
    retention(
        "TRADING_HISTORY_CACHE_BYTES",
        64 * 1024 * 1024,
        1024 * 1024,
        1024 * 1024 * 1024,
    )
}
pub async fn get(app: &App, key: &str) -> anyhow::Result<Option<Value>> {
    let row = sqlx::query(
        "SELECT payload,expires_at FROM market_history_cache WHERE cache_key=? AND expires_at>?",
    )
    .bind(key)
    .bind(now())
    .fetch_optional(&app.db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    sqlx::query("UPDATE market_history_cache SET last_accessed=? WHERE cache_key=?")
        .bind(now())
        .bind(key)
        .execute(&app.db)
        .await?;
    let mut value: Value = serde_json::from_str(&row.get::<String, _>("payload"))?;
    value["cache"] = json!({"hit":true,"expiresAt":row.get::<i64,_>("expires_at"),"policy":"bounded persistent history cache"});
    Ok(Some(value))
}
pub async fn put(app: &App, key: &str, p: &Value, value: &mut Value) -> anyhow::Result<()> {
    let end = p["end"].as_i64().unwrap_or(now() / 1000);
    let ttl = if end < now() / 1000 - 7 * 86400 {
        86400
    } else {
        30
    };
    let expires = now() + ttl * 1000;
    let payload = value.to_string();
    let bytes = payload.len() as i64;
    value["cache"] =
        json!({"hit":false,"expiresAt":expires,"policy":"bounded persistent history cache"});
    if bytes > max_bytes() {
        return Ok(());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("DELETE FROM market_history_cache WHERE expires_at<=?")
        .bind(now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO market_history_cache(cache_key,provider,symbol,payload,bytes,created_at,last_accessed,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,last_accessed=excluded.last_accessed,expires_at=excluded.expires_at")
        .bind(key).bind(p["provider"].as_str().unwrap_or("")).bind(p["symbol"].as_str().unwrap_or(""))
        .bind(payload).bind(bytes).bind(now()).bind(now()).bind(expires).execute(&mut *tx).await?;
    let mut total: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(bytes),0) FROM market_history_cache")
            .fetch_one(&mut *tx)
            .await?;
    if total > max_bytes() {
        let rows = sqlx::query(
            "SELECT cache_key,bytes FROM market_history_cache ORDER BY last_accessed,cache_key",
        )
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            if total <= max_bytes() {
                break;
            }
            sqlx::query("DELETE FROM market_history_cache WHERE cache_key=?")
                .bind(row.get::<String, _>("cache_key"))
                .execute(&mut *tx)
                .await?;
            total -= row.get::<i64, _>("bytes");
        }
    }
    tx.commit().await?;
    Ok(())
}
pub async fn info(app: &App) -> anyhow::Result<Value> {
    let r=sqlx::query("SELECT COUNT(*) AS entries,COALESCE(SUM(bytes),0) AS bytes,MIN(created_at) AS oldest,MAX(last_accessed) AS latest FROM market_history_cache").fetch_one(&app.db).await?;
    Ok(
        json!({"entries":r.get::<i64,_>("entries"),"bytes":r.get::<i64,_>("bytes"),"maxBytes":max_bytes(),"oldest":r.get::<Option<i64>,_>("oldest"),"latest":r.get::<Option<i64>,_>("latest"),"rebuildable":true,"preservesSnapshots":true,"recentTtlSeconds":30,"archiveTtlSeconds":86400}),
    )
}
pub async fn clear(app: &App) -> anyhow::Result<Value> {
    let n = sqlx::query("DELETE FROM market_history_cache")
        .execute(&app.db)
        .await?
        .rows_affected();
    Ok(json!({"cleared":n,"preserved":"strategy snapshots, execution journals and workspaces"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cache_hit_expiry_and_clear_preserve_snapshot() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "isolated-cache-test".into(),
            root: "..".into(),
            node: "/usr/bin/node".into(),
            execution_budget: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES('pinned','{}','immutable')")
            .execute(&app.db)
            .await?;
        let p = json!({"provider":"yahoo","symbol":"SPY","end":now()/1000});
        let mut value = json!({"snapshot_id":null,"data":{"bars":[{"time":1}]}});
        put(&app, "key", &p, &mut value).await?;
        assert_eq!(value["cache"]["hit"], false);
        let hit = get(&app, "key").await?.unwrap();
        assert_eq!(hit["cache"]["hit"], true);
        assert_eq!(hit["data"], value["data"]);
        sqlx::query("UPDATE market_history_cache SET expires_at=0 WHERE cache_key='key'")
            .execute(&app.db)
            .await?;
        assert!(get(&app, "key").await?.is_none());
        clear(&app).await?;
        assert_eq!(info(&app).await?["entries"], 0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM snapshots")
                .fetch_one(&app.db)
                .await?,
            1
        );
        Ok(())
    }
}
