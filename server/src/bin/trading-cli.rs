//! Native Rust client for the same authenticated command endpoint as Web/MCP.
use anyhow::{Context, ensure};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let method = args.first().context("Usage: trading-cli METHOD [PARAMS.json | JSON] [--key IDEMPOTENCY_KEY]")?;
    let input = args.get(1).filter(|s| !s.starts_with("--")).map(String::as_str).unwrap_or("{}");
    let params: Value = if Path::new(input).is_file() { serde_json::from_slice(&fs::read(input)?)? } else { serde_json::from_str(input)? };
    ensure!(params.is_object(), "Command parameters must be a JSON object");
    let key = match args.iter().position(|a| a == "--key") { Some(index) => Some(args.get(index + 1).context("Missing idempotency key")?), None => None };
    let token = match std::env::var("TRADING_TOKEN") { Ok(value) => value, Err(_) => fs::read_to_string(std::env::var("TRADING_TOKEN_FILE").unwrap_or("var/auth-token".into()))? };
    ensure!(token.trim().len() >= 24, "Instance token is missing or invalid");
    let base = std::env::var("TRADING_URL").unwrap_or("http://127.0.0.1:8787".into());
    let response = reqwest::Client::builder().timeout(Duration::from_secs(120)).build()?.post(format!("{}/api/command", base.trim_end_matches('/'))).bearer_auth(token.trim()).json(&json!({"method":method,"params":params,"idempotency_key":key})).send().await?;
    let status = response.status();
    let result: Value = response.json().await.context("Service did not return JSON")?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    if !status.is_success() { std::process::exit(1); }
    Ok(())
}
