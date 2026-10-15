//! Durable event host. The Node process computes Pine; Rust controls data and order permissions.
use crate::{
    App,
    commands::{hash, required},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashMap, sync::OnceLock};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Child,
};
struct Process {
    child: Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
    stderr: std::sync::Arc<tokio::sync::Mutex<Vec<u8>>>,
}
impl Process {
    async fn spawn(app: &App) -> anyhow::Result<Self> {
        let mounts =
            ["src", "scripts", "node_modules"].map(|p| (app.root.join(p), format!("/app/{p}")));
        let mut command = crate::sandbox::persistent_command(
            &app.node,
            &mounts,
            "/app/scripts/pine-host-worker.cjs",
            256,
        );
        let mut child = command.spawn()?;
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut errors = child.stderr.take().unwrap();
        let stderr = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let capture = stderr.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 4096];
            while let Ok(n) = errors.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut saved = capture.lock().await;
                let keep = n.min(64000usize.saturating_sub(saved.len()));
                saved.extend_from_slice(&buf[..keep]);
            }
        });
        Ok(Self {
            child,
            input,
            output,
            stderr,
        })
    }
    async fn call(&mut self, message: Value) -> anyhow::Result<Value> {
        let bytes = message.to_string();
        anyhow::ensure!(bytes.len() <= 16000000, "Pine host input budget exceeded");
        let work = async {
            self.input.write_all(bytes.as_bytes()).await?;
            self.input.write_all(b"\n").await?;
            self.input.flush().await?;
            let mut result = Vec::new();
            loop {
                let chunk = self.output.fill_buf().await?;
                if chunk.is_empty() {
                    let status = self.child.try_wait()?;
                    let diagnostic = self.stderr.lock().await.clone();
                    anyhow::bail!(
                        "Pine host process exited: {status:?}; {}",
                        String::from_utf8_lossy(&diagnostic)
                    );
                }
                let take = chunk
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|i| i + 1)
                    .unwrap_or(chunk.len());
                anyhow::ensure!(
                    result.len() + take <= 32000000,
                    "Pine host output budget exceeded"
                );
                let end = chunk[take - 1] == b'\n';
                result.extend_from_slice(&chunk[..take]);
                self.output.consume(take);
                if end {
                    break;
                }
            }
            let value: Value = serde_json::from_slice(&result)?;
            anyhow::ensure!(value["ok"] == true, "{}", value["error"]);
            Ok::<_, anyhow::Error>(value)
        };
        match tokio::time::timeout(std::time::Duration::from_secs(10), work).await {
            Ok(v) => v,
            Err(_) => {
                let _ = self.child.kill().await;
                anyhow::bail!("Pine host event deadline exceeded")
            }
        }
    }
}
static PROCESSES: OnceLock<tokio::sync::Mutex<HashMap<String, Process>>> = OnceLock::new();
fn processes() -> &'static tokio::sync::Mutex<HashMap<String, Process>> {
    PROCESSES.get_or_init(Default::default)
}
fn adapter(app: &App) -> anyhow::Result<String> {
    let mut text = String::from(include_str!("account.rs"));
    text.push_str(include_str!("sandbox.rs"));
    text.push_str(include_str!("pine_host.rs"));
    for path in [
        "scripts/pine-host-worker.cjs",
        "scripts/register-typescript.cjs",
        "src/pine/host.ts",
        "src/pine/broker.ts",
        "src/pine/intent.ts",
        "src/pine/rollback.ts",
        "src/pine/library.ts",
        "src/pine/data.ts",
        "src/pine/compat.ts",
    ] {
        text.push_str(&std::fs::read_to_string(app.root.join(path))?)
    }
    Ok(hash(&text))
}
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "pine.host.deploy" => {
            let version = required(p, "version_id")?;
            let snapshot = required(p, "snapshot_id")?;
            let sub = required(p, "subscription_id")?;
            let execution = p["execution"].as_str().unwrap_or("indicator");
            anyhow::ensure!(
                ["indicator", "local_broker", "external_broker"].contains(&execution),
                "Unknown host execution mode"
            );
            anyhow::ensure!(
                p.get("inputs").is_none_or(Value::is_object),
                "Host inputs must be object"
            );
            let starting = p["startingCash"].as_f64().unwrap_or(10000.);
            anyhow::ensure!(
                starting.is_finite() && starting > 0.,
                "Positive startingCash required"
            );
            let max = std::env::var("TRADING_MAX_PINE_HOSTS")
                .ok()
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(2)
                .clamp(1, 8);
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM pine_host_sessions WHERE status IN ('warming_up','active','paused')").fetch_one(&app.db).await?;
            anyhow::ensure!(
                count < max,
                "Configured Pine event host budget reached ({max})"
            );
            let v = sqlx::query("SELECT kind FROM strategy_versions WHERE id=?")
                .bind(version)
                .fetch_one(&app.db)
                .await?;
            anyhow::ensure!(
                v.get::<String, _>("kind") == "pine",
                "Event host requires Pine version"
            );
            let text: String = sqlx::query_scalar("SELECT payload FROM snapshots WHERE id=?")
                .bind(snapshot)
                .fetch_one(&app.db)
                .await?;
            let data: Value = serde_json::from_str(&text)?;
            anyhow::ensure!(
                data.get("datasets")
                    .and_then(Value::as_array)
                    .is_none_or(|d| d.is_empty()),
                "Event request datasets need live dependency bindings; not yet configured"
            );
            crate::paper_stream::bindings(app, &data, sub).await?;
            let identity = &data["metadata"]["identity"];
            if execution != "indicator" {
                anyhow::ensure!(
                    ["coinbase", "alpaca"].contains(&identity["provider"].as_str().unwrap_or(""))
                        && identity["currency"] == "USD",
                    "Local broker needs an executable USD Coinbase/Alpaca source"
                );
            }
            let id = uuid::Uuid::new_v4().to_string();
            let digest = adapter(app)?;
            let mut tx = app.db.begin().await?;
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM pine_host_sessions WHERE status IN ('warming_up','active','paused')").fetch_one(&mut *tx).await?;
            anyhow::ensure!(
                count < max,
                "Configured Pine event host budget reached ({max})"
            );
            sqlx::query("INSERT INTO pine_host_sessions(id,version_id,snapshot_id,subscription_id,execution,starting_cash,inputs,status,cursor,adapter_hash,created_at) VALUES(?,?,?,?,?,?,?,'warming_up',(SELECT COALESCE(MAX(cursor),0) FROM market_events),?,?)").bind(&id).bind(version).bind(snapshot).bind(sub).bind(execution).bind(starting).bind(json!(p["inputs"].as_object().cloned().unwrap_or_default()).to_string()).bind(digest).bind(crate::market::now()).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(json!({"session_id":id,"status":"warming_up","execution":execution}))
        }
        "pine.host.feedback" => {
            let id = required(p, "session_id")?;
            let fill = &p["fill"];
            let fill_id = required(fill, "id")?;
            anyhow::ensure!(fill_id.len() <= 128, "Fill id too long");
            required(fill, "orderId")?;
            let mut workers = processes().lock().await;
            let row = sqlx::query("SELECT execution,status FROM pine_host_sessions WHERE id=?")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
            anyhow::ensure!(
                row.get::<String, _>("execution") == "external_broker"
                    && ["active", "paused"].contains(&row.get::<String, _>("status").as_str()),
                "External feedback requires active or paused external_broker host"
            );
            let event_id = format!("external-fill:{fill_id}");
            if let Some(old) = sqlx::query_scalar::<_, String>(
                "SELECT payload FROM pine_host_events WHERE session_id=? AND event_id=?",
            )
            .bind(id)
            .bind(&event_id)
            .fetch_optional(&app.db)
            .await?
            {
                anyhow::ensure!(old == fill.to_string(), "fill_id_conflict");
                return Ok(json!({"duplicate":true}));
            }
            let worker = workers
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("Host recovering; retry after ready state"))?;
            let result = worker.call(json!({"operation":"fill","fill":fill})).await?;
            let mut tx = app.db.begin().await?;
            sqlx::query("INSERT INTO pine_host_events(session_id,event_id,kind,payload,market_cursor) VALUES(?,?,'fill',?,0)").bind(id).bind(event_id).bind(fill.to_string()).execute(&mut *tx).await?;
            sqlx::query("UPDATE pine_host_sessions SET result=? WHERE id=?")
                .bind(result.to_string())
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(json!({"duplicate":false,"result":result}))
        }
        "pine.host.list" | "pine.host.status" => {
            let rows = if let Some(id) = p["session_id"].as_str() {
                sqlx::query("SELECT * FROM pine_host_sessions WHERE id=?")
                    .bind(id)
                    .fetch_all(&app.db)
                    .await?
            } else {
                sqlx::query("SELECT * FROM pine_host_sessions ORDER BY created_at DESC LIMIT 100")
                    .fetch_all(&app.db)
                    .await?
            };
            let result:Vec<Value>=rows.iter().map(|r|json!({"session_id":r.get::<String,_>("id"),"version_id":r.get::<String,_>("version_id"),"snapshot_id":r.get::<String,_>("snapshot_id"),"subscription_id":r.get::<String,_>("subscription_id"),"execution":r.get::<String,_>("execution"),"status":r.get::<String,_>("status"),"marketCursor":r.get::<i64,_>("cursor"),"result":r.get::<Option<String>,_>("result").and_then(|s|serde_json::from_str::<Value>(&s).ok()),"error":r.get::<Option<String>,_>("error")})).collect();
            Ok(if method == "pine.host.status" {
                result.into_iter().next().unwrap_or(Value::Null)
            } else {
                json!(result)
            })
        }
        "pine.host.pause" | "pine.host.resume" | "pine.host.stop" => {
            let id = required(p, "session_id")?;
            let status = if method.ends_with("pause") {
                "paused"
            } else if method.ends_with("stop") {
                "stopped"
            } else {
                "active"
            };
            let mut workers = processes().lock().await;
            let previous: String =
                sqlx::query_scalar("SELECT status FROM pine_host_sessions WHERE id=?")
                    .bind(id)
                    .fetch_one(&app.db)
                    .await?;
            if previous == status {
                return Ok(json!({"status":status,"duplicate":true}));
            }
            anyhow::ensure!(
                status == "stopped" || ["active", "paused"].contains(&previous.as_str()),
                "Host cannot transition before ready or after failure"
            );
            if status == "active" {
                if let Some(worker) = workers.get_mut(id) {
                    worker.call(json!({"operation":"clearOrders"})).await?;
                }
            }
            let mut tx = app.db.begin().await?;
            if status == "active" {
                sqlx::query("INSERT INTO pine_host_events(session_id,event_id,kind,payload,market_cursor) VALUES(?,?,'clear','{}',0)").bind(id).bind(uuid::Uuid::new_v4().to_string()).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE pine_host_sessions SET status=? WHERE id=?")
                .bind(status)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE pine_host_dispatch SET status='canceled' WHERE session_id=? AND status='pending'").bind(id).execute(&mut *tx).await?;
            sqlx::query("UPDATE pine_host_intents SET status='canceled' WHERE session_id=? AND status='pending'").bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            if ["paused", "stopped"].contains(&status) {
                let orders=sqlx::query_scalar::<_,String>("SELECT id FROM local_orders WHERE client_order_id LIKE ? AND status IN ('working','triggered')").bind(format!("pine:{id}:%")).fetch_all(&app.db).await?;
                for order in orders {
                    crate::account::execute(app, "account.cancelOrder", &json!({"id":order}))
                        .await?;
                }
            }
            if status == "stopped" {
                workers.remove(id);
            }
            Ok(
                json!({"status":status,"tradingPaused":status=="paused","calculationsContinueWhilePaused":true}),
            )
        }
        "pine.host.render" => {
            let id = required(p, "session_id")?;
            let mut workers = processes().lock().await;
            let worker = workers
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("Event host unavailable or recovering"))?;
            worker.call(json!({"operation":"state"})).await
        }
        "pine.host.events" => {
            let id = required(p, "session_id")?;
            let rows=sqlx::query("SELECT * FROM pine_host_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 1000").bind(id).bind(p["cursor"].as_i64().unwrap_or(0)).fetch_all(&app.db).await?;
            Ok(
                json!({"events":rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("seq"),"kind":r.get::<String,_>("kind"),"event_id":r.get::<String,_>("event_id"),"payload":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap_or(Value::Null),"marketCursor":r.get::<i64,_>("market_cursor")})).collect::<Vec<_>>() }),
            )
        }
        _ => anyhow::bail!("Unknown Pine host command"),
    }
}
pub async fn coordinator(app: App) {
    loop {
        if let Err(e) = tick(&app).await {
            eprintln!("pine host: {e}")
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
async fn tick(app: &App) -> anyhow::Result<()> {
    let sessions=sqlx::query("SELECT h.*,v.source,v.library_lock,s.payload FROM pine_host_sessions h JOIN strategy_versions v ON v.id=h.version_id JOIN snapshots s ON s.id=h.snapshot_id WHERE h.status IN ('active','warming_up','paused') ORDER BY h.created_at LIMIT 8").fetch_all(&app.db).await?;
    for row in sessions {
        let id: String = row.get("id");
        if let Err(error) = advance(app, &row).await {
            processes().lock().await.remove(&id);
            sqlx::query("UPDATE pine_host_sessions SET status='failed',error=? WHERE id=? AND status!='stopped'").bind(error.to_string()).bind(&id).execute(&app.db).await?;
            sqlx::query("UPDATE pine_host_dispatch SET status='canceled' WHERE session_id=? AND status='pending'").bind(&id).execute(&app.db).await?;
            sqlx::query("UPDATE pine_host_intents SET status='canceled' WHERE session_id=? AND status='pending'").bind(&id).execute(&app.db).await?;
            let orders = sqlx::query_scalar::<_, String>(
                "SELECT id FROM local_orders WHERE client_order_id LIKE ? AND status IN ('working','triggered')",
            )
            .bind(format!("pine:{id}:%"))
            .fetch_all(&app.db)
            .await?;
            for order in orders {
                let _ =
                    crate::account::execute(app, "account.cancelOrder", &json!({"id":order})).await;
            }
        }
    }
    Ok(())
}
async fn advance(app: &App, row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<()> {
    let id: String = row.get("id");
    let sub: String = row.get("subscription_id");
    let cursor: i64 = row.get("cursor");
    anyhow::ensure!(
        adapter(app)? == row.get::<String, _>("adapter_hash"),
        "Event host adapter changed; deploy a new immutable execution"
    );
    let source_identity =
        sqlx::query("SELECT status,desired,pruned_cursor FROM market_subscriptions WHERE id=?")
            .bind(&sub)
            .fetch_one(&app.db)
            .await?;
    anyhow::ensure!(
        source_identity.get::<i64, _>("desired") == 1,
        "Bound subscription stopped"
    );
    anyhow::ensure!(
        cursor >= source_identity.get::<i64, _>("pruned_cursor"),
        "Market cursor expired; tick continuity unverified"
    );
    let mut workers = processes().lock().await;
    if !workers.contains_key(&id) {
        let mut data: Value = serde_json::from_str(&row.get::<String, _>("payload"))?;
        if row.get::<String, _>("status") == "warming_up" {
            let last = data["bars"].as_array().unwrap().last().unwrap()["time"]
                .as_i64()
                .unwrap();
            let cached=sqlx::query("SELECT payload FROM market_bars WHERE subscription_id=? AND closed=1 AND json_extract(quality,'$.complete')=1 AND time>? ORDER BY time LIMIT 2048").bind(&sub).bind(last).fetch_all(&app.db).await?;
            for bar in cached {
                let bar: Value = serde_json::from_str(&bar.get::<String, _>("payload"))?;
                let end = data["bars"].as_array().unwrap().last().unwrap()["closeTime"]
                    .as_i64()
                    .unwrap();
                let expected = crate::market::period::next(&data["metadata"]["identity"], end)?
                    .unwrap()
                    .0;
                if bar["time"] != expected {
                    break;
                }
                data["bars"].as_array_mut().unwrap().push(bar)
            }
            let forming=sqlx::query("SELECT payload,quality FROM market_bars WHERE subscription_id=? AND closed=0 ORDER BY time DESC LIMIT 1").bind(&sub).fetch_optional(&app.db).await?;
            let Some(forming) = forming else {
                return Ok(());
            };
            let quality: Value = serde_json::from_str(&forming.get::<String, _>("quality"))?;
            let bar: Value = serde_json::from_str(&forming.get::<String, _>("payload"))?;
            let last = data["bars"].as_array().unwrap().last().unwrap();
            let expected = crate::market::period::next(
                &data["metadata"]["identity"],
                last["closeTime"].as_i64().unwrap(),
            )?
            .unwrap()
            .0;
            if bar["time"] != expected
                || (quality["complete"] != true
                    && !(row.get::<String, _>("execution") == "indicator"
                        && quality["source"] == "quote-derived"))
            {
                return Ok(());
            }
            data["metadata"]["provenance"]["hostClock"] = json!(crate::market::now());
            data["metadata"]["provenance"]["hostWarmupSource"] = json!({"subscription_id":sub,"primarySnapshot":row.get::<String,_>("snapshot_id"),"source":"confirmed persisted stream bars"});
            let payload = data.to_string();
            let snapshot = uuid::Uuid::new_v4().to_string();
            let mut tx = app.db.begin().await?;
            sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES(?,?,?)")
                .bind(&snapshot)
                .bind(&payload)
                .bind(hash(&payload))
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE pine_host_sessions SET snapshot_id=?,cursor=(SELECT COALESCE(MAX(cursor),0) FROM market_events) WHERE id=? AND status='warming_up'").bind(snapshot).bind(&id).execute(&mut *tx).await?;
            tx.commit().await?;
        }
        let lock = row
            .get::<Option<String>, _>("library_lock")
            .map(|s| serde_json::from_str::<Value>(&s))
            .transpose()?;
        let mut process = Process::spawn(app).await?;
        let execution: String = row.get("execution");
        let options = json!({"executionTime":data["metadata"]["provenance"]["hostClock"].as_i64().unwrap_or(row.get::<i64,_>("created_at")),"inputs":serde_json::from_str::<Value>(&row.get::<String,_>("inputs"))?,"libraryLock":lock,"broker":if execution!="indicator"{json!({"startingCash":row.get::<f64,_>("starting_cash")})}else{Value::Null}});
        process.call(json!({"operation":"init","source":row.get::<String,_>("source"),"data":data,"options":options})).await?;
        let mut seq = 0;
        loop {
            let replay=sqlx::query("SELECT seq,kind,payload FROM pine_host_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 200").bind(&id).bind(seq).fetch_all(&app.db).await?;
            if replay.is_empty() {
                break;
            }
            for event in replay {
                seq = event.get("seq");
                let payload: Value = serde_json::from_str(&event.get::<String, _>("payload"))?;
                process
                    .call(if event.get::<String, _>("kind") == "clear" {
                        json!({"operation":"clearOrders"})
                    } else if event.get::<String, _>("kind") == "fill" {
                        json!({"operation":"fill","fill":payload})
                    } else {
                        json!({"operation":"market","event":payload})
                    })
                    .await?;
            }
        }
        workers.insert(id.clone(), process);
        if row.get::<String, _>("status") == "warming_up" {
            sqlx::query(
                "UPDATE pine_host_sessions SET status='active' WHERE id=? AND status='warming_up'",
            )
            .bind(&id)
            .execute(&app.db)
            .await?;
            return Ok(());
        }
    }
    // Replay has rebuilt committed computation. Drain its durable desired-order
    // set before processing newer source events or fill projections.
    drain_dispatch(app, &id, &sub).await?;
    let process = workers.get_mut(&id).unwrap();
    let fills=sqlx::query("SELECT f.*,f.rowid AS sequence,h.pine_order_id FROM local_fills f JOIN pine_host_orders h ON h.local_order_id=f.order_id WHERE h.session_id=? AND f.rowid>? ORDER BY f.rowid LIMIT 100").bind(&id).bind(row.get::<i64,_>("fill_cursor")).fetch_all(&app.db).await?;
    for fill in fills {
        let prior: Option<String> =
            sqlx::query_scalar("SELECT result FROM pine_host_sessions WHERE id=?")
                .bind(&id)
                .fetch_one(&app.db)
                .await?;
        let prior = prior
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);
        let bar_index = prior["barIndex"].as_i64().unwrap_or(0);
        let feedback = json!({"id":fill.get::<String,_>("id"),"orderId":fill.get::<String,_>("pine_order_id"),"side":fill.get::<String,_>("side"),"qty":fill.get::<f64,_>("qty"),"price":fill.get::<f64,_>("price"),"fee":fill.get::<f64,_>("fee"),"time":fill.get::<i64,_>("time"),"barIndex":bar_index});
        let response = process
            .call(json!({"operation":"fill","fill":feedback}))
            .await?;
        let mut tx = app.db.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO pine_host_events(session_id,event_id,kind,payload,market_cursor) VALUES(?,?,'fill',?,?)").bind(&id).bind(format!("fill:{}",fill.get::<String,_>("id"))).bind(feedback.to_string()).bind(fill.get::<i64,_>("market_cursor")).execute(&mut *tx).await?;
        sqlx::query("UPDATE pine_host_sessions SET fill_cursor=?,result=? WHERE id=?")
            .bind(fill.get::<i64, _>("sequence"))
            .bind(response.to_string())
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    let events=sqlx::query("SELECT * FROM market_events WHERE subscription_id=? AND cursor>? ORDER BY cursor LIMIT 100").bind(&sub).bind(cursor).fetch_all(&app.db).await?;
    for event in events {
        let next: i64 = event.get("cursor");
        let kind: String = event.get("type");
        let payload: Value = serde_json::from_str(&event.get::<String, _>("payload"))?;
        let quality: Value = serde_json::from_str(&event.get::<String, _>("quality"))?;
        if kind == "bar.revised" {
            anyhow::bail!("Committed source bar revised; event host frozen")
        }
        if ["trade.corrected", "trade.canceled"].contains(&kind.as_str())
            || (kind == "gap" && payload["tickContinuityLost"] == true)
        {
            anyhow::bail!(
                "Source tick continuity changed ({kind}); event host frozen pending a verified new deployment"
            )
        }
        if ["bar.update", "bar.closed"].contains(&kind.as_str())
            && (quality["complete"] == true
                || (row.get::<String, _>("execution") == "indicator"
                    && quality["source"] == "quote-derived"))
        {
            let host_event = json!({"id":format!("market:{next}"),"kind":if kind=="bar.closed"{"closed"}else{"forming"},"bar":payload,"eventTime":event.get::<i64,_>("event_time"),"executionTime":event.get::<i64,_>("received_at")});
            let response = process
                .call(json!({"operation":"market","event":host_event.clone()}))
                .await?;
            commit_market_response(app, &id, next, &host_event, &response).await?;
            drain_dispatch(app, &id, &sub).await?;
        } else {
            sqlx::query("UPDATE pine_host_sessions SET cursor=? WHERE id=? AND status IN ('active','paused')")
                .bind(next)
                .bind(&id)
                .execute(&app.db)
                .await?;
        }
    }
    Ok(())
}
/// Validate the whole desired order set before any submission or cancellation.
fn normalize_intents(response: &Value) -> anyhow::Result<Vec<Value>> {
    let orders = response["pendingOrders"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing pending order set"))?;
    let mut result = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for order in orders {
        let id = required(order, "id")?;
        anyhow::ensure!(
            ids.insert(id.to_string()),
            "Duplicate native order id requires explicit grouping"
        );
        anyhow::ensure!(order["status"] == "pending", "Invalid pending order status");
        anyhow::ensure!(
            ["market", "limit", "stop", "stop-limit"]
                .contains(&order["type"].as_str().unwrap_or("")),
            "Unsupported broker order type"
        );
        for key in [
            "profit",
            "loss",
            "trail_price",
            "trail_points",
            "trail_offset",
        ] {
            anyhow::ensure!(
                order[key].is_null(),
                "Unsupported event broker order field {key}; no market substitution"
            );
        }
        anyhow::ensure!(
            order["oca_name"].as_str().is_none_or(str::is_empty)
                && (order["oca_type"].is_null() || order["oca_type"] == "none"),
            "BrokerHost OCA group execution is not supported"
        );
        anyhow::ensure!(
            order["immediately"] != true,
            "Immediate fills are unavailable in the next-quote broker"
        );
        anyhow::ensure!(
            order["category"].is_null()
                || ["entry", "exit"].contains(&order["category"].as_str().unwrap_or("")),
            "Unsupported order category"
        );
        let mut qty = order["qty"]
            .as_f64()
            .filter(|q| q.is_finite() && *q >= 0.)
            .ok_or_else(|| anyhow::anyhow!("Invalid broker intent quantity"))?;
        let side = if order["category"] == "exit" {
            let lots: Vec<&Value> = response["openTrades"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|t| {
                    order["from_entry"]
                        .as_str()
                        .is_none_or(|entry| t["entry_id"] == entry)
                })
                .collect();
            let size: f64 = lots.iter().map(|t| t["size"].as_f64().unwrap_or(0.)).sum();
            if size == 0. {
                continue;
            }
            anyhow::ensure!(
                size.is_finite()
                    && lots.iter().all(|t| t["size"]
                        .as_f64()
                        .is_some_and(|n| n.signum() == size.signum())),
                "Mixed or invalid broker exit lots"
            );
            let percent = order["qty_percent"].as_f64().unwrap_or(100.);
            anyhow::ensure!(
                percent.is_finite() && percent > 0. && percent <= 100.,
                "Invalid broker exit percentage"
            );
            if qty == 0. {
                qty = size.abs() * percent / 100.;
            }
            qty = qty.min(size.abs());
            if size > 0. { "sell" } else { "buy" }
        } else {
            match order["direction"].as_f64() {
                Some(1.) => "buy",
                Some(-1.) => "sell",
                _ => anyhow::bail!("Invalid broker order direction"),
            }
        };
        anyhow::ensure!(
            qty.is_finite() && qty > 0.,
            "Invalid broker intent quantity"
        );
        let price = |key: &str| -> anyhow::Result<Option<f64>> {
            if order[key].is_null() {
                return Ok(None);
            }
            Ok(Some(
                order[key]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n > 0.)
                    .ok_or_else(|| anyhow::anyhow!("Invalid broker {key} price"))?,
            ))
        };
        let limit = price("limit")?;
        let stop = price("stop")?;
        anyhow::ensure!(
            !(order["category"] == "exit" && limit.is_some() && stop.is_some()),
            "Two-leg Pine exit requires OCO; no stop-limit substitution"
        );
        let kind = match (limit, stop) {
            (Some(_), Some(_)) => "stop-limit",
            (Some(_), None) => "limit",
            (None, Some(_)) => "stop",
            _ => "market",
        };
        result.push(
            json!({"pine_id":id,"side":side,"qty":qty,"type":kind,"price":limit,"stopPrice":stop}),
        );
    }
    Ok(result)
}

async fn commit_market_response(
    app: &App,
    id: &str,
    cursor: i64,
    event: &Value,
    response: &Value,
) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    let session = sqlx::query(
        "SELECT status,execution,version_id,snapshot_id,inputs FROM pine_host_sessions WHERE id=?",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let status: String = session.get("status");
    anyhow::ensure!(
        ["active", "paused"].contains(&status.as_str()),
        "Host stopped before event commit"
    );
    let local = session.get::<String, _>("execution") == "local_broker" && status == "active";
    if local {
        normalize_intents(response)?;
    }
    let event_id = required(event, "id")?;
    sqlx::query("INSERT INTO pine_host_events(session_id,event_id,kind,payload,market_cursor) VALUES(?,?,'market',?,?)").bind(id).bind(event_id).bind(event.to_string()).bind(cursor).execute(&mut *tx).await?;
    let context = json!({"source":"pine_host","event_id":event_id,"marketCursor":cursor,"version_id":session.get::<String,_>("version_id"),"snapshot_id":session.get::<String,_>("snapshot_id"),"inputs":serde_json::from_str::<Value>(&session.get::<String,_>("inputs"))?});
    for (index, alert) in response["alerts"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let alert_id = hash(&format!("{id}:{event_id}:{index}:{}", alert));
        sqlx::query("INSERT OR IGNORE INTO pine_alert_history(id,session_id,job_id,event_time,payload,received_at,context) VALUES(?,?,?,?,?,?,?)").bind(alert_id).bind(id).bind(format!("pine-host:{id}")).bind(event["eventTime"].as_i64().unwrap_or(0)).bind(alert.to_string()).bind(event["executionTime"].as_i64().unwrap_or(0)).bind(context.to_string()).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE pine_host_sessions SET result=?,cursor=? WHERE id=?")
        .bind(response.to_string())
        .bind(cursor)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if local {
        sqlx::query("INSERT INTO pine_host_dispatch(session_id,market_cursor,response,decision_time,status) VALUES(?,?,?,?,'pending')").bind(id).bind(cursor).bind(response.to_string()).bind(crate::market::now()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn drain_dispatch(app: &App, id: &str, sub: &str) -> anyhow::Result<()> {
    let active: String = sqlx::query_scalar("SELECT status FROM pine_host_sessions WHERE id=?")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    if active != "active" {
        return Ok(());
    }
    let pending=sqlx::query("SELECT market_cursor,response,decision_time FROM pine_host_dispatch WHERE session_id=? AND status='pending' ORDER BY market_cursor LIMIT 100").bind(id).fetch_all(&app.db).await?;
    for item in pending {
        let cursor: i64 = item.get("market_cursor");
        dispatch(
            app,
            id,
            sub,
            cursor,
            item.get("decision_time"),
            &serde_json::from_str(&item.get::<String, _>("response"))?,
        )
        .await?;
        sqlx::query("UPDATE pine_host_dispatch SET status='done' WHERE session_id=? AND market_cursor=? AND status='pending'").bind(id).bind(cursor).execute(&app.db).await?;
    }
    Ok(())
}

async fn dispatch(
    app: &App,
    id: &str,
    sub: &str,
    cursor: i64,
    decision_time: i64,
    response: &Value,
) -> anyhow::Result<()> {
    let intents = normalize_intents(response)?;
    let identity: String =
        sqlx::query_scalar("SELECT identity FROM market_subscriptions WHERE id=?")
            .bind(sub)
            .fetch_one(&app.db)
            .await?;
    let identity: Value = serde_json::from_str(&identity)?;
    crate::market::execution_eligibility(&identity, &json!({"complete":true,"stale":false}))?;
    let desired: std::collections::HashSet<String> = intents
        .iter()
        .map(|v| v["pine_id"].as_str().unwrap().to_string())
        .collect();
    for mut intent in intents {
        let pine_id = intent["pine_id"].as_str().unwrap().to_string();
        intent.as_object_mut().unwrap().remove("pine_id");
        if let Some(old)=sqlx::query("SELECT h.local_order_id,h.intent,o.status,o.client_order_id FROM pine_host_orders h JOIN local_orders o ON o.id=h.local_order_id WHERE h.session_id=? AND h.pine_order_id=?").bind(id).bind(&pine_id).fetch_optional(&app.db).await? {
            if old.get::<String,_>("status")=="filled" && old.get::<String,_>("client_order_id")!=format!("pine:{id}:{cursor}:{pine_id}") {
                let unseen:i64=sqlx::query_scalar("SELECT COUNT(*) FROM local_fills WHERE order_id=? AND rowid>(SELECT fill_cursor FROM pine_host_sessions WHERE id=?)").bind(old.get::<String,_>("local_order_id")).bind(id).fetch_one(&app.db).await?;
                anyhow::ensure!(unseen==0,"Prior order filled before replacement but is not reconciled; host stopped without another submission");
            }
            if ["working","triggered"].contains(&old.get::<String,_>("status").as_str()) {
                if old.get::<String,_>("intent")==intent.to_string(){continue}
                // Full replacement preserves type/side semantics; quantity/price-only
                // amendment could silently retain an old market or stop order type.
                let canceled=crate::account::execute(app,"account.cancelOrder",&json!({"id":old.get::<String,_>("local_order_id")})).await?;
                anyhow::ensure!(canceled["canceled"]==true,"Order changed during replacement; reconcile before another submission");
            }
        }
        let request = json!({"provider":identity["provider"],"symbol":identity["symbol"],"feed":identity["feed"],"session":identity["session"],"side":intent["side"],"qty":intent["qty"],"type":intent["type"],"price":intent["price"],"stopPrice":intent["stopPrice"],"client_order_id":format!("pine:{id}:{cursor}:{pine_id}"),"afterEventTime":decision_time});
        let request=if let Some(pending)=sqlx::query_scalar::<_,String>("SELECT request FROM pine_host_intents WHERE session_id=? AND pine_order_id=? AND status='pending'").bind(id).bind(&pine_id).fetch_optional(&app.db).await? {
            let saved:Value=serde_json::from_str(&pending)?;
            anyhow::ensure!(saved["client_order_id"]==request["client_order_id"],"Unresolved prior broker intent requires reconciliation");saved
        } else {
            sqlx::query("INSERT INTO pine_host_intents VALUES(?,?,?,'pending') ON CONFLICT(session_id,pine_order_id) DO UPDATE SET request=excluded.request,status='pending'").bind(id).bind(&pine_id).bind(request.to_string()).execute(&app.db).await?;request
        };
        let placed = crate::account::execute(app, "account.placeOrder", &request).await?;
        anyhow::ensure!(
            placed["status"] != "rejected",
            "Broker rejected native intent: {}",
            placed["error"]
        );
        let mut tx = app.db.begin().await?;
        sqlx::query("INSERT INTO pine_host_orders VALUES(?,?,?,?) ON CONFLICT(session_id,pine_order_id) DO UPDATE SET local_order_id=excluded.local_order_id,intent=excluded.intent").bind(id).bind(&pine_id).bind(required(&placed,"id")?).bind(intent.to_string()).execute(&mut *tx).await?;
        sqlx::query("UPDATE pine_host_intents SET status='submitted' WHERE session_id=? AND pine_order_id=?").bind(id).bind(&pine_id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    let existing =
        sqlx::query("SELECT pine_order_id,local_order_id FROM pine_host_orders WHERE session_id=?")
            .bind(id)
            .fetch_all(&app.db)
            .await?;
    for order in existing {
        if !desired.contains(&order.get::<String, _>("pine_order_id")) {
            crate::account::execute(
                app,
                "account.cancelOrder",
                &json!({"id":order.get::<String,_>("local_order_id")}),
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    async fn fixture() -> anyhow::Result<App> {
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
        sqlx::query("INSERT INTO strategy_versions(id,name,kind,source,hash) VALUES('v','fixture','pine','fixture','fixture')").execute(&app.db).await?;
        sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES('s','{}','fixture')")
            .execute(&app.db)
            .await?;
        let identity =
            crate::market::identity("coinbase", "TEST-USD", "1m", "public-websocket", "none")?;
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('sub','coinbase','TEST-USD','1m',?,'connected','public-websocket')").bind(identity.to_string()).execute(&app.db).await?;
        sqlx::query("INSERT INTO pine_host_sessions(id,version_id,snapshot_id,subscription_id,execution,starting_cash,status,adapter_hash,created_at) VALUES('h','v','s','sub','local_broker',1000,'active','fixture',0)").execute(&app.db).await?;
        Ok(app)
    }
    fn response() -> Value {
        json!({"pendingOrders":[{"id":"L","type":"market","category":"entry","status":"pending","direction":1,"qty":2}],"openTrades":[],"alerts":[{"message":"fixture alert","freq":"all","time":1000}]})
    }
    fn event(cursor: i64) -> Value {
        json!({"id":format!("market:{cursor}"),"kind":"forming","eventTime":1000+cursor,"executionTime":2000+cursor})
    }
    #[test]
    fn unsupported_exit_fields_never_normalize_to_market() {
        for key in [
            "profit",
            "loss",
            "trail_price",
            "trail_points",
            "trail_offset",
        ] {
            let mut r = response();
            r["pendingOrders"][0][key] = json!(2);
            assert!(
                normalize_intents(&r)
                    .unwrap_err()
                    .to_string()
                    .contains("Unsupported")
            );
        }
        let mut r = response();
        r["pendingOrders"][0]["limit"] = json!(9.);
        assert_eq!(normalize_intents(&r).unwrap()[0]["type"], "limit");
        r["pendingOrders"][0]["stop"] = json!(10.);
        assert_eq!(normalize_intents(&r).unwrap()[0]["type"], "stop-limit");
        r["pendingOrders"][0]["category"] = json!("exit");
        r["openTrades"] = json!([{"entry_id":"L","size":2}]);
        assert!(normalize_intents(&r).is_err());
    }
    #[tokio::test]
    async fn result_alert_cursor_and_outbox_commit_atomically() -> anyhow::Result<()> {
        let app = fixture().await?;
        sqlx::query("CREATE TRIGGER test_dispatch_crash BEFORE INSERT ON pine_host_dispatch BEGIN SELECT RAISE(ABORT,'fixture crash before dispatch commit'); END").execute(&app.db).await?;
        assert!(
            commit_market_response(&app, "h", 1, &event(1), &response())
                .await
                .is_err()
        );
        for table in [
            "pine_host_events",
            "pine_host_dispatch",
            "pine_alert_history",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&app.db)
                .await?;
            assert_eq!(count, 0, "{table}");
        }
        let cursor: i64 = sqlx::query_scalar("SELECT cursor FROM pine_host_sessions WHERE id='h'")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(cursor, 0);
        sqlx::query("DROP TRIGGER test_dispatch_crash")
            .execute(&app.db)
            .await?;
        commit_market_response(&app, "h", 1, &event(1), &response()).await?;
        let history = crate::alerts::execute(&app, "alerts.strategyHistory", &json!({})).await?;
        assert_eq!(history.as_array().unwrap().len(), 1);
        assert_eq!(history[0]["context"]["version_id"], "v");
        assert_eq!(history[0]["context"]["event_id"], "market:1");
        drain_dispatch(&app, "h", "sub").await?;
        let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_orders")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(orders, 1);
        // Acknowledged rows are never replayed, even if the order is subsequently canceled.
        let local_id: String = sqlx::query_scalar("SELECT id FROM local_orders LIMIT 1")
            .fetch_one(&app.db)
            .await?;
        crate::account::execute(&app, "account.cancelOrder", &json!({"id":local_id})).await?;
        drain_dispatch(&app, &"h", &"sub").await?;
        let state: String = sqlx::query_scalar("SELECT status FROM local_orders WHERE id=?")
            .bind(&local_id)
            .fetch_one(&app.db)
            .await?;
        assert_eq!(state, "canceled");
        // Simulate a committed broker submission with lost outbox acknowledgement.
        sqlx::query("UPDATE pine_host_dispatch SET status='pending'")
            .execute(&app.db)
            .await?;
        drain_dispatch(&app.clone(), "h", "sub").await?;
        let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_orders")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(orders, 1);
        let status: String = sqlx::query_scalar("SELECT status FROM pine_host_dispatch")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(status, "done");
        Ok(())
    }
    #[tokio::test]
    async fn recovered_outbox_replaces_type_and_side_instead_of_amending_prices_only()
    -> anyhow::Result<()> {
        let app = fixture().await?;
        commit_market_response(&app, "h", 1, &event(1), &response()).await?;
        drain_dispatch(&app, "h", "sub").await?;
        let mut next = response();
        next["pendingOrders"][0]["limit"] = json!(9.);
        next["pendingOrders"][0]["direction"] = json!(-1);
        commit_market_response(&app, "h", 2, &event(2), &next).await?;
        // New application handle reads the pending desired set without a new quote.
        drain_dispatch(&app.clone(), "h", "sub").await?;
        let rows = sqlx::query("SELECT side,type,status FROM local_orders ORDER BY rowid")
            .fetch_all(&app.db)
            .await?;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<String, _>("status"), "canceled");
        assert_eq!(rows[1].get::<String, _>("side"), "sell");
        assert_eq!(rows[1].get::<String, _>("type"), "limit");
        assert_eq!(rows[1].get::<String, _>("status"), "working");
        Ok(())
    }
}
