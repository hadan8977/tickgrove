use crate::App;
use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::{io::Write, path::PathBuf};

pub static ACCOUNT_CHANGE: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Serialize, Deserialize)]
struct AlpacaCredentials {
    key: String,
    secret: String,
}

async fn credential_path(app: &App) -> anyhow::Result<PathBuf> {
    let rows = sqlx::query("PRAGMA database_list")
        .fetch_all(&app.db)
        .await?;
    let file = rows
        .iter()
        .find(|r| r.get::<String, _>("name") == "main")
        .map(|r| r.get::<String, _>("file"))
        .unwrap_or_default();
    let directory = if file.is_empty() {
        app.root.join("var")
    } else {
        PathBuf::from(file)
            .parent()
            .context("Database directory is missing")?
            .to_path_buf()
    };
    Ok(directory.join("connections").join("alpaca.json"))
}

pub async fn alpaca_credentials(app: &App) -> anyhow::Result<(String, String)> {
    let path = credential_path(app).await?;
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Invalid connection credentials file"
        );
        let value: AlpacaCredentials = serde_json::from_slice(&std::fs::read(path)?)
            .map_err(|_| anyhow::anyhow!("Connection credentials file is invalid"))?;
        ensure!(
            !value.key.is_empty() && !value.secret.is_empty(),
            "Alpaca connection is incomplete"
        );
        return Ok((value.key, value.secret));
    }
    let key = std::env::var("ALPACA_API_KEY").unwrap_or_default();
    let secret = std::env::var("ALPACA_API_SECRET").unwrap_or_default();
    ensure!(
        !key.trim().is_empty() && !secret.trim().is_empty(),
        "Connect your Alpaca account in Data connections, or configure ALPACA_API_KEY and ALPACA_API_SECRET on this server"
    );
    Ok((key, secret))
}

pub async fn alpaca_configured(app: &App) -> bool {
    alpaca_credentials(app).await.is_ok()
}

fn supplied(p: &Value) -> anyhow::Result<AlpacaCredentials> {
    let key = p["apiKey"].as_str().unwrap_or("").trim();
    let secret = p["apiSecret"].as_str().unwrap_or("").trim();
    ensure!(
        (8..=256).contains(&key.len()) && (8..=512).contains(&secret.len()),
        "Enter both the API key and secret"
    );
    ensure!(
        key.is_ascii()
            && secret.is_ascii()
            && !key.chars().any(char::is_whitespace)
            && !secret.chars().any(char::is_whitespace),
        "Credentials must not contain whitespace"
    );
    Ok(AlpacaCredentials {
        key: key.into(),
        secret: secret.into(),
    })
}

