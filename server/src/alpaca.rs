use crate::{
    App,
    commands::{hash, required},
};
use serde_json::{Value, json};
use sqlx::Row;
fn config() -> anyhow::Result<(String, String)> {
    Ok((
        std::env::var("ALPACA_API_KEY")
            .map_err(|_| anyhow::anyhow!("Alpaca Paper credentials not configured"))?,
        std::env::var("ALPACA_API_SECRET")
            .map_err(|_| anyhow::anyhow!("Alpaca Paper credentials not configured"))?,
    ))
}
fn client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?)
}
fn paper_base() -> anyhow::Result<String> {
    if let Ok(value) = std::env::var("TRADING_ALPACA_MOCK_URL") {
        let url = reqwest::Url::parse(&value)?;
        anyhow::ensure!(
            url.scheme() == "http"
                && ["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or("")),
            "Mock venue must be loopback HTTP"
        );
        return Ok(value.trim_end_matches('/').to_string());
    }
    Ok("https://paper-api.alpaca.markets/v2".into())
}
#[derive(Debug)]
struct VenueFailure {
    status: u16,
    body: Value,
}
impl std::fmt::Display for VenueFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Alpaca Paper response {}: {}", self.status, self.body)
    }
}
impl std::error::Error for VenueFailure {}
async fn request(
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> anyhow::Result<Value> {
    let (key, secret) = config()?;
    let mut r = client()?
        .request(method, format!("{}/{path}", paper_base()?))
        .header("APCA-API-KEY-ID", key)
        .header("APCA-API-SECRET-KEY", secret);
    if let Some(body) = body {
        r = r.json(body)
    }
    let response = r.send().await?;
    let status = response.status();
    let value: Value = response.json().await?;
    if !status.is_success() {
        return Err(anyhow::Error::new(VenueFailure {
            status: status.as_u16(),
            body: value,
        }));
    }
    Ok(value)
}
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "alpaca.config" => Ok(
            json!({"configured":config().is_ok(),"ordersEndpoint":"https://paper-api.alpaca.markets/v2","marketDataEndpoint":"https://data.alpaca.markets/v2","liveTrading":false,"credentialsSource":"server environment","networkVerified":false}),
        ),
        "orders.list" => {
            let rows=sqlx::query("SELECT client_order_id,state,error,updated_at FROM broker_orders ORDER BY rowid DESC LIMIT 100").fetch_all(&app.db).await?;
            Ok(json!(rows.iter().map(|r|json!({"client_order_id":r.get::<String,_>("client_order_id"),"state":r.get::<String,_>("state"),"error":r.get::<Option<String>,_>("error"),"updated_at":r.get::<String,_>("updated_at")})).collect::<Vec<_>>()))
        }
        "orders.status" => {
            let r = sqlx::query("SELECT * FROM broker_orders WHERE client_order_id=?")
                .bind(required(p, "client_order_id")?)
                .fetch_one(&app.db)
                .await?;
            Ok(
                json!({"state":r.get::<String,_>("state"),"request":serde_json::from_str::<Value>(&r.get::<String,_>("request"))?,"remote":r.get::<Option<String>,_>("remote_order").and_then(|s|serde_json::from_str::<Value>(&s).ok()),"error":r.get::<Option<String>,_>("error")}),
            )
        }
        "orders.events" => {
            let rows=sqlx::query("SELECT cursor,client_order_id,state,payload FROM broker_events WHERE cursor>? ORDER BY cursor LIMIT 1000").bind(p["cursor"].as_i64().unwrap_or(0)).fetch_all(&app.db).await?;
            Ok(json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("cursor"),"client_order_id":r.get::<String,_>("client_order_id"),"state":r.get::<String,_>("state"),"payload":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap_or(Value::Null)})).collect::<Vec<_>>()))
        }
        "orders.preview" => {
            validate_order(p)?;
            Ok(json!({"request":p,"venue":"alpaca-paper","notSubmitted":true}))
        }
        "orders.submit" => {
            validate_order(p)?;
            let id = required(p, "client_order_id")?;
            config()?;
            let payload = p.to_string();
            let mut reserve = app.db.begin().await?;
            if let Some(row) = sqlx::query("SELECT * FROM broker_orders WHERE client_order_id=?")
                .bind(id)
                .fetch_optional(&mut *reserve)
                .await?
            {
                anyhow::ensure!(
                    hash(&row.get::<String, _>("request")) == hash(&payload),
                    "Client order id conflict"
                );
                return Ok(
                    json!({"state":row.get::<String,_>("state"),"remote":row.get::<Option<String>,_>("remote_order"),"duplicate":true}),
                );
            }
            sqlx::query(
                "INSERT INTO broker_orders(client_order_id,request,state) VALUES(?,?,'submitting')",
            )
            .bind(id)
            .bind(payload)
            .execute(&mut *reserve)
            .await?;
            sqlx::query(
                "INSERT INTO broker_events(client_order_id,state,payload) VALUES(?,'submitting',?)",
            )
            .bind(id)
            .bind(p.to_string())
            .execute(&mut *reserve)
            .await?;
            reserve.commit().await?;
            match request(reqwest::Method::POST, "orders", Some(p)).await {
                Ok(order) => {
                    if let Err(error) = persist(app, id, &order).await {
                        sqlx::query("UPDATE broker_orders SET state='unknown',error=? WHERE client_order_id=?").bind(error.to_string()).bind(id).execute(&app.db).await?;
                        return Err(error);
                    }
                    Ok(order)
                }
                Err(e) => {
                    let rejected = e.downcast_ref::<VenueFailure>().is_some_and(|v| {
                        (400..500).contains(&v.status) && ![408, 429].contains(&v.status)
                    });
                    let state = if rejected { "rejected" } else { "unknown" };
                    sqlx::query("UPDATE broker_orders SET state=?,error=? WHERE client_order_id=?")
                        .bind(state)
                        .bind(e.to_string())
                        .bind(id)
                        .execute(&app.db)
                        .await?;
                    sqlx::query(
                        "INSERT INTO broker_events(client_order_id,state,payload) VALUES(?,?,?)",
                    )
                    .bind(id)
                    .bind(state)
                    .bind(json!({"error":e.to_string()}).to_string())
                    .execute(&app.db)
                    .await?;
                    if rejected {
                        anyhow::bail!("Paper order rejected: {e}")
                    } else {
                        anyhow::bail!(
                            "Submission outcome unknown; reconcile client_order_id before any retry: {e}"
                        )
                    }
                }
            }
        }
        "orders.reconcile" => {
            let id = required(p, "client_order_id")?;
            anyhow::ensure!(
                id.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "Invalid client_order_id"
            );
            let order = request(
                reqwest::Method::GET,
                &format!("orders:by_client_order_id?client_order_id={id}"),
                None,
            )
            .await?;
            persist(app, id, &order).await?;
            Ok(order)
        }
        "orders.cancel" => {
            let id = required(p, "order_id")?;
            anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "order_id must be UUID");
            let (key, secret) = config()?;
            let response = client()?
                .delete(format!("{}/orders/{id}", paper_base()?))
                .header("APCA-API-KEY-ID", key)
                .header("APCA-API-SECRET-KEY", secret)
                .send()
                .await?;
            anyhow::ensure!(
                response.status().is_success(),
                "Cancel failed: {}",
                response.status()
            );
            Ok(json!({"cancelRequested":true,"order_id":id}))
        }
        "alpaca.account" => request(reqwest::Method::GET, "account", None).await,
        "data.fetch" => {
            let symbol = required(p, "symbol")?;
            anyhow::ensure!(
                symbol
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'),
                "Invalid symbol"
            );
            let (key, secret) = config()?;
            let start = required(p, "start")?;
            let end = required(p, "end")?;
            let tf = p["timeframe"].as_str().unwrap_or("1Day");
            let response = client()?
                .get(format!(
                    "https://data.alpaca.markets/v2/stocks/{symbol}/bars"
                ))
                .header("APCA-API-KEY-ID", key)
                .header("APCA-API-SECRET-KEY", secret)
                .query(&[
                    ("start", start),
                    ("end", end),
                    ("timeframe", tf),
                    ("feed", "iex"),
                    ("adjustment", "all"),
                    ("limit", "10000"),
                ])
                .send()
                .await?;
            anyhow::ensure!(
                response.status().is_success(),
                "Market data response {}",
                response.status()
            );
            let v: Value = response.json().await?;
            anyhow::ensure!(
                v["next_page_token"].is_null(),
                "Requested data requires pagination; reduce interval to avoid truncation"
            );
            Ok(
                json!({"provider":"alpaca","feed":"iex","adjustment":"all","response":v,"importRequired":true}),
            )
        }
        _ => anyhow::bail!("Unknown Alpaca command"),
    }
}
fn validate_order(p: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        p.as_object().is_some_and(|map| map.keys().all(|key| [
            "client_order_id",
            "symbol",
            "side",
            "qty",
            "type",
            "time_in_force"
        ]
        .contains(&key.as_str()))),
        "Unsupported order parameter"
    );
    let id = required(p, "client_order_id")?;
    anyhow::ensure!(
        id.len() <= 48
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid client_order_id"
    );
    let symbol = required(p, "symbol")?;
    anyhow::ensure!(
        symbol
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'.' || b == b'-'),
        "Invalid symbol"
    );
    anyhow::ensure!(
        ["buy", "sell"].contains(&required(p, "side")?),
        "Invalid side"
    );
    anyhow::ensure!(
        p["type"] == "market" && p["time_in_force"] == "day",
        "Initial Paper adapter supports market/day only"
    );
    let qty = p["qty"]
        .as_f64()
        .or_else(|| p["qty"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.);
    anyhow::ensure!(qty > 0. && qty.is_finite(), "qty must be positive");
    Ok(())
}
async fn persist(app: &App, id: &str, order: &Value) -> anyhow::Result<()> {
    let state = order["status"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing order status"))?;
    anyhow::ensure!(
        [
            "accepted",
            "new",
            "pending_new",
            "partially_filled",
            "filled",
            "done_for_day",
            "canceled",
            "expired",
            "replaced",
            "pending_cancel",
            "pending_replace",
            "accepted_for_bidding",
            "stopped",
            "rejected",
            "suspended",
            "calculated"
        ]
        .contains(&state),
        "Unknown order status {state}"
    );
    anyhow::ensure!(
        order["client_order_id"].as_str() == Some(id),
        "Venue client_order_id mismatch"
    );
    let filled = order["filled_qty"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.);
    anyhow::ensure!(
        filled.is_finite() && filled >= 0.,
        "Invalid filled quantity"
    );
    let request: String =
        sqlx::query_scalar("SELECT request FROM broker_orders WHERE client_order_id=?")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    let request: Value = serde_json::from_str(&request)?;
    let quantity = request["qty"]
        .as_f64()
        .or_else(|| request["qty"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.);
    anyhow::ensure!(
        filled <= quantity,
        "Filled quantity exceeds submitted quantity"
    );
    anyhow::ensure!(
        state != "filled" || (filled - quantity).abs() < 1e-9,
        "Filled state has incomplete quantity"
    );
    if let Some(old) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT remote_order FROM broker_orders WHERE client_order_id=?",
    )
    .bind(id)
    .fetch_optional(&app.db)
    .await?
    .flatten()
    {
        let old: Value = serde_json::from_str(&old)?;
        let before = old["filled_qty"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.);
        anyhow::ensure!(filled >= before, "Venue fill quantity regressed");
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE broker_orders SET state=?,remote_order=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE client_order_id=?").bind(state).bind(order.to_string()).bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO broker_events(client_order_id,state,payload) VALUES(?,?,?)")
        .bind(id)
        .bind(state)
        .bind(order.to_string())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
