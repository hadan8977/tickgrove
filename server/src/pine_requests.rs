//! Freeze request.security dependencies from the primary snapshot's exact market provenance.
use crate::{
    App,
    commands::{hash, required},
};
use serde_json::{Value, json};
use sqlx::Row;
pub async fn inspect(app: &App, p: &Value) -> anyhow::Result<Value> {
    let source = required(p, "source")?;
    anyhow::ensure!(source.len() <= 500000, "Source exceeds limit");
    let lock = crate::pine_libraries::resolve(app, source).await?;
    inspect_locked(app, source, Some(lock)).await
}
async fn inspect_locked(app: &App, source: &str, lock: Option<Value>) -> anyhow::Result<Value> {
    let request = json!({"operation":"dependencies","source":source,"libraryLock":lock});
    let output = {
        let _permit = app.execution_budget.acquire().await?;
        let mounts =
            ["src", "scripts", "node_modules"].map(|p| (app.root.join(p), format!("/app/{p}")));
        let cmd =
            crate::sandbox::command(&app.node, &mounts, "/app/scripts/service-worker.cjs", 128);
        crate::sandbox::execute(cmd, request.to_string().into_bytes(), 10, 1_000_000, None).await?
    };
    anyhow::ensure!(
        output.status == "succeeded",
        "Pine dependency inspection failed"
    );
    let deps: Value = serde_json::from_slice(&output.stdout)?;
    anyhow::ensure!(deps["ok"] == true, "{}", deps["error"]);
    Ok(deps)
}
pub async fn prepare(app: &App, p: &Value) -> anyhow::Result<Value> {
    let version = required(p, "version_id")?;
    let snapshot = required(p, "snapshot_id")?;
    let v = sqlx::query("SELECT source,kind,library_lock FROM strategy_versions WHERE id=?")
        .bind(version)
        .fetch_one(&app.db)
        .await?;
    if v.get::<String, _>("kind") != "pine" {
        return Ok(json!({"snapshot_id":snapshot,"requests":[],"dynamic":[]}));
    }
    let text: String = sqlx::query_scalar("SELECT payload FROM snapshots WHERE id=?")
        .bind(snapshot)
        .fetch_one(&app.db)
        .await?;
    let mut data: Value = serde_json::from_str(&text)?;
    let lock = v
        .get::<Option<String>, _>("library_lock")
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()?;
    let deps = inspect_locked(app, &v.get::<String, _>("source"), lock).await?;
    let explicit = data
        .get("datasets")
        .and_then(Value::as_array)
        .is_some_and(|d| !d.is_empty());
    anyhow::ensure!(
        deps["dynamic"].as_array().is_none_or(|a| a.is_empty()) || explicit,
        "Dynamic request symbol/timeframe needs explicitly configured immutable datasets: {}",
        deps["dynamic"]
    );
    let mut fetched = Vec::new();
    let identity = data["metadata"]["identity"].clone();
    for dep in deps["requests"].as_array().unwrap() {
        let symbol = dep["symbol"]
            .as_str()
            .unwrap_or(data["symbol"].as_str().unwrap())
            .to_string();
        let symbol = symbol.as_str();
        let tf = normalize(
            dep["timeframe"]
                .as_str()
                .unwrap_or(data["timeframe"].as_str().unwrap()),
        )?;
        let primary = symbol == data["symbol"].as_str().unwrap()
            && normalize(data["timeframe"].as_str().unwrap())? == tf;
        let supplied = data
            .get("datasets")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter().any(|d| {
                    d["symbol"] == symbol
                        && d["timeframe"]
                            .as_str()
                            .and_then(|s| normalize(s).ok())
                            .as_deref()
                            == Some(&tf)
                })
            });
        if primary || supplied {
            continue;
        }
        let provider = identity["provider"].as_str().ok_or_else(|| {
            anyhow::anyhow!(
                "Missing request dataset {symbol}/{tf}; offline snapshots require explicit datasets"
            )
        })?;
        let (requested_venue, raw_symbol) = symbol
            .split_once(':')
            .map(|(v, s)| (Some(v), s))
            .unwrap_or((None, symbol));
        let bars = data["bars"].as_array().unwrap();
        let start = bars.first().unwrap()["time"].as_i64().unwrap();
        let end = bars.last().unwrap()["closeTime"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("Primary real snapshot lacks closeTime"))?;
        let params = json!({"provider":provider,"symbol":raw_symbol,"timeframe":tf,"feed":identity["feed"],"adjustment":identity["adjustment"],"start":start,"end":end,"allowGaps":false});
        let mut params = params;
        if provider == "yahoo" {
            params["session"] = identity["session"].clone()
        }
        let found = crate::market::history::fetch(app, &params).await?;
        if let Some(venue) = requested_venue {
            anyhow::ensure!(
                venue_matches(venue, found["identity"]["venue"].as_str().unwrap_or("")),
                "Request venue {venue} does not match target source venue {}",
                found["identity"]["venue"]
            );
        }
        let mut dataset = found["data"].clone();
        dataset["symbol"] = json!(symbol);
        if data.get("datasets").is_none() {
            data["datasets"] = json!([])
        }
        data["datasets"].as_array_mut().unwrap().push(dataset);
        fetched.push(json!({"symbol":symbol,"timeframe":tf,"snapshot_id":found["snapshot_id"],"hash":found["hash"],"identity":found["identity"]}));
    }
    if fetched.is_empty() {
        return Ok(
            json!({"snapshot_id":snapshot,"requests":deps["requests"],"dynamic":deps["dynamic"],"fetched":fetched}),
        );
    }
    data["metadata"]["provenance"]["requestSources"] = json!(fetched);
    data["metadata"]["provenance"]["primarySnapshot"] = json!(snapshot);
    crate::commands::validate_data(&data)?;
    let id = uuid::Uuid::new_v4().to_string();
    let payload = data.to_string();
    let digest = hash(&payload);
    sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES(?,?,?)")
        .bind(&id)
        .bind(payload)
        .bind(&digest)
        .execute(&app.db)
        .await?;
    Ok(
        json!({"snapshot_id":id,"hash":digest,"requests":deps["requests"],"dynamic":deps["dynamic"],"fetched":fetched}),
    )
}
fn normalize(tf: &str) -> anyhow::Result<String> {
    let upper = tf.to_uppercase();
    let value = match upper.as_str() {
        "D" => "1D".to_string(),
        "W" => "1W".to_string(),
        "60" => "1H".to_string(),
        "240" => "4H".to_string(),
        "360" => "6H".to_string(),
        _ if tf.chars().all(|c| c.is_ascii_digit()) => format!("{tf}m"),
        _ => tf.to_string(),
    };
    crate::market::seconds(&value)?;
    Ok(value)
}

fn venue_matches(requested: &str, actual: &str) -> bool {
    requested == actual
        || match requested {
            "NASDAQ" => ["NMS", "NGM", "NCM", "NasdaqGS", "NasdaqGM", "NasdaqCM"].contains(&actual),
            "NYSE" => ["NYQ", "New York Stock Exchange"].contains(&actual),
            "AMEX" | "NYSEARCA" | "ARCA" => {
                ["PCX", "ASE", "NYSEArca", "NYSE American"].contains(&actual)
            }
            "COINBASE" => actual == "Coinbase",
            _ => false,
        }
}