fn save_private(path: &std::path::Path, value: &AlpacaCredentials) -> anyhow::Result<()> {
    let parent = path.parent().context("Connection directory is missing")?;
    std::fs::create_dir_all(parent)?;
    ensure!(
        !std::fs::symlink_metadata(parent)?.file_type().is_symlink(),
        "Connection directory cannot be a symbolic link"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> anyhow::Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    let _account_guard = if ["connections.save", "connections.remove"].contains(&method) {
        Some(ACCOUNT_CHANGE.lock().await)
    } else {
        None
    };
    if _account_guard.is_some() {
        let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM broker_orders WHERE state NOT IN ('filled','canceled','expired','rejected','replaced')").fetch_one(&app.db).await?;
        ensure!(
            pending == 0,
            "Resolve or cancel outstanding broker orders before changing account credentials"
        );
    }
    match method {
        "connections.list" => {
            let stored = credential_path(app).await?.is_file();
            Ok(json!({"localOnly":true,"providers":[
                {"id":"yahoo","name":"US stocks & ETFs","requiresKey":false,"configured":true,"cost":"No Tickgrove fee","kind":"public-reference","description":"Historical charts and public reference quotes. Source coverage and delay vary."},
                {"id":"coinbase","name":"Crypto · Coinbase","requiresKey":false,"configured":true,"cost":"No Tickgrove fee","kind":"exchange","description":"This exchange's supported pairs, historical candles and live market events."},
                {"id":"alpaca","name":"Alpaca · your account","requiresKey":true,"configured":alpaca_configured(app).await,"credentialsSource":if stored{"server-private-file"}else{"server-environment"},"kind":"account","description":"Optional personal data and Paper broker connection. Free IEX access and other feeds depend on your account."}
            ]}))
        }
        "connections.save" => {
            ensure!(
                p["provider"] == "alpaca",
                "This provider does not need saved credentials"
            );
            let value = supplied(p)?;
            crate::market::disconnect_provider(
                app,
                "alpaca",
                "Account connection changed; reconnect charts and review source-bound strategies",
            )
            .await?;
            save_private(&credential_path(app).await?, &value)?;
            Ok(
                json!({"provider":"alpaca","configured":true,"verified":false,"credentialsReturned":false}),
            )
        }
        "connections.remove" => {
            ensure!(
                p["provider"] == "alpaca",
                "Only saved account connections can be removed"
            );
            let path = credential_path(app).await?;
            crate::market::disconnect_provider(
                app,
                "alpaca",
                "Account connection removed; reconnect charts and review source-bound strategies",
            )
            .await?;
            if path.exists() {
                std::fs::remove_file(path)?;
            }
            Ok(
                json!({"provider":"alpaca","configured":alpaca_configured(app).await,"environmentMayRemain":true}),
            )
        }
        "connections.test" => {
            let provider = p["provider"].as_str().unwrap_or("");
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()?;
            let start = std::time::Instant::now();
            let request = match provider {
                "yahoo" => client
                    .get("https://query1.finance.yahoo.com/v8/finance/chart/SPY")
                    .header("User-Agent", "Tickgrove/0.1")
                    .query(&[("interval", "1d"), ("range", "5d")]),
                "coinbase" => client
                    .get("https://api.exchange.coinbase.com/products/BTC-USD/ticker")
                    .header("User-Agent", "Tickgrove/0.1"),
                "alpaca" => {
                    let (key, secret) = if p.get("apiKey").is_some() || p.get("apiSecret").is_some()
                    {
                        let value = supplied(p)?;
                        (value.key, value.secret)
                    } else {
                        alpaca_credentials(app).await?
                    };
                    let feed = p["feed"].as_str().unwrap_or("iex");
                    ensure!(
                        ["iex", "sip", "boats", "overnight"].contains(&feed),
                        "Unknown Alpaca feed"
                    );
                    client
                        .get("https://data.alpaca.markets/v2/stocks/SPY/quotes/latest")
                        .query(&[("feed", feed)])
                        .header("APCA-API-KEY-ID", key)
                        .header("APCA-API-SECRET-KEY", secret)
                }
                _ => anyhow::bail!("Unknown data provider"),
            };
            let response = request.send().await.map_err(|_| anyhow::anyhow!("The source could not be reached. Check this server's internet connection and try again."))?;
            let status = response.status();
            ensure!(
                status.is_success(),
                "Connection test returned HTTP {}. Check credentials, source availability and feed permissions.",
                status.as_u16()
            );
            let value: Value = response
                .json()
                .await
                .map_err(|_| anyhow::anyhow!("The source returned an unexpected response"))?;
            let available = match provider {
                "yahoo" => value["chart"]["result"][0]["timestamp"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty()),
                "coinbase" => value["price"].is_string(),
                _ => value["quote"].is_object(),
            };
            Ok(
                json!({"provider":provider,"reachable":true,"requestAccepted":true,"sampleAvailable":available,"feed":p.get("feed"),"latencyMs":start.elapsed().as_millis(),"streamVerified":false,"testedAt":chrono::Utc::now().to_rfc3339(),"note":"This checks one read-only request. Live stream status is shown on the chart; other feeds retain their own permissions."}),
            )
        }
        _ => anyhow::bail!("Unknown connection command"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn saved_credentials_are_private_redacted_and_permission_scoped() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "tickgrove-connection-test-{}",
            uuid::Uuid::new_v4()
        ));
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "test-only-owner-token".into(),
            root: root.clone(),
            node: "/usr/bin/node".into(),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let input = json!({"provider":"alpaca","apiKey":"TEST-KEY-NOT-VALID","apiSecret":"TEST-SECRET-NOT-VALID"});
        let saved = execute(&app, "connections.save", &input).await?;
        assert_eq!(saved["verified"], false);
        assert!(!saved.to_string().contains("TEST-"));
        assert_eq!(alpaca_credentials(&app).await?.0, "TEST-KEY-NOT-VALID");
        let list = execute(&app, "connections.list", &json!({})).await?;
        assert!(!list.to_string().contains("TEST-"));
        assert_eq!(
            list["providers"][2]["credentialsSource"],
            "server-private-file"
        );
        let path = credential_path(&app).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)?.permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())?
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        for method in ["connections.save", "connections.remove", "connections.test"] {
            assert_eq!(crate::auth::permission(method), "connections.manage");
        }
        assert_eq!(crate::auth::permission("connections.list"), "read");
        let invalid = execute(&app, "connections.save", &json!({"provider":"alpaca","apiKey":"invalid secret","apiSecret":"TEST-SECRET-NOT-VALID"})).await.unwrap_err();
        assert!(!invalid.to_string().contains("TEST-"));
        assert_eq!(alpaca_credentials(&app).await?.0, "TEST-KEY-NOT-VALID");
        sqlx::query("INSERT INTO broker_orders(client_order_id,request,state) VALUES('unresolved','{}','unknown')").execute(&app.db).await?;
        assert!(
            execute(&app, "connections.remove", &json!({"provider":"alpaca"}))
                .await
                .unwrap_err()
                .to_string()
                .contains("outstanding broker orders")
        );
        assert!(path.exists());
        sqlx::query("UPDATE broker_orders SET state='canceled'")
            .execute(&app.db)
            .await?;
        execute(&app, "connections.remove", &json!({"provider":"alpaca"})).await?;
        assert!(!path.exists());
        app.db.close().await;
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
