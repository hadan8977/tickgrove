//! Shared provider HTTP transport. Rate budgets apply across history, discovery and repair.
use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};
type Cached = Arc<Mutex<Option<(Instant, Value)>>>;
static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Tickgrove/0.3 self-hosted research")
        .build()
        .map_err(|e| e.to_string())
});
static REQUESTS: LazyLock<Mutex<HashMap<String, Cached>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SCHEDULE: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn client() -> anyhow::Result<reqwest::Client> {
    CLIENT
        .as_ref()
        .map(Clone::clone)
        .map_err(|e| anyhow::anyhow!(e.clone()))
}
fn scope(url: &str, headers: Option<(&str, &str)>) -> (String, u64) {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default();
    let (name, millis) = if host.ends_with("coinbase.com") {
        ("coinbase", 110)
    } else if host.ends_with("alpaca.markets") {
        ("alpaca", 310)
    } else {
        ("yahoo", 250)
    };
    (
        format!(
            "{name}:{}",
            headers
                .map(|(k, s)| crate::commands::hash(&format!("{k}:{s}")))
                .unwrap_or_default()
        ),
        millis,
    )
}
async fn budget(url: &str, headers: Option<(&str, &str)>) {
    let (scope, millis) = scope(url, headers);
    let at = {
        let mut slots = SCHEDULE.lock().await;
        let now = Instant::now();
        let at = slots.get(&scope).copied().unwrap_or(now).max(now);
        slots.insert(scope, at + Duration::from_millis(millis));
        at
    };
    tokio::time::sleep_until(at).await;
}
pub async fn get(
    url: &str,
    query: &[(String, String)],
    headers: Option<(&str, &str)>,
    ttl: u64,
) -> anyhow::Result<Value> {
    let mut query = query.to_vec();
    query.sort();
    let key = crate::commands::hash(&format!("{}|{}|{:?}", scope(url, headers).0, url, query));
    let slot = {
        let mut slots = REQUESTS.lock().await;
        if slots.len() > 512 {
            slots.retain(|_, v| Arc::strong_count(v) > 1);
        }
        slots
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let mut cached = slot.lock().await;
    if let Some((until, value)) = &*cached {
        if *until > Instant::now() {
            return Ok(value.clone());
        }
    }
    let mut attempt = 0;
    loop {
        budget(url, headers).await;
        let mut request = client()?.get(url).query(&query);
        if let Some((key, secret)) = headers {
            request = request
                .header("APCA-API-KEY-ID", key)
                .header("APCA-API-SECRET-KEY", secret);
        }
        let response = request.send().await?;
        let code = response.status();
        if (code.as_u16() == 429 || code.is_server_error()) && attempt < 3 {
            let delay = response
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(1 << attempt)
                .clamp(1, 20);
            attempt += 1;
            tokio::time::sleep(Duration::from_secs(delay)).await;
            continue;
        }
        anyhow::ensure!(
            code.is_success(),
            "{} provider HTTP {}{}",
            scope(url, headers).0.split(':').next().unwrap_or("market"),
            code,
            if code.as_u16() == 401 || code.as_u16() == 403 {
                "; check your connection and data entitlement"
            } else {
                ""
            }
        );
        let value: Value = response.json().await?;
        // Even uncached requests coalesce concurrent consumers for one second.
        *cached = Some((
            Instant::now() + Duration::from_secs(ttl.max(1)),
            value.clone(),
        ));
        return Ok(value);
    }
}
