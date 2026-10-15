mod alpaca_wire;
mod cache;
mod calendar;
pub(crate) mod history;
mod http;
mod hub;
mod instruments;
pub(crate) mod period;
mod state;
mod stream;
mod yahoo_proto;
use crate::{App, commands::required};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bar {
    pub time: i64,
    #[serde(rename = "closeTime")]
    pub close_time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}
pub(crate) static HTTP_BUDGET: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(4));
pub fn max_subscriptions() -> i64 {
    std::env::var("TRADING_MAX_SUBSCRIPTIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(32)
        .clamp(1, 256)
}
pub(crate) fn retention(name: &str, default: i64, min: i64, max: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
        .clamp(min, max)
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn seconds(tf: &str) -> anyhow::Result<i64> {
    match tf {
        "1m" | "1" => Ok(60),
        "5m" | "5" => Ok(300),
        "15m" | "15" => Ok(900),
        "1H" | "60" => Ok(3600),
        "4H" => Ok(14400),
        "6H" | "360" => Ok(21600),
        "1W" | "W" => Ok(604800),
        "1D" | "D" => Ok(86400),
        _ => anyhow::bail!("Unsupported market timeframe {tf}"),
    }
}
pub fn identity(
    provider: &str,
    symbol: &str,
    timeframe: &str,
    feed: &str,
    adjustment: &str,
) -> anyhow::Result<Value> {
    seconds(timeframe)?;
    anyhow::ensure!(
        !symbol.is_empty()
            && symbol.len() <= 32
            && symbol.bytes().all(|b| b.is_ascii_uppercase()
                || b.is_ascii_digit()
                || b == b'-'
                || b == b'.'
                || (provider == "yahoo" && (b == b'^' || b == b'='))),
        "Invalid market symbol"
    );
    let crypto = provider == "coinbase";
    anyhow::ensure!(
        ["coinbase", "yahoo", "alpaca"].contains(&provider),
        "Unsupported market provider"
    );
    let mut meta = json!({"symbolId":format!("{}:{}",if crypto{"COINBASE"}else if provider=="yahoo"{"YAHOO:US"}else{"ALPACA:US"},symbol),"symbol":symbol,"venue":if crypto{"COINBASE"}else{"unresolved"},"currency":if crypto{symbol.rsplit('-').next().unwrap_or("unknown")}else{"USD"},"assetClass":if crypto{"crypto"}else{"unknown"},"timeframe":timeframe,"timezone":if crypto{"UTC"}else{"America/New_York"},"session":if crypto{"24x7"}else if feed=="boats"||feed=="overnight"{"overnight"}else{"regular"},"adjustment":adjustment,"provider":provider,"feed":feed,"delay":{"kind":if provider=="coinbase"{"realtime"}else if provider=="alpaca"{"unknown"}else{"delayed"},"seconds":Value::Null,"disclaimer":if provider=="yahoo"{"Unofficial Yahoo chart endpoint; personal research fallback, availability/delay not guaranteed; not an executable quote"}else if provider=="alpaca"{"Feed entitlement and venue coverage depend on dedicated account; no credential-free guarantee"}else{"Public Coinbase exchange stream; transport latency and staleness are measured separately"}}});
    apply_feed_policy(&mut meta);
    Ok(meta)
}
/// Positive policy: display-only, delayed, indicative and unknown sources cannot match orders.
pub fn execution_eligibility(identity: &Value, quality: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        identity["executionEligible"] == true
            && identity["quoteKind"] == "executable"
            && identity["delay"]["kind"] == "realtime"
            && quality["complete"] == true
            && quality["stale"] != true,
        "This source does not provide a fresh executable quote"
    );
    Ok(())
}
pub(crate) fn apply_feed_policy(meta: &mut Value) {
    let provider = meta["provider"].as_str().unwrap_or("");
    let feed = meta["feed"].as_str().unwrap_or("");
    let executable =
        provider == "coinbase" || (provider == "alpaca" && ["iex", "sip", "boats"].contains(&feed));
    let indicative = provider == "alpaca" && feed == "overnight";
    meta["executionEligible"] = json!(executable);
    meta["quoteKind"] = json!(if executable {
        "executable"
    } else if indicative {
        "indicative"
    } else {
        "display-only"
    });
    if executable || indicative {
        meta["delay"]["kind"] = json!("realtime");
    }
    if indicative {
        meta["tradeDelaySeconds"] = json!(900);
    }
}
pub async fn event(
    app: &App,
    id: &str,
    kind: &str,
    time: i64,
    payload: Value,
    complete: bool,
    reason: Option<&str>,
) -> anyhow::Result<()> {
    let mut payload = payload;
    if matches!(kind, "quote" | "trade") && payload.get("priceKind").is_none() {
        payload["priceKind"] = json!(if kind == "trade" || payload["type"] == "ticker" {
            "last-trade"
        } else {
            "reference"
        });
    }
    let mut quality = json!({"complete":complete,"stale":!complete||(matches!(kind,"quote"|"trade")&&now()-time>15000),"reason":reason});
    if kind == "bar.update" && payload["volume"].is_null() {
        quality["source"] = json!("quote-derived");
        quality["volumeKnown"] = json!(false);
    }
    let received = now();
    let inserted=sqlx::query("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES(?,?,?,?,?,?)").bind(id).bind(kind).bind(time).bind(received).bind(payload.to_string()).bind(quality.to_string()).execute(&app.db).await?;
    sqlx::query("UPDATE market_subscriptions SET last_event_at=? WHERE id=?")
        .bind(received)
        .bind(id)
        .execute(&app.db)
        .await?;
    if kind == "quote" && complete {
        let row = sqlx::query(
            "SELECT provider,symbol,status,identity FROM market_subscriptions WHERE id=?",
        )
        .bind(id)
        .fetch_one(&app.db)
        .await?;
        if row.get::<String, _>("status") == "connected" {
            let instrument: Value = serde_json::from_str(&row.get::<String, _>("identity"))?;
            if instrument["currency"] == "USD"
                && execution_eligibility(&instrument, &quality).is_ok()
            {
                crate::account::on_quote(
                    app,
                    inserted.last_insert_rowid(),
                    &row.get::<String, _>("provider"),
                    &row.get::<String, _>("symbol"),
                    instrument["feed"].as_str().unwrap_or("unknown"),
                    time,
                    received,
                    &payload,
                    &instrument,
                    &quality,
                )
                .await?;
            }
        }
    }
    prune(app, inserted.last_insert_rowid()).await?;
    Ok(())
}
pub(crate) async fn prune(app: &App, cursor: i64) -> anyhow::Result<()> {
    static BLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);
    let block = cursor / 1000;
    if BLOCK.fetch_max(block, std::sync::atomic::Ordering::Relaxed) >= block {
        return Ok(());
    }
    let cutoff = cursor - retention("TRADING_MARKET_EVENT_RETENTION", 100000, 10000, 1000000);
    if cutoff <= 0 {
        return Ok(());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE market_subscriptions SET pruned_cursor=MAX(pruned_cursor,COALESCE((SELECT MAX(cursor) FROM market_events WHERE subscription_id=market_subscriptions.id AND cursor<?),0))").bind(cutoff).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM market_events WHERE cursor<?")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "market.capabilities" => Ok(
            json!({"providers":[{"id":"coinbase","symbols":"dynamic Coinbase products registry","history":true,"stream":["ticker","matches","heartbeat"],"credentials":false},{"id":"yahoo","history":true,"stream":["public-pricing-websocket","quote-polling-60s"],"credentials":false,"fallback":true,"delay":"unknown/provider reported"},{"id":"alpaca","history":true,"stream":["quotes","trades","bars","updatedBars"],"feeds":["iex","sip","boats","overnight"],"configured":crate::connections::alpaca_configured(app).await}],"timeframes":["1m","5m","15m","1H","4H","6H","1D","1W"],"events":"persistent cursor polling (no history-as-ticks)","browserDisconnectStopsStream":false,"sessions":{"yahoo":["regular","extended"],"coinbase":["24x7"],"alpaca":["regular","extended","overnight (entitlement required)"]},"maxSubscriptions":max_subscriptions(),"retention":{"events":retention("TRADING_MARKET_EVENT_RETENTION",100000,10000,1000000),"closedBarsPerSubscription":retention("TRADING_MARKET_BAR_RETENTION",10000,1000,100000),"tradeIdsPerSubscription":retention("TRADING_MARKET_TRADE_ID_RETENTION",100000,10000,1000000)},"resourcePolicy":"1–256 local subscriptions; shared provider/feed upstream connections, with independent timeframe consumers","upstreams":hub::info(app).await,"historyPaging":true,"historyCache":{"bounded":true,"commands":["market.cacheInfo","market.cacheClear"]}}),
        ),
        "market.historyPage" => history::page(app, p).await,
        "market.cacheInfo" => cache::info(app).await,
        "market.cacheClear" => cache::clear(app).await,
        "market.search" => {
            let query = required(p, "query")?;
            anyhow::ensure!(query.len() <= 64, "Query too long");
            let selected = p["provider"].as_str();
            anyhow::ensure!(
                selected.is_none_or(|v| ["yahoo", "coinbase", "alpaca"].contains(&v)),
                "Unsupported discovery provider"
            );
            let mut symbols = Vec::new();
            if selected.is_none_or(|v| v == "yahoo") {
                let value = http::get(
                    "https://query1.finance.yahoo.com/v1/finance/search",
                    &[
                        ("q".into(), query.into()),
                        ("quotesCount".into(), "20".into()),
                        ("newsCount".into(), "0".into()),
                    ],
                    None,
                    60,
                )
                .await?;
                for q in value["quotes"].as_array().into_iter().flatten() {
                    if ["EQUITY", "ETF"].contains(&q["quoteType"].as_str().unwrap_or("")) {
                        symbols.push(json!({"symbol":q["symbol"],"symbolId":format!("YAHOO:{}:{}",q["exchange"].as_str().unwrap_or("unknown"),q["symbol"].as_str().unwrap_or("")),"venue":q["exchange"],"assetClass":q["quoteType"].as_str().unwrap_or("unknown").to_lowercase(),"name":q["shortname"],"provider":"yahoo","currency":Value::Null}));
                    }
                }
            }
            if selected == Some("alpaca") {
                let (key, secret) = crate::connections::alpaca_credentials(app).await?;
                let values = http::get(
                    "https://paper-api.alpaca.markets/v2/assets",
                    &[
                        ("status".into(), "active".into()),
                        ("asset_class".into(), "us_equity".into()),
                    ],
                    Some((&key, &secret)),
                    300,
                )
                .await?;
                for v in values
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid asset catalog"))?
                {
                    if v["symbol"]
                        .as_str()
                        .unwrap_or("")
                        .contains(&query.to_uppercase())
                        || v["name"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query.to_lowercase())
                    {
                        symbols.push(json!({"symbol":v["symbol"],"symbolId":format!("ALPACA:{}:{}",v["exchange"].as_str().unwrap_or("unknown"),v["symbol"].as_str().unwrap_or("")),"venue":v["exchange"],"assetClass":v["class"],"name":v["name"],"provider":"alpaca","currency":"USD","tradable":v["tradable"]}));
                        if symbols.len() >= 100 {
                            break;
                        }
                    }
                }
            }
            if p["provider"].as_str().is_none_or(|s| s == "coinbase") {
                for product in instruments::coinbase_products().await? {
                    if product["symbol"]
                        .as_str()
                        .unwrap_or("")
                        .contains(&query.to_uppercase())
                    {
                        symbols.push(product)
                    }
                }
            }
            symbols.truncate(100);
            Ok(json!({"symbols":symbols}))
        }
        "market.products" => Ok(
            json!({"symbols":instruments::coinbase_products().await?,"provider":"coinbase","receivedAt":now()}),
        ),
        "market.quote" => {
            let provider = p["provider"].as_str().unwrap_or("yahoo");
            let symbol = required(p, "symbol")?;
            if provider == "yahoo" {
                return stream::yahoo_quote(symbol).await;
            }
            anyhow::ensure!(
                provider == "coinbase",
                "Unsupported quote provider; Alpaca requires configured stream"
            );
            identity("coinbase", symbol, "1m", "REST-ticker", "none")?;
            let v = http::get(
                &format!("https://api.exchange.coinbase.com/products/{symbol}/ticker"),
                &[],
                None,
                1,
            )
            .await?;
            Ok(
                json!({"provider":"coinbase","symbol":symbol,"kind":"REST-ticker-snapshot","priceKind":"last-trade","eventTime":chrono::DateTime::parse_from_rfc3339(v["time"].as_str().ok_or_else(||anyhow::anyhow!("Ticker time missing"))?)?.timestamp_millis(),"receivedAt":now(),"price":v["price"].as_str().and_then(|s|s.parse::<f64>().ok()),"bid":v["bid"].as_str().and_then(|s|s.parse::<f64>().ok()),"ask":v["ask"].as_str().and_then(|s|s.parse::<f64>().ok()),"previousClose":Value::Null,"quote":v}),
            )
        }
        "market.depth" => {
            let symbol = required(p, "symbol")?;
            identity("coinbase", symbol, "1m", "REST-level2", "none")?;
            let value = http::get(
                &format!("https://api.exchange.coinbase.com/products/{symbol}/book"),
                &[("level".into(), "2".into())],
                None,
                1,
            )
            .await?;
            Ok(
                json!({"provider":"coinbase","symbol":symbol,"kind":"REST-level2-snapshot","realtimeL2":false,"receivedAt":now(),"book":value}),
            )
        }
        "market.bundle" => {
            let series = p["series"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 16)
                .ok_or_else(|| anyhow::anyhow!("series must contain 1–16 history requests"))?;
            let mut results = Vec::new();
            for request in series {
                results.push(history::fetch(app, request).await?);
            }
            let mut data = results[0]["data"].clone();
            let mut gaps = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for r in &results {
                let identity = &r["identity"];
                anyhow::ensure!(
                    seen.insert(identity["symbolId"].as_str().unwrap_or("")),
                    "Duplicate bundle instrument"
                );
                anyhow::ensure!(
                    identity["timeframe"] == results[0]["identity"]["timeframe"],
                    "Bundle requires a common timeframe"
                );
                for g in r["gaps"].as_array().into_iter().flatten() {
                    let mut gap = g.clone();
                    gap["symbol"] = identity["symbol"].clone();
                    gaps.push(gap)
                }
            }
            data["datasets"] = json!(
                results
                    .iter()
                    .skip(1)
                    .map(|r| r["data"].clone())
                    .collect::<Vec<_>>()
            );
            data["metadata"]["provenance"]["gaps"] = json!(gaps);
            data["metadata"]["provenance"]["sourceSnapshots"]=json!(results.iter().map(|r|json!({"snapshot_id":r["snapshot_id"],"hash":r["hash"],"identity":r["identity"]})).collect::<Vec<_>>());
            crate::commands::validate_data(&data)?;
            let payload = data.to_string();
            let hash = crate::commands::hash(&payload);
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES(?,?,?)")
                .bind(&id)
                .bind(payload)
                .bind(&hash)
                .execute(&app.db)
                .await?;
            Ok(
                json!({"snapshot_id":id,"hash":hash,"bars":data["bars"].as_array().unwrap().len(),"identity":results[0]["identity"],"provenance":data["metadata"]["provenance"],"gaps":gaps,"data":data}),
            )
        }
        "market.history" => history::fetch(app, p).await,
        "market.subscribe" => {
            let provider = p["provider"].as_str().unwrap_or("coinbase");
            anyhow::ensure!(
                ["coinbase", "yahoo", "alpaca"].contains(&provider),
                "Provider subscription requires a supported true stream or explicitly delayed quote polling"
            );
            let symbol = required(p, "symbol")?;
            let tf = p["timeframe"].as_str().unwrap_or("1m");
            let mut meta = identity(
                provider,
                symbol,
                tf,
                if provider == "yahoo" {
                    p["feed"].as_str().unwrap_or("public-pricing-websocket")
                } else if provider == "alpaca" {
                    p["feed"].as_str().unwrap_or("iex")
                } else {
                    "public-websocket"
                },
                "none",
            )?;
            if let Some(session) = p["session"].as_str() {
                anyhow::ensure!(
                    (provider == "yahoo" && ["regular", "extended"].contains(&session))
                        || (provider == "coinbase" && session == "24x7")
                        || (provider == "alpaca"
                            && (Some(session) == meta["session"].as_str()
                                || (meta["session"] == "regular" && session == "extended"))),
                    "Unsupported provider/session subscription"
                );
                meta["session"] = json!(session);
            }
            if let Some(row)=sqlx::query("SELECT id,identity FROM market_subscriptions WHERE provider=? AND symbol=? AND timeframe=? AND feed=? AND json_extract(identity,'$.session')=? AND desired=1").bind(provider).bind(symbol).bind(tf).bind(meta["feed"].as_str()).bind(meta["session"].as_str()).fetch_optional(&app.db).await?{
                let id:String=row.get("id");let mut existing:Value=serde_json::from_str(&row.get::<String,_>("identity"))?;apply_feed_policy(&mut existing);
                sqlx::query("UPDATE market_subscriptions SET identity=? WHERE id=?").bind(existing.to_string()).bind(&id).execute(&app.db).await?;
                return Ok(json!({"subscription_id":id,"identity":existing,"duplicate":true}));
            }
            meta = instruments::enrich(app, meta).await?;
            let mut tx = app.db.begin().await?;
            let feed = meta["feed"].as_str().unwrap();
            if let Some(row)=sqlx::query("SELECT id,identity FROM market_subscriptions WHERE provider=? AND symbol=? AND timeframe=? AND feed=? AND json_extract(identity,'$.session')=? AND desired=1").bind(provider).bind(symbol).bind(tf).bind(feed).bind(meta["session"].as_str()).fetch_optional(&mut *tx).await?{let existing:Value=serde_json::from_str(&row.get::<String,_>("identity"))?;return Ok(json!({"subscription_id":row.get::<String,_>("id"),"identity":existing,"duplicate":true}));}
            let active: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM market_subscriptions WHERE desired=1")
                    .fetch_one(&mut *tx)
                    .await?;
            anyhow::ensure!(
                active < max_subscriptions(),
                "Subscription budget reached; configure TRADING_MAX_SUBSCRIPTIONS or stop unused streams"
            );
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES(?,?,?,?,?,'connecting',?)").bind(&id).bind(provider).bind(symbol).bind(tf).bind(meta.to_string()).bind(feed).execute(&mut *tx).await?;
            tx.commit().await?;
            stream::spawn(app.clone(), id.clone());
            Ok(json!({"subscription_id":id,"identity":meta,"status":"connecting"}))
        }
        "market.stop" => {
            let id = required(p, "subscription_id")?;
            sqlx::query("UPDATE market_subscriptions SET desired=0,status='stopped' WHERE id=?")
                .bind(id)
                .execute(&app.db)
                .await?;
            Ok(json!({"stopped":true}))
        }
        "market.list" | "market.status" => {
            let rows = if let Some(id) = p["subscription_id"].as_str() {
                sqlx::query("SELECT s.*,(SELECT MAX(event_time) FROM market_events e WHERE e.subscription_id=s.id AND e.type='quote') AS quote_time,(SELECT MAX(received_at) FROM market_events e WHERE e.subscription_id=s.id AND e.type='quote') AS quote_received FROM market_subscriptions s WHERE s.id=?")
                    .bind(id)
                    .fetch_all(&app.db)
                    .await?
            } else {
                sqlx::query("SELECT s.*,(SELECT MAX(event_time) FROM market_events e WHERE e.subscription_id=s.id AND e.type='quote') AS quote_time,(SELECT MAX(received_at) FROM market_events e WHERE e.subscription_id=s.id AND e.type='quote') AS quote_received FROM market_subscriptions s ORDER BY s.rowid DESC LIMIT 100")
                    .fetch_all(&app.db)
                    .await?
            };
            Ok(json!(rows.iter().map(|r|{let last=r.get::<Option<i64>,_>("last_event_at");let identity:Value=serde_json::from_str(&r.get::<String,_>("identity")).unwrap();let market_state=period::market_state(&identity,now());json!({"id":r.get::<String,_>("id"),"identity":identity,"marketState":market_state,"status":r.get::<String,_>("status"),"desired":r.get::<i64,_>("desired")!=0,"lastEventAt":last,"stalenessMs":last.map(|n|now()-n),"lastQuoteEventTime":r.get::<Option<i64>,_>("quote_time"),"lastQuoteReceivedAt":r.get::<Option<i64>,_>("quote_received"),"quoteStale":market_state["open"]==true && r.get::<Option<i64>,_>("quote_time").is_none_or(|t|now()-t>15000),"error":r.get::<Option<String>,_>("error")})}).collect::<Vec<_>>()))
        }
        "market.events" => {
            let id = required(p, "subscription_id")?;
            let identity: String =
                sqlx::query_scalar("SELECT identity FROM market_subscriptions WHERE id=?")
                    .bind(id)
                    .fetch_one(&app.db)
                    .await?;
            let identity: Value = serde_json::from_str(&identity)?;
            let rows=sqlx::query("SELECT * FROM market_events WHERE subscription_id=? AND cursor>? ORDER BY cursor LIMIT ?").bind(id).bind(p["cursor"].as_i64().unwrap_or(0)).bind(p["limit"].as_i64().unwrap_or(500).clamp(1,2000)).fetch_all(&app.db).await?;
            let events=json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("cursor"),"subscriptionId":id,"type":r.get::<String,_>("type"),"identity":identity,"eventTime":r.get::<i64,_>("event_time"),"receivedAt":r.get::<i64,_>("received_at"),"payload":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap(),"quality":serde_json::from_str::<Value>(&r.get::<String,_>("quality")).unwrap()})).collect::<Vec<_>>());
            let next = rows
                .last()
                .map(|r| r.get::<i64, _>("cursor"))
                .unwrap_or(p["cursor"].as_i64().unwrap_or(0));
            let floor: i64 =
                sqlx::query_scalar("SELECT pruned_cursor FROM market_subscriptions WHERE id=?")
                    .bind(id)
                    .fetch_one(&app.db)
                    .await?;
            let oldest = Some(floor + 1);
            Ok(
                json!({"events":events,"marketState":period::market_state(&identity,now()),"nextCursor":next,"retentionStartCursor":oldest,"cursorExpired":p["cursor"].as_i64().is_some_and(|c|c>0 && oldest.is_some_and(|o|c<o))}),
            )
        }
        "market.bars" | "market.snapshot" => {
            let id = required(p, "subscription_id")?;
            let mut tx = app.db.begin().await?;
            let rows=sqlx::query("SELECT payload,closed,quality,revision FROM market_bars WHERE subscription_id=? AND (?=0 OR closed=1) ORDER BY time DESC LIMIT 2000").bind(id).bind(i64::from(p["closedOnly"]==true)).fetch_all(&mut *tx).await?;
            let sub =
                sqlx::query("SELECT identity,status,error FROM market_subscriptions WHERE id=?")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            let identity: Value = serde_json::from_str(&sub.get::<String, _>("identity"))?;
            let cursor: i64 =
                sqlx::query_scalar("SELECT COALESCE(MAX(cursor),0) FROM market_events")
                    .fetch_one(&mut *tx)
                    .await?;
            let quote=sqlx::query("SELECT payload,quality,event_time,received_at FROM market_events WHERE subscription_id=? AND type='quote' ORDER BY cursor DESC LIMIT 1").bind(id).fetch_optional(&mut *tx).await?;
            let mut last_quote = quote
                .as_ref()
                .map(|r| serde_json::from_str::<Value>(&r.get::<String, _>("payload")))
                .transpose()?;
            let mut quote_quality = quote
                .as_ref()
                .map(|r| serde_json::from_str::<Value>(&r.get::<String, _>("quality")))
                .transpose()?;
            if let Some(row) = &quote {
                if let Some(q) = &mut last_quote {
                    q["eventTime"] = json!(row.get::<i64, _>("event_time"));
                    q["receivedAt"] = json!(row.get::<i64, _>("received_at"));
                }
                if let Some(q) = &mut quote_quality {
                    q["stale"] = json!(
                        now() - row.get::<i64, _>("event_time") > 15000
                            || now() - row.get::<i64, _>("received_at") > 15000
                    );
                }
            }
            tx.commit().await?;
            let mut bars = Vec::new();
            let mut forming = Value::Null;
            let mut quality = Vec::new();
            for r in rows.iter().rev() {
                let value: Value = serde_json::from_str(&r.get::<String, _>("payload"))?;
                let mut q: Value = serde_json::from_str(&r.get::<String, _>("quality"))?;
                q["revision"] = json!(r.get::<i64, _>("revision"));
                if r.get::<i64, _>("closed") != 0 {
                    bars.push(value);
                    quality.push(q)
                } else {
                    forming = json!({"bar":value,"quality":q});
                }
            }
            Ok(
                json!({"bars":bars,"forming":forming,"identity":identity,"quality":quality,"cursor":cursor,"status":sub.get::<String,_>("status"),"error":sub.get::<Option<String>,_>("error"),"lastQuote":last_quote,"quoteQuality":quote_quality,"marketState":period::market_state(&identity,now())}),
            )
        }
        _ => anyhow::bail!("Unknown market command {method}"),
    }
}
/// Used before changing a provider's private credentials. New charts get new source IDs.
pub async fn disconnect_provider(app: &App, provider: &str, reason: &str) -> anyhow::Result<u64> {
    let ids = sqlx::query_scalar::<_, String>(
        "SELECT id FROM market_subscriptions WHERE provider=? AND desired=1",
    )
    .bind(provider)
    .fetch_all(&app.db)
    .await?;
    let n=sqlx::query("UPDATE market_subscriptions SET desired=0,status='stopped',error=? WHERE provider=? AND desired=1").bind(reason).bind(provider).execute(&app.db).await?.rows_affected();
    for id in ids {
        event(
            app,
            &id,
            "gap",
            now(),
            json!({"reason":reason,"sourceInvalidated":true,"tickContinuityLost":true}),
            false,
            Some(reason),
        )
        .await?;
    }
    Ok(n)
}
pub async fn resume(app: &App) -> anyhow::Result<()> {
    let ids =
        sqlx::query_scalar::<_, String>("SELECT id FROM market_subscriptions WHERE desired=1")
            .fetch_all(&app.db)
            .await?;
    for id in ids {
        stream::spawn(app.clone(), id)
    }
    Ok(())
}

