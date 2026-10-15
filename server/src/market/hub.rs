//! One upstream socket per database/provider/credential-profile/feed.
//! A slow consumer receives an explicit Lagged error; trade loss is never silent.
use super::*;
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        Arc, LazyLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, broadcast};
use tokio_tungstenite::tungstenite::Message;
#[derive(Clone, Debug)]
pub enum HubEvent {
    Data(Value),
    Connected,
    Disconnected(String),
}
struct Hub {
    provider: String,
    feed: String,
    tx: broadcast::Sender<HubEvent>,
    connected: AtomicBool,
}
static HUBS: LazyLock<Mutex<HashMap<String, Weak<Hub>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn alpaca_url(feed: &str) -> anyhow::Result<String> {
    let version = match feed {
        "iex" | "sip" => "v2",
        "boats" | "overnight" => "v1beta1",
        _ => anyhow::bail!("Unsupported Alpaca stream feed"),
    };
    Ok(format!("wss://stream.data.alpaca.markets/{version}/{feed}"))
}
async fn credential_key(app: &App, provider: &str) -> anyhow::Result<String> {
    if provider != "alpaca" {
        return Ok(String::new());
    }
    let (k, s) = crate::connections::alpaca_credentials(app).await?;
    Ok(crate::commands::hash(&format!("{k}:{s}")))
}
pub async fn subscribe(
    app: &App,
    provider: &str,
    feed: &str,
) -> anyhow::Result<(broadcast::Receiver<HubEvent>, bool)> {
    subscribe_at(app, provider, feed, endpoint(provider, feed)?).await
}
async fn subscribe_at(
    app: &App,
    provider: &str,
    feed: &str,
    url: String,
) -> anyhow::Result<(broadcast::Receiver<HubEvent>, bool)> {
    let credential = credential_key(app, provider).await?;
    let key = format!(
        "{:p}:{provider}:{feed}:{credential}:{url}",
        Arc::as_ptr(&app.db.connect_options())
    );
    let mut hubs = HUBS.lock().await;
    if let Some(hub) = hubs.get(&key).and_then(Weak::upgrade) {
        return Ok((hub.tx.subscribe(), hub.connected.load(Ordering::SeqCst)));
    }
    hubs.retain(|_, v| v.strong_count() > 0);
    let (tx, rx) = broadcast::channel(16384);
    let hub = Arc::new(Hub {
        provider: provider.into(),
        feed: feed.into(),
        tx,
        connected: AtomicBool::new(false),
    });
    hubs.insert(key, Arc::downgrade(&hub));
    let app = app.clone();
    let provider = provider.to_string();
    let feed = feed.to_string();
    tokio::spawn(async move {
        run(app, provider, feed, credential, hub, url).await;
    });
    Ok((rx, false))
}
pub async fn info(app: &App) -> Value {
    let prefix = format!("{:p}:", Arc::as_ptr(&app.db.connect_options()));
    let hubs = HUBS.lock().await;
    json!(hubs.iter().filter(|(key,_)|key.starts_with(&prefix)).filter_map(|(_,weak)|weak.upgrade()).map(|h|json!({"provider":h.provider,"feed":h.feed,"connected":h.connected.load(Ordering::SeqCst),"consumers":h.tx.receiver_count(),"maxConnections":1,"overflowPolicy":"explicit consumer gap"})).collect::<Vec<_>>())
}
async fn symbols(app: &App, provider: &str, feed: &str) -> anyhow::Result<BTreeSet<String>> {
    Ok(sqlx::query_scalar::<_,String>("SELECT DISTINCT symbol FROM market_subscriptions WHERE provider=? AND feed=? AND desired=1")
        .bind(provider).bind(feed).fetch_all(&app.db).await?.into_iter().collect())
}
fn subscription(provider: &str, action: &str, symbols: &BTreeSet<String>) -> Value {
    match provider {
        "coinbase" => {
            json!({"type":action,"product_ids":symbols,"channels":["ticker","matches","heartbeat"]})
        }
        "yahoo" => json!({action:symbols}),
        _ => {
            json!({"action":action,"quotes":symbols,"trades":symbols,"bars":symbols,"updatedBars":symbols})
        }
    }
}
fn endpoint(provider: &str, feed: &str) -> anyhow::Result<String> {
    let (name, default) = match provider {
        "coinbase" => (
            "TRADING_COINBASE_WS_MOCK",
            "wss://ws-feed.exchange.coinbase.com".to_string(),
        ),
        "yahoo" => (
            "TRADING_YAHOO_WS_MOCK",
            "wss://streamer.finance.yahoo.com/?version=2".to_string(),
        ),
        "alpaca" => ("TRADING_ALPACA_WS_MOCK", alpaca_url(feed)?),
        _ => anyhow::bail!("Unsupported stream provider"),
    };
    if let Ok(url) = std::env::var(name) {
        let parsed = reqwest::Url::parse(&url)?;
        anyhow::ensure!(
            parsed.scheme() == "ws"
                && ["127.0.0.1", "localhost"].contains(&parsed.host_str().unwrap_or("")),
            "Websocket mock must be loopback"
        );
        return Ok(url);
    }
    Ok(default)
}
async fn run(
    app: App,
    provider: String,
    feed: String,
    credential: String,
    hub: Arc<Hub>,
    url: String,
) {
    let mut delay = 1u64;
    loop {
        if hub.tx.receiver_count() == 0
            || symbols(&app, &provider, &feed)
                .await
                .map(|s| s.is_empty())
                .unwrap_or(true)
        {
            break;
        }
        let result = connection(&app, &provider, &feed, &credential, &hub, &url).await;
        hub.connected.store(false, Ordering::SeqCst);
        let reason = match result {
            Ok(()) => break,
            Err(e) => e.to_string(),
        };
        let _ = hub.tx.send(HubEvent::Disconnected(reason.clone()));
        if reason == "Credential profile changed" {
            break;
        }
        // Permission errors are not hammered. A newly saved profile gets a new hub key.
        let wait = if reason.contains("auth") || reason.contains("entitlement") {
            60
        } else {
            delay
        };
        tokio::time::sleep(Duration::from_secs(wait)).await;
        delay = (delay * 2).min(30);
    }
}
async fn connection(
    app: &App,
    provider: &str,
    feed: &str,
    credential: &str,
    hub: &Hub,
    url: &str,
) -> anyhow::Result<()> {
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(url),
    )
    .await??;
    let mut active = BTreeSet::new();
    let mut authenticated = provider != "alpaca";
    if provider == "alpaca" {
        let (key, secret) = crate::connections::alpaca_credentials(app).await?;
        socket
            .send(Message::Text(
                json!({"action":"auth","key":key,"secret":secret})
                    .to_string()
                    .into(),
            ))
            .await?;
    }
    let mut poll = tokio::time::interval(Duration::from_secs(1));
    let mut heartbeat = tokio::time::Instant::now();
    let mut keepalive = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _=poll.tick()=>{
                let wanted=symbols(app,provider,feed).await?;
                if wanted.is_empty()||hub.tx.receiver_count()==0{let _=socket.close(None).await;return Ok(())}
                if provider=="alpaca" && credential_key(app,provider).await?!=credential{anyhow::bail!("Credential profile changed")}
                if provider=="coinbase" && heartbeat.elapsed()>Duration::from_secs(20){anyhow::bail!("Provider heartbeat timeout")}
                if !authenticated && heartbeat.elapsed()>Duration::from_secs(15){anyhow::bail!("Provider authentication timeout")}
                if authenticated{
                    let added=wanted.difference(&active).cloned().collect::<BTreeSet<_>>();let removed=active.difference(&wanted).cloned().collect::<BTreeSet<_>>();
                    if !removed.is_empty(){socket.send(Message::Text(subscription(provider,"unsubscribe",&removed).to_string().into())).await?;}
                    if !added.is_empty(){socket.send(Message::Text(subscription(provider,"subscribe",&added).to_string().into())).await?;}
                    if provider=="yahoo" && keepalive.elapsed()>Duration::from_secs(15){socket.send(Message::Text(subscription(provider,"subscribe",&wanted).to_string().into())).await?;keepalive=tokio::time::Instant::now();}
                    active=wanted;
                    if provider=="yahoo" && !hub.connected.swap(true,Ordering::SeqCst){let _=hub.tx.send(HubEvent::Connected);}
                }
            }
            message=socket.next()=>{
                let message=message.ok_or_else(||anyhow::anyhow!("Provider websocket closed"))??;heartbeat=tokio::time::Instant::now();
                if matches!(&message,Message::Close(_)){anyhow::bail!("Provider requested websocket close")}
                if let Message::Ping(p)=message{socket.send(Message::Pong(p)).await?;continue}
                let Message::Text(text)=message else{continue};
                let raw:Value=serde_json::from_str(text.as_str())?;
                if provider=="alpaca"{
                    for value in raw.as_array().ok_or_else(||anyhow::anyhow!("Invalid Alpaca envelope"))?{
                        match value["T"].as_str().unwrap_or(""){
                            "error"=>anyhow::bail!("Alpaca entitlement/auth error {}: {}",value["code"],value["msg"]),
                            "success" if value["msg"]=="authenticated"=>{authenticated=true;},
                            "subscription"=>{hub.connected.store(true,Ordering::SeqCst);let _=hub.tx.send(HubEvent::Connected);},
                            "q"|"t"|"b"|"u"|"c"|"x"|"s"|"l"=>{anyhow::ensure!(authenticated,"Alpaca data before authentication");let _=hub.tx.send(HubEvent::Data(value.clone()));},
                            _=>{}
                        }
                    }
                }else if provider=="coinbase"{
                    if raw["type"]=="error"{anyhow::bail!("Coinbase stream error: {}",raw["message"])}
                    if raw["type"]=="subscriptions"||raw["type"]=="heartbeat"{if !hub.connected.swap(true,Ordering::SeqCst){let _=hub.tx.send(HubEvent::Connected);}}
                    let _=hub.tx.send(HubEvent::Data(raw));
                }else{
                    let encoded=raw["message"].as_str().unwrap_or(text.as_str());let mut quote=super::yahoo_proto::decode(encoded)?;
                    quote["provider"]=json!("yahoo");quote["kind"]=json!("public-pricing-websocket; exchange delay not guaranteed");quote["receivedAt"]=json!(now());
                    let _=hub.tx.send(HubEvent::Data(quote));
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_and_multi_symbol_requests() {
        assert!(alpaca_url("boats").unwrap().ends_with("v1beta1/boats"));
        assert!(alpaca_url("sip").unwrap().ends_with("v2/sip"));
        assert!(alpaca_url("invalid").is_err());
        let symbols = BTreeSet::from(["AAPL".into(), "MSFT".into()]);
        assert_eq!(
            subscription("alpaca", "subscribe", &symbols)["trades"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            subscription("yahoo", "unsubscribe", &symbols)["unsubscribe"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[tokio::test]
    async fn one_socket_fans_out_and_removes_only_unused_symbols() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "isolated-hub-test".into(),
            root: "..".into(),
            node: "/usr/bin/node".into(),
            execution_budget: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        for (id, symbol, tf) in [
            ("a", "BTC-USD", "1m"),
            ("b", "BTC-USD", "1H"),
            ("c", "ETH-USD", "1m"),
        ] {
            sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES(?,'coinbase',?,?,?,'connecting','public-websocket')")
                .bind(id).bind(symbol).bind(tf).bind("{}").execute(&app.db).await?;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("ws://{}", listener.local_addr()?);
        let (mut first, _) =
            subscribe_at(&app, "coinbase", "public-websocket", url.clone()).await?;
        let (mut second, _) = subscribe_at(&app, "coinbase", "public-websocket", url).await?;
        let (tcp, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept()).await??;
        let mut socket = tokio_tungstenite::accept_async(tcp).await?;
        let subscribe = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await?
            .unwrap()?;
        let request: Value = serde_json::from_str(subscribe.to_text()?)?;
        assert_eq!(request["product_ids"], json!(["BTC-USD", "ETH-USD"]));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "one upstream connection for multiple consumers"
        );
        socket
            .send(Message::Text(
                json!({"type":"ticker","product_id":"BTC-USD","price":"100"})
                    .to_string()
                    .into(),
            ))
            .await?;
        for rx in [&mut first, &mut second] {
            let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .map_err(|_| anyhow::anyhow!("fanout receive deadline"))??;
            assert!(matches!(event,HubEvent::Data(v) if v["price"]=="100"));
        }
        sqlx::query("UPDATE market_subscriptions SET desired=0 WHERE id='a'")
            .execute(&app.db)
            .await?;
        assert!(
            tokio::time::timeout(Duration::from_millis(1200), socket.next())
                .await
                .is_err(),
            "second timeframe keeps BTC subscribed"
        );
        sqlx::query("UPDATE market_subscriptions SET desired=0 WHERE id='b'")
            .execute(&app.db)
            .await?;
        let removed = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await?
            .unwrap()?;
        let removed: Value = serde_json::from_str(removed.to_text()?)?;
        assert_eq!(removed["type"], "unsubscribe");
        assert_eq!(removed["product_ids"], json!(["BTC-USD"]));
        // Reconnect restores the persisted union, not the original chart list.
        socket.close(None).await?;
        let (tcp, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .map_err(|_| anyhow::anyhow!("reconnect accept deadline"))??;
        let mut resumed = tokio_tungstenite::accept_async(tcp).await?;
        let message = tokio::time::timeout(Duration::from_secs(3), resumed.next())
            .await
            .map_err(|_| anyhow::anyhow!("reconnect subscribe deadline"))?
            .unwrap()?;
        let request: Value = serde_json::from_str(message.to_text()?)?;
        assert_eq!(request["product_ids"], json!(["ETH-USD"]));
        resumed
            .send(Message::Text(
                json!({"type":"ticker","product_id":"ETH-USD","price":"200"})
                    .to_string()
                    .into(),
            ))
            .await?;
        for rx in [&mut first, &mut second] {
            let mut delivered = false;
            for _ in 0..3 {
                let event = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await??;
                if matches!(event,HubEvent::Data(v) if v["price"]=="200") {
                    delivered = true;
                    break;
                }
            }
            assert!(
                delivered,
                "reconnected source fans out to all remaining consumers"
            );
        }
        sqlx::query("UPDATE market_subscriptions SET desired=0")
            .execute(&app.db)
            .await?;
        drop(first);
        drop(second);
        Ok(())
    }
}
