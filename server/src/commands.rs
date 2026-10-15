use crate::App;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
pub fn adapter_hash(app: &App, kind: &str) -> anyhow::Result<String> {
    let paths: Vec<&str> = if kind == "composer" {
        vec!["scripts/service-worker.cjs", "src/composer/engine.ts"]
    } else {
        vec![
            "scripts/service-worker.cjs",
            "src/pine/runtime.ts",
            "src/pine/library.ts",
            "src/pine/compat.ts",
            "src/pine/data.ts",
            "src/pine/report.ts",
        ]
    };
    let mut digest = Sha256::new();
    for path in paths {
        digest.update(path.as_bytes());
        digest.update(std::fs::read(app.root.join(path))?);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub fn hash(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
pub fn required<'a>(v: &'a Value, k: &str) -> anyhow::Result<&'a str> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing {k}"))
}
pub fn lock_summary(text: Option<&str>) -> anyhow::Result<Value> {
    let lock: Value = match text {
        Some(text) => serde_json::from_str(text)?,
        None => return Ok(Value::Null),
    };
    Ok(
        json!({"lockHash":lock["lockHash"],"modules":lock["libraries"].as_array().into_iter().flatten().map(|m|json!({"reference":m["reference"],"hash":m["hash"]})).collect::<Vec<_>>()}),
    )
}
pub async fn execute(app: &App, body: Value) -> anyhow::Result<Value> {
    let method = required(&body, "method")?;
    let p = &body["params"];
    if method.starts_with("connections.") {
        return crate::connections::execute(app, method, p).await;
    }
    if method.starts_with("pine.host.") {
        return crate::pine_host::execute(app, method, p).await;
    }
    if method == "pine.inspectRequests" {
        return crate::pine_requests::inspect(app, p).await;
    }
    if method == "pine.prepareData" {
        return crate::pine_requests::prepare(app, p).await;
    }
    if method.starts_with("pine.") {
        return crate::pine_libraries::execute(app, method, p).await;
    }
    if method.starts_with("alerts.") {
        return crate::alerts::execute(app, method, p).await;
    }
    if method.starts_with("account.") {
        return crate::account::execute(app, method, p).await;
    }
    if method.starts_with("workspace.") {
        return crate::workspace::execute(app, method, p).await;
    }
    if method.starts_with("market.") {
        return crate::market::execute(app, method, p).await;
    }
    if method.starts_with("plugins.") {
        return crate::plugins::execute(app, method, p).await;
    }
    if method.starts_with("alpaca.") || method.starts_with("orders.") || method == "data.fetch" {
        return crate::alpaca::execute(app, method, p).await;
    }
    if method.starts_with("paper.") {
        return crate::paper::execute(app, method, p).await;
    }
    match method {
        "system.capabilities" => Ok(
            json!({"product":"Tickgrove","service":"tickgrove-server","protocol":"trading.commands.v1","engine":"PineTS 0.11.1","supportedScopes":["read","connections.manage","workspace.write","pine.library.write","broker.feedback","alerts.manage","strategy.write","data.write","backtest.run","paper.manage","broker.paper","plugins.manage"],"commands":["connections.list","connections.save","connections.test","connections.remove","market.historyPage","market.cacheInfo","market.cacheClear","pine.host.feedback","pine.host.deploy","pine.host.list","pine.host.status","pine.host.pause","pine.host.resume","pine.host.stop","pine.host.events","pine.host.render","pine.inspectRequests","pine.prepareData","pine.resolve","pine.library.createVersion","pine.library.get","pine.library.list","market.capabilities","market.search","market.products","market.quote","market.depth","market.history","market.bundle","market.subscribe","market.stop","market.list","market.status","market.events","market.bars","market.snapshot","workspace.get","workspace.save","account.state","account.placeOrder","account.modifyOrder","account.cancelOrder","account.flatten","account.reset","account.events","alerts.list","alerts.create","alerts.delete","alerts.pause","alerts.history","alerts.strategyHistory","strategy.createVersion","strategy.list","data.import","data.list","data.get","data.fetch","backtest.start","backtest.status","backtest.cancel","backtest.results","events.list","paper.deploy","paper.list","paper.append","paper.pause","paper.resume","paper.stop","paper.retry","paper.discard","alpaca.config","alpaca.account","orders.list","orders.status","orders.events","orders.preview","orders.submit","orders.reconcile","orders.cancel","plugins.list","plugins.validate","plugins.enable","plugins.disable","plugins.call"],"continuousPaper":"closed_bar_native","externalFills":{"closed_bar_native":false,"event_broker":true,"boundary":"Authorized persisted fill feedback; no connected external broker without dedicated adapter credentials; fill-triggered recalculation and OCA/brackets are not supported"}}),
        ),
        "strategy.createVersion" => {
            let name = required(p, "name")?;
            let source = required(p, "source")?;
            let kind = p["kind"].as_str().unwrap_or("pine");
            anyhow::ensure!(
                ["pine", "composer"].contains(&kind),
                "Unsupported strategy kind"
            );
            anyhow::ensure!(source.len() <= 500_000, "Source exceeds limit");
            let id = uuid::Uuid::new_v4().to_string();
            let digest = hash(source);
            let library_lock = if kind == "pine" {
                Some(crate::pine_libraries::resolve(app, source).await?)
            } else {
                None
            };
            sqlx::query(
                "INSERT INTO strategy_versions(id,name,kind,source,hash,library_lock) VALUES(?,?,?,?,?,?)",
            )
            .bind(&id)
            .bind(name)
            .bind(kind)
            .bind(source)
            .bind(&digest)
            .bind(library_lock.as_ref().map(Value::to_string))
            .execute(&app.db)
            .await?;
            Ok(json!({"id":id,"hash":digest,"name":name,"kind":kind}))
        }
        "strategy.list" => {
            let rows=sqlx::query("SELECT id,name,kind,source,hash,created_at FROM strategy_versions ORDER BY created_at DESC,rowid DESC LIMIT 100 OFFSET ?").bind(p["offset"].as_i64().unwrap_or(0).clamp(0,100000)).fetch_all(&app.db).await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"source":r.get::<String,_>("source"),"hash":r.get::<String,_>("hash")})).collect::<Vec<_>>()))
        }
        "data.import" => {
            let data = &p["data"];
            validate_data(data)?;
            let payload = serde_json::to_string(data)?;
            let digest = hash(&payload);
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES(?,?,?)")
                .bind(&id)
                .bind(payload)
                .bind(&digest)
                .execute(&app.db)
                .await?;
            Ok(json!({"id":id,"hash":digest,"bars":data["bars"].as_array().unwrap().len()}))
        }
        "data.get" => {
            let id = required(p, "snapshot_id")?;
            let data: String = sqlx::query_scalar("SELECT payload FROM snapshots WHERE id=?")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
            Ok(serde_json::from_str(&data)?)
        }
        "data.list" => {
            let rows=sqlx::query("SELECT id,hash,json_extract(payload,'$.symbol') AS symbol,json_extract(payload,'$.timeframe') AS timeframe,json_array_length(payload,'$.bars') AS bars FROM snapshots ORDER BY rowid DESC LIMIT 100 OFFSET ?").bind(p["offset"].as_i64().unwrap_or(0).clamp(0,100000)).fetch_all(&app.db).await?;
            Ok(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"hash":r.get::<String,_>("hash"),"symbol":r.get::<String,_>("symbol"),"timeframe":r.get::<String,_>("timeframe"),"bars":r.get::<i64,_>("bars")})).collect::<Vec<_>>()))
        }
        "backtest.start" => {
            let version = required(p, "version_id")?;
            required(p, "snapshot_id")?;
            anyhow::ensure!(
                p.get("inputs").is_none_or(|v| v.is_object()),
                "inputs must be an object"
            );
            let key = required(&body, "idempotency_key")?;
            let fingerprint = hash(&serde_json::to_string(p)?);
            if let Some(row) = sqlx::query("SELECT fingerprint,response FROM commands WHERE key=?")
                .bind(key)
                .fetch_optional(&app.db)
                .await?
            {
                anyhow::ensure!(
                    row.get::<String, _>("fingerprint") == fingerprint,
                    "Idempotency key reused with different parameters"
                );
                return Ok(serde_json::from_str(&row.get::<String, _>("response"))?);
            }
            let prepared = crate::pine_requests::prepare(app, p).await?;
            let snapshot = prepared["snapshot_id"].as_str().unwrap();
            let mut tx = app.db.begin().await?;
            if let Some(row) = sqlx::query("SELECT fingerprint,response FROM commands WHERE key=?")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
            {
                anyhow::ensure!(
                    row.get::<String, _>("fingerprint") == fingerprint,
                    "Idempotency key reused with different parameters"
                );
                return Ok(serde_json::from_str(&row.get::<String, _>("response"))?);
            }
            let v = sqlx::query("SELECT hash,kind,library_lock FROM strategy_versions WHERE id=?")
                .bind(version)
                .fetch_one(&mut *tx)
                .await?;
            let d = sqlx::query("SELECT hash,COALESCE(json_array_length(json_extract(payload,'$.metadata.provenance.gaps')),0) AS gap_count FROM snapshots WHERE id=?")
                .bind(snapshot)
                .fetch_one(&mut *tx)
                .await?;
            let id = uuid::Uuid::new_v4().to_string();
            anyhow::ensure!(
                d.get::<i64, _>("gap_count") == 0,
                "Snapshot has explicit data gaps; backtest requires complete data"
            );
            let manifest = json!({"version_id":version,"strategy_hash":v.get::<String,_>("hash"),"snapshot_id":snapshot,"snapshot_hash":d.get::<String,_>("hash"),"inputs":p["inputs"].as_object().cloned().unwrap_or_default(),"engine":if v.get::<String,_>("kind")=="composer" {"composer-v1"}else{"pinets@0.11.1"},"adapter_hash":adapter_hash(app,&v.get::<String,_>("kind"))?,"execution":if v.get::<String,_>("kind")=="composer" {"closed-bar-target-next-open"}else{"native-pine"},"timeout_seconds":30,"continuous":p["continuous"]==true,"library_lock":lock_summary(v.get::<Option<String>,_>("library_lock").as_deref())?});
            sqlx::query("INSERT INTO jobs(id,version_id,snapshot_id,manifest,status) VALUES(?,?,?,?,'queued')").bind(&id).bind(version).bind(snapshot).bind(manifest.to_string()).execute(&mut *tx).await?;
            let response = json!({"job_id":id,"status":"queued","manifest":manifest});
            sqlx::query("INSERT INTO commands VALUES(?,?,?)")
                .bind(key)
                .bind(fingerprint)
                .bind(response.to_string())
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO events(job_id,kind,payload) VALUES(?,'queued','{}')")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(response)
        }
        "backtest.status" | "backtest.results" => {
            if let Some(id) = p["job_id"].as_str() {
                let query = if method == "backtest.results" {
                    "SELECT * FROM jobs WHERE id=?"
                } else {
                    "SELECT id,status,manifest,error,NULL AS result FROM jobs WHERE id=?"
                };
                let r = sqlx::query(query).bind(id).fetch_one(&app.db).await?;
                Ok(job(&r, method == "backtest.results"))
            } else {
                let rows=sqlx::query("SELECT id,status,manifest,error,NULL AS result FROM jobs ORDER BY rowid DESC LIMIT 100").fetch_all(&app.db).await?;
                Ok(json!(
                    rows.iter().map(|r| job(r, false)).collect::<Vec<_>>()
                ))
            }
        }
        "backtest.cancel" => {
            let id = required(p, "job_id")?;
            let n = sqlx::query(
                "UPDATE jobs SET cancel_requested=1 WHERE id=? AND status IN ('queued','running')",
            )
            .bind(id)
            .execute(&app.db)
            .await?
            .rows_affected();
            Ok(json!({"requested":n==1}))
        }
        "events.list" => {
            let rows =
                sqlx::query("SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT 1000")
                    .bind(p["cursor"].as_i64().unwrap_or(0))
                    .fetch_all(&app.db)
                    .await?;
            Ok(json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("cursor"),"job_id":r.get::<String,_>("job_id"),"kind":r.get::<String,_>("kind"),"payload":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap_or(Value::Null)})).collect::<Vec<_>>()))
        }
        _ => anyhow::bail!("Unknown command {method}"),
    }
}
fn job(r: &sqlx::sqlite::SqliteRow, include_result: bool) -> Value {
    json!({"job_id":r.get::<String,_>("id"),"status":r.get::<String,_>("status"),"manifest":serde_json::from_str::<Value>(&r.get::<String,_>("manifest")).unwrap(),"result":if include_result {r.get::<Option<String>,_>("result").and_then(|s|serde_json::from_str::<Value>(&s).ok())} else {None},"error":r.get::<Option<String>,_>("error")})
}
pub fn validate_data(data: &Value) -> anyhow::Result<()> {
    validate_series(data)?;
    if let Some(extra) = data.get("datasets") {
        let datasets = extra
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("datasets must be array"))?;
        anyhow::ensure!(datasets.len() <= 32, "At most 32 supplemental datasets");
        let mut keys = std::collections::HashSet::new();
        keys.insert((required(data, "symbol")?, required(data, "timeframe")?));
        for dataset in datasets {
            anyhow::ensure!(
                dataset.get("datasets").is_none(),
                "Nested datasets unsupported"
            );
            validate_series(dataset)?;
            anyhow::ensure!(
                keys.insert((
                    required(dataset, "symbol")?,
                    required(dataset, "timeframe")?
                )),
                "Duplicate symbol/timeframe dataset"
            );
        }
    }
    Ok(())
}
fn validate_series(data: &Value) -> anyhow::Result<()> {
    let symbol = required(data, "symbol")?;
    anyhow::ensure!(symbol.len() <= 64, "Symbol exceeds limit");
    required(data, "timeframe")?;
    if let Some(metadata) = data.get("metadata") {
        anyhow::ensure!(metadata.is_object(), "metadata must be object");
        if let Some(zone) = metadata.get("timezone") {
            let zone = zone
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("timezone must be string"))?;
            anyhow::ensure!(
                !zone.starts_with('/') && !zone.contains(".."),
                "Invalid timezone"
            );
            let root = std::path::Path::new("/usr/share/zoneinfo");
            anyhow::ensure!(
                root.join(zone)
                    .canonicalize()
                    .is_ok_and(|p| p.starts_with(root)),
                "Unknown IANA timezone"
            );
        }
    }
    let bars = data["bars"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("bars must be array"))?;
    anyhow::ensure!(
        !bars.is_empty() && bars.len() <= 20_000,
        "Require 1..20000 bars"
    );
    let mut previous = f64::NEG_INFINITY;
    for b in bars {
        let time = b["time"]
            .as_f64()
            .ok_or_else(|| anyhow::anyhow!("Invalid bar time"))?;
        anyhow::ensure!(
            time.is_finite() && time.fract() == 0. && time > previous,
            "Times must be finite Unix seconds and strictly increase"
        );
        previous = time;
        for key in ["open", "high", "low", "close"] {
            anyhow::ensure!(
                b[key].as_f64().is_some_and(|n| n.is_finite() && n > 0.),
                "Invalid positive {key}"
            );
        }
        anyhow::ensure!(
            b["volume"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.),
            "Invalid volume"
        );
        if let Some(close) = b.get("closeTime") {
            anyhow::ensure!(
                close.as_f64().is_some_and(|n| n.is_finite() && n > time),
                "closeTime must follow time"
            );
        }
        let low = b["low"].as_f64().unwrap();
        let high = b["high"].as_f64().unwrap();
        anyhow::ensure!(
            low <= b["open"].as_f64().unwrap()
                && low <= b["close"].as_f64().unwrap()
                && high >= b["open"].as_f64().unwrap()
                && high >= b["close"].as_f64().unwrap(),
            "Invalid OHLC range"
        );
    }
    Ok(())
}
