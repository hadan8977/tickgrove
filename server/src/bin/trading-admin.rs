//! Offline administration. Backup reads a consistent SQLite snapshot while the
//! service may be running; restore always requires a new, empty destination.
use anyhow::{Context, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, time::Duration};

fn private(path: &Path, directory: bool) -> anyhow::Result<()> {
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }))?;
    }
    Ok(())
}
fn digest(path: &Path) -> anyhow::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop { let count = file.read(&mut buffer)?; if count == 0 { break; } hash.update(&buffer[..count]); }
    Ok(format!("{:x}", hash.finalize()))
}
fn option(args: &[String], flag: &str) -> anyhow::Result<PathBuf> {
    let index = args.iter().position(|s| s == flag).with_context(|| format!("Missing {flag}"))?;
    Ok(PathBuf::from(args.get(index + 1).filter(|s| !s.starts_with("--")).with_context(|| format!("Missing value for {flag}"))?))
}
async fn open(path: &Path) -> anyhow::Result<SqliteConnection> {
    ensure!(path.is_file(), "Database does not exist: {}", path.display());
    SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).create_if_missing(false).read_only(true).busy_timeout(Duration::from_secs(15))).await.map_err(Into::into)
}
fn create_destination(path: &Path) -> anyhow::Result<PathBuf> {
    if path.exists() { ensure!(path.is_dir() && fs::read_dir(path)?.next().is_none(), "Destination must be a new or empty directory"); }
    else { fs::create_dir_all(path)?; }
    private(path, true)?;
    Ok(path.canonicalize()?)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("backup") => {
            let source = option(&args, "--data-dir")?.canonicalize()?;
            let mut connection = open(&source.join("trading.sqlite")).await?;
            let destination = create_destination(&option(&args, "--output")?)?;
            let database = destination.join("trading.sqlite");
            sqlx::query("VACUUM INTO ?").bind(database.to_str().context("Non-UTF8 destination")?).execute(&mut connection).await?;
            connection.close().await?;
            private(&database, false)?;
            let token_included = source.join("auth-token").is_file();
            if token_included { fs::copy(source.join("auth-token"), destination.join("auth-token"))?; private(&destination.join("auth-token"), false)?; }
            let manifest = json!({"schema":"trading.backup.v1","createdAt":chrono::Utc::now().to_rfc3339(),"databaseSha256":digest(&database)?,"tokenIncluded":token_included,"externalCredentialsIncluded":false});
            let mut file = fs::File::create(destination.join("manifest.json"))?;
            file.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
            file.sync_all()?;
            private(&destination.join("manifest.json"), false)?;
            println!("{}", json!({"ok":true,"backup":destination,"databaseSha256":manifest["databaseSha256"]}));
        }
        Some("restore") => {
            let source = option(&args, "--input")?.canonicalize()?;
            let manifest: Value = serde_json::from_slice(&fs::read(source.join("manifest.json"))?)?;
            ensure!(manifest["schema"] == "trading.backup.v1", "Unsupported backup manifest");
            ensure!(manifest["databaseSha256"].as_str() == Some(&digest(&source.join("trading.sqlite"))?), "Backup checksum mismatch");
            let mut verify = open(&source.join("trading.sqlite")).await?;
            let result: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut verify).await?;
            ensure!(result == "ok", "Backup integrity check failed: {result}");
            verify.close().await?;
            let destination = create_destination(&option(&args, "--data-dir")?)?;
            fs::copy(source.join("trading.sqlite"), destination.join("trading.sqlite"))?;
            private(&destination.join("trading.sqlite"), false)?;
            if manifest["tokenIncluded"] == true { fs::copy(source.join("auth-token"), destination.join("auth-token"))?; private(&destination.join("auth-token"), false)?; }
            println!("{}", json!({"ok":true,"restored":destination,"next":"Start trading-service with TRADING_DATA_DIR pointing to this directory; external credentials must be configured separately"}));
        }
        _ => anyhow::bail!("Usage: trading-admin backup --data-dir DIR --output NEW_DIR\n       trading-admin restore --input BACKUP_DIR --data-dir NEW_DIR"),
    }
    Ok(())
}