/// Public candle REST can revise immediately after close; only matured rows are execution inputs.
pub fn confirmation_seconds() -> i64 {
    std::env::var("TRADING_COINBASE_CONFIRMATION_SECONDS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(120)
        .clamp(60, 600)
}
/// Canonicalize source-quantized values to avoid accumulation noise becoming a revision.
pub fn normalize_bar(mut bar: Bar, identity: &Value) -> Bar {
    if identity["provider"] == "coinbase" {
        let quantize = |value: f64, field: &str| {
            identity[field]
                .as_f64()
                .filter(|q| q.is_finite() && *q > 0.)
                .map(|q| {
                    let decimals = q
                        .to_string()
                        .split('.')
                        .nth(1)
                        .map(|s| s.trim_end_matches('0').len())
                        .unwrap_or(0)
                        .min(15);
                    let scale = 10f64.powi(decimals as i32);
                    (((value / q).round() * q) * scale).round() / scale
                })
                .unwrap_or(value)
        };
        bar.open = quantize(bar.open, "tickSize");
        bar.high = quantize(bar.high, "tickSize");
        bar.low = quantize(bar.low, "tickSize");
        bar.close = quantize(bar.close, "tickSize");
        bar.volume = quantize(bar.volume, "sizeIncrement");
    }
    bar
}
#[cfg(test)]
mod precision_tests {
    use super::*;
    #[test]
    fn source_quantity_precision_preserves_real_changes() {
        let identity = json!({"provider":"coinbase","tickSize":0.01,"sizeIncrement":0.00000001});
        let bar = Bar {
            time: 1,
            close_time: 61,
            open: 83661.19,
            high: 83661.19,
            low: 83661.19,
            close: 83661.19,
            volume: 5.653350159999999,
        };
        let first = normalize_bar(bar.clone(), &identity);
        let mut rest = bar.clone();
        rest.volume = 5.65335016;
        assert_eq!(first, normalize_bar(rest.clone(), &identity));
        rest.volume += 0.00000001;
        assert_ne!(first, normalize_bar(rest, &identity));
        let mut price = bar;
        price.close += 0.01;
        assert_ne!(first, normalize_bar(price, &identity));
    }
}
