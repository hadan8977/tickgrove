use super::*;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
pub fn spawn(app: App, id: String) {
    tokio::spawn(async move {
        let repair_task = tokio::spawn(yahoo_reconcile(app.clone(), id.clone()));
        let confirmation_task = tokio::spawn(coinbase_reconcile(app.clone(), id.clone()));
        loop {
            match run(&app, &id).await {
                Ok(()) => break,
                Err(error) => {
                    let _ = status(&app, &id, "reconnecting", Some(error.to_string())).await;
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    if !wanted(&app, &id).await.unwrap_or(false) {
                        break;
                    }
                }
            }
        }
        repair_task.abort();
        confirmation_task.abort();
    });
}
async fn wanted(app: &App, id: &str) -> anyhow::Result<bool> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT desired FROM market_subscriptions WHERE id=?")
            .bind(id)
            .fetch_one(&app.db)
            .await?
            != 0,
    )
}
async fn status(app: &App, id: &str, value: &str, error: Option<String>) -> anyhow::Result<()> {
    sqlx::query("UPDATE market_subscriptions SET status=?,error=? WHERE id=?")
        .bind(value)
        .bind(&error)
        .bind(id)
        .execute(&app.db)
        .await?;
    event(
        app,
        id,
        "connection",
        now(),
        json!({"status":value,"error":error}),
        value == "connected",
        None,
    )
    .await
}
async fn persist_bar(
    app: &App,
    id: &str,
    bar: &Bar,
    closed: bool,
    complete: bool,
) -> anyhow::Result<()> {
    let identity: String =
        sqlx::query_scalar("SELECT identity FROM market_subscriptions WHERE id=?")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    let identity: Value = serde_json::from_str(&identity)?;
    let canonical = super::normalize_bar(bar.clone(), &identity);
    let bar = &canonical;
    let quality = json!({"complete":complete,"stale":!complete,"reason":if complete{Value::Null}else{json!("partial subscription, dropped trades or disconnect")}});
    let mut tx = app.db.begin().await?;
    let old=sqlx::query("SELECT payload,closed,quality,revision FROM market_bars WHERE subscription_id=? AND time=?").bind(id).bind(bar.time).fetch_optional(&mut *tx).await?;
    let payload = serde_json::to_string(bar)?;
    if let Some(old) = &old {
        if super::normalize_bar(
            serde_json::from_str::<Bar>(&old.get::<String, _>("payload"))?,
            &identity,
        ) == *bar
            && old.get::<i64, _>("closed") == i64::from(closed)
            && old.get::<String, _>("quality") == quality.to_string()
        {
            if old.get::<String, _>("payload") != payload {
                sqlx::query("UPDATE market_bars SET payload=? WHERE subscription_id=? AND time=?")
                    .bind(&payload)
                    .bind(id)
                    .bind(bar.time)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
            }
            return Ok(());
        }
    }
    let previously_closed = old.as_ref().is_some_and(|r| r.get::<i64, _>("closed") != 0);
    if previously_closed
        && !complete
        && old.as_ref().is_some_and(|r| {
            serde_json::from_str::<Value>(&r.get::<String, _>("quality"))
                .is_ok_and(|q| q["complete"] == true)
        })
    {
        anyhow::bail!(
            "Incomplete component replay cannot replace confirmed closed bar; repair required"
        )
    }
    anyhow::ensure!(
        !previously_closed || closed,
        "Cannot reopen committed closed bar"
    );
    let revision = old
        .as_ref()
        .map(|r| r.get::<i64, _>("revision") + 1)
        .unwrap_or(1);
    sqlx::query("INSERT INTO market_bars(subscription_id,time,payload,closed,quality,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(subscription_id,time) DO UPDATE SET payload=excluded.payload,closed=excluded.closed,quality=excluded.quality,revision=excluded.revision").bind(id).bind(bar.time).bind(&payload).bind(i64::from(closed)).bind(quality.to_string()).bind(revision).execute(&mut *tx).await?;
    let event_payload = if previously_closed {
        json!({"bar":bar,"previous":serde_json::from_str::<Value>(&old.as_ref().unwrap().get::<String,_>("payload"))?,"revision":revision,"reason":"provider correction or REST gap repair; not a new decision"})
    } else {
        json!(bar)
    };
    let inserted=sqlx::query("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES(?,?,?,?,?,?)").bind(id).bind(if previously_closed{"bar.revised"}else if closed{"bar.closed"}else{"bar.update"}).bind(if closed{bar.close_time*1000}else{now()}).bind(now()).bind(event_payload.to_string()).bind(quality.to_string()).execute(&mut *tx).await?;
    if revision % 100 == 0 || (closed && revision == 1) {
        sqlx::query("DELETE FROM market_bars WHERE subscription_id=? AND closed=1 AND time<(SELECT time FROM market_bars WHERE subscription_id=? AND closed=1 ORDER BY time DESC LIMIT 1 OFFSET ?)").bind(id).bind(id).bind(super::retention("TRADING_MARKET_BAR_RETENTION",10000,1000,100000)-1).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    super::prune(app, inserted.last_insert_rowid()).await?;
    Ok(())
}
async fn repair(app: &App, id: &str, symbol: &str, tf: &str) -> anyhow::Result<()> {
    let step = seconds(tf)?;
    let end = now() / 1000 / step * step;
    let result=history::fetch_ephemeral(app,&json!({"provider":"coinbase","symbol":symbol,"timeframe":tf,"start":end-step*5,"end":end,"allowGaps":true})).await?;
    for value in result["data"]["bars"].as_array().unwrap() {
        let bar: Bar = serde_json::from_value(value.clone())?;
        let existing = sqlx::query(
            "SELECT payload,quality FROM market_bars WHERE subscription_id=? AND time=?",
        )
        .bind(id)
        .bind(bar.time)
        .fetch_optional(&app.db)
        .await?;
        if let Some(r) = existing {
            let q: Value = serde_json::from_str(&r.get::<String, _>("quality"))?;
            if q["complete"] == true
                && serde_json::from_str::<Bar>(&r.get::<String, _>("payload"))? == bar
            {
                continue;
            }
        }
        persist_bar(app, id, &bar, true, true).await?;
    }
    event(
        app,
        id,
        "connection",
        now(),
        json!({"historyRepairSnapshot":result["snapshot_id"],"gaps":result["gaps"]}),
        true,
        None,
    )
    .await
}
async fn restore_builder(app: &App, id: &str, step: i64) -> anyhow::Result<state::Builder> {
    static RECOVERY: std::sync::LazyLock<tokio::sync::Semaphore> =
        std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(1));
    let _permit = RECOVERY.acquire().await?;
    let mut builder = state::Builder::new(step);
    let closed=sqlx::query("SELECT payload,quality FROM market_bars WHERE subscription_id=? AND closed=1 ORDER BY time DESC LIMIT 1").bind(id).fetch_optional(&app.db).await?;
    let after = if let Some(row) = closed {
        let bar: Bar = serde_json::from_str(&row.get::<String, _>("payload"))?;
        let quality: Value = serde_json::from_str(&row.get::<String, _>("quality"))?;
        let prior:Option<String>=sqlx::query_scalar("SELECT payload FROM market_events WHERE subscription_id=? AND type='trade' AND event_time<? ORDER BY cursor DESC LIMIT 1").bind(id).bind(bar.close_time*1000).fetch_optional(&app.db).await?;
        builder.last_trade = prior
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["trade_id"].as_i64());
        builder.complete = quality["complete"] == true && builder.last_trade.is_some();
        bar.close_time * 1000
    } else {
        0
    };
    let rows=sqlx::query("SELECT payload,event_time FROM market_events WHERE subscription_id=? AND type='trade' AND event_time>=? ORDER BY cursor LIMIT 100000").bind(id).bind(after).fetch_all(&app.db).await?;
    for row in rows {
        let v: Value = serde_json::from_str(&row.get::<String, _>("payload"))?;
        let number = |k: &str| {
            v[k].as_f64()
                .or_else(|| v[k].as_str().and_then(|s| s.parse().ok()))
        };
        if let (Some(trade_id), Some(price), Some(size)) =
            (v["trade_id"].as_i64(), number("price"), number("size"))
        {
            let change = builder.trade(trade_id, row.get("event_time"), price, size)?;
            if let Some((bar, complete)) = change.closed {
                persist_bar(app, id, &bar, true, complete).await?;
            }
        }
    }
    Ok(builder)
}
fn repair_later(app: &App, id: &str, symbol: &str, tf: &str) {
    let (app, id, symbol, tf) = (
        app.clone(),
        id.to_string(),
        symbol.to_string(),
        tf.to_string(),
    );
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if wanted(&app, &id).await.unwrap_or(false) {
            if let Err(e) = repair(&app, &id, &symbol, &tf).await {
                let _ = event(
                    &app,
                    &id,
                    "gap",
                    now(),
                    json!({"reason":"REST repair unavailable","error":e.to_string()}),
                    false,
                    None,
                )
                .await;
            }
        }
    });
}
async fn run(app: &App, id: &str) -> anyhow::Result<()> {
    let provider: String =
        sqlx::query_scalar("SELECT provider FROM market_subscriptions WHERE id=?")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    if provider == "yahoo" {
        let meta: String =
            sqlx::query_scalar("SELECT identity FROM market_subscriptions WHERE id=?")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
        let meta: Value = serde_json::from_str(&meta)?;
        if meta["feed"] == "quote-polling-60s" {
            return yahoo_loop(app, id).await;
        }
        return yahoo_socket(app, id).await;
    }
    if provider == "alpaca" {
        return alpaca_socket(app, id).await;
    }

    let row = sqlx::query("SELECT symbol,timeframe FROM market_subscriptions WHERE id=?")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let symbol: String = row.get("symbol");
    let tf: String = row.get("timeframe");
    let mut builder = restore_builder(app, id, seconds(&tf)?).await?;
    let mut backoff = 1u64;
    while wanted(app, id).await? {
        status(app, id, "connecting", None).await?;
        let url = std::env::var("TRADING_COINBASE_WS_MOCK")
            .unwrap_or("wss://ws-feed.exchange.coinbase.com".into());
        if url.starts_with("ws://") {
            let parsed = reqwest::Url::parse(&url)?;
            anyhow::ensure!(
                ["127.0.0.1", "localhost"].contains(&parsed.host_str().unwrap_or("")),
                "Websocket mock must be loopback"
            );
        } else {
            anyhow::ensure!(
                url == "wss://ws-feed.exchange.coinbase.com",
                "Unexpected Coinbase websocket endpoint"
            );
        }
        let connection = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(&url),
        )
        .await;
        let (mut socket, _) = match connection {
            Ok(Ok(c)) => c,
            result => {
                status(
                    app,
                    id,
                    "reconnecting",
                    Some(format!("Connect failed: {result:?}")),
                )
                .await?;
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
                continue;
            }
        };
        socket.send(Message::Text(json!({"type":"subscribe","product_ids":[symbol],"channels":["ticker","matches","heartbeat"]}).to_string().into())).await?;
        status(app, id, "connected", None).await?;
        if let Err(e) = repair(app, id, &symbol, &tf).await {
            event(
                app,
                id,
                "gap",
                now(),
                json!({"reason":"REST repair failed","error":e.to_string()}),
                false,
                Some("repair failed"),
            )
            .await?;
        }
        backoff = 1;
        let mut last_received = tokio::time::Instant::now();
        let mut poll = tokio::time::interval(Duration::from_secs(1));
        let failure = loop {
            tokio::select! {_ = poll.tick()=>{if !wanted(app,id).await?{let _=socket.close(None).await;return Ok(())}if last_received.elapsed()>Duration::from_secs(15){break "Heartbeat/tick timeout".to_string()}},msg=socket.next()=>{let msg=match msg {Some(Ok(m))=>m,Some(Err(e))=>break e.to_string(),None=>break "Websocket closed".into()};last_received=tokio::time::Instant::now();if let Message::Ping(p)=msg {socket.send(Message::Pong(p)).await?;continue}let Message::Text(text)=msg else{continue};let value:Value=match serde_json::from_str(text.as_str()){Ok(v)=>v,Err(_)=>{event(app,id,"gap",now(),json!({"reason":"malformed provider message"}),false,None).await?;continue}};
            if value["type"]=="error"{break value.to_string()}if value["product_id"].as_str().is_some_and(|s|s!=symbol){continue}let time=value["time"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).map(|t|t.timestamp_millis()).unwrap_or(now());
            match value["type"].as_str().unwrap_or("") {
            "ticker"=>event(app,id,"quote",time,value,true,None).await?,
            "heartbeat"=>{let last=value["last_trade_id"].as_i64();if last.is_some_and(|n|builder.last_trade.is_some_and(|old|n>old)){builder.disconnected();event(app,id,"gap",time,json!({"lastReceivedTrade":builder.last_trade,"providerLastTrade":last}),false,Some("heartbeat detects dropped trades")).await?;}event(app,id,"heartbeat",time,value,true,None).await?;if let Some((bar,complete))=builder.watermark(time){persist_bar(app,id,&bar,true,complete).await?;if !complete{repair_later(app,id,&symbol,&tf);}}},
            "match"=>{let trade_id=value["trade_id"].as_i64().ok_or_else(||anyhow::anyhow!("Missing trade ID"))?;let price=value["price"].as_str().and_then(|s|s.parse().ok()).ok_or_else(||anyhow::anyhow!("Invalid trade price"))?;let size=value["size"].as_str().and_then(|s|s.parse().ok()).ok_or_else(||anyhow::anyhow!("Invalid trade size"))?;let inserted=sqlx::query("INSERT OR IGNORE INTO market_trade_ids VALUES(?,?)").bind(id).bind(trade_id).execute(&app.db).await?.rows_affected();if inserted==0{continue}if trade_id%1000==0{sqlx::query("DELETE FROM market_trade_ids WHERE subscription_id=? AND trade_id<?").bind(id).bind(trade_id-super::retention("TRADING_MARKET_TRADE_ID_RETENTION",100000,10000,1000000)).execute(&app.db).await?;}let change=builder.trade(trade_id,time,price,size)?;if change.duplicate{continue}event(app,id,"trade",time,value,true,None).await?;if let Some(reason)=change.gap{event(app,id,"gap",time,json!({"reason":reason}),false,None).await?;}if let Some((bar,complete))=change.closed{persist_bar(app,id,&bar,true,complete).await?;if !complete{repair_later(app,id,&symbol,&tf);}}if let Some(bar)=change.forming{persist_bar(app,id,&bar,false,builder.complete).await?;}},_=>{}}
            }}
        };
        builder.disconnected();
        if let Some(bar) = &builder.forming {
            persist_bar(app, id, bar, false, false).await?;
        }
        status(app, id, "reconnecting", Some(failure)).await?;
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
    Ok(())
}

pub async fn yahoo_quote(symbol: &str) -> anyhow::Result<Value> {
    let identity = identity("yahoo", symbol, "1D", "quote-polling", "raw")?;
    let response = client()?
        .get(format!(
            "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        ))
        .query(&[("interval", "1d"), ("range", "1d")])
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Yahoo quote response {}",
        response.status()
    );
    let v: Value = response.json().await?;
    let meta = &v["chart"]["result"][0]["meta"];
    let price = meta["regularMarketPrice"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or_else(|| anyhow::anyhow!("Yahoo missing quote price"))?;
    let event = meta["regularMarketTime"]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Yahoo missing quote time"))?
        * 1000;
    Ok(
        json!({"identity":super::instruments::from_yahoo(identity,meta),"provider":"yahoo","symbol":symbol,"kind":"delayed-quote-polling","price":price,"previousClose":meta.get("previousClose").or_else(||meta.get("chartPreviousClose")),"previousCloseSource":"Yahoo chart range=1d metadata","eventTime":event,"receivedAt":now(),"delaySeconds":meta["exchangeDataDelayedBy"],"metadata":meta,"stale":now()-event>60000}),
    )
}
async fn yahoo_loop(app: &App, id: &str) -> anyhow::Result<()> {
    let symbol: String = sqlx::query_scalar("SELECT symbol FROM market_subscriptions WHERE id=?")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    while wanted(app, id).await? {
        match yahoo_quote(&symbol).await {
            Ok(quote) => {
                status(app, id, "connected", None).await?;
                event(
                    app,
                    id,
                    "quote",
                    quote["eventTime"].as_i64().unwrap(),
                    quote,
                    true,
                    Some("Yahoo delayed snapshot, not exchange trade tick"),
                )
                .await?
            }
            Err(e) => status(app, id, "reconnecting", Some(e.to_string())).await?,
        }
        for _ in 0..60 {
            if !wanted(app, id).await? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    Ok(())
}

async fn yahoo_socket(app: &App, id: &str) -> anyhow::Result<()> {
    let symbol: String = sqlx::query_scalar("SELECT symbol FROM market_subscriptions WHERE id=?")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let (mut socket, _) =
        tokio_tungstenite::connect_async("wss://streamer.finance.yahoo.com/?version=2").await?;
    socket
        .send(Message::Text(
            json!({"subscribe":[symbol]}).to_string().into(),
        ))
        .await?;
    status(app, id, "connected", None).await?;
    let mut keepalive = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {_ = keepalive.tick()=>{if !wanted(app,id).await?{let _=socket.close(None).await;return Ok(())}socket.send(Message::Text(json!({"subscribe":[symbol]}).to_string().into())).await?;},message=socket.next()=>{let message=message.ok_or_else(||anyhow::anyhow!("Yahoo pricing socket closed"))??;if let Message::Ping(p)=message{socket.send(Message::Pong(p)).await?;continue}let Message::Text(text)=message else{continue};let wrapper:Value=serde_json::from_str(text.as_str())?;let encoded=wrapper["message"].as_str().unwrap_or(text.as_str());let mut quote=super::yahoo_proto::decode(encoded)?;if quote["symbol"]!=symbol{continue}quote["provider"]=json!("yahoo");quote["kind"]=json!("public-pricing-websocket; exchange delay not guaranteed");quote["receivedAt"]=json!(now());let identity:Value=serde_json::from_str(&sqlx::query_scalar::<_,String>("SELECT identity FROM market_subscriptions WHERE id=?").bind(id).fetch_one(&app.db).await?)?;provisional_quote(app,id,&identity,&quote).await?;event(app,id,"quote",quote["eventTime"].as_i64().unwrap(),quote,true,Some("Unofficial Yahoo push quote; no completeness claim for exchange trades")).await?;}}
    }
}
async fn yahoo_reconcile(app: App, id: String) {
    let row = match sqlx::query(
        "SELECT provider,identity,symbol,timeframe FROM market_subscriptions WHERE id=?",
    )
    .bind(&id)
    .fetch_one(&app.db)
    .await
    {
        Ok(r) => r,
        Err(_) => return,
    };
    if row.get::<String, _>("provider") != "yahoo" {
        return;
    }
    let identity: Value = match serde_json::from_str(&row.get::<String, _>("identity")) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut last_end = 0;
    loop {
        if !wanted(&app, &id).await.unwrap_or(false) {
            return;
        }
        match super::period::last_closed(&identity, now() / 1000 - 5) {
            Ok(Some((start, end))) if end > last_end => {
                let params = json!({"provider":"yahoo","symbol":row.get::<String,_>("symbol"),"timeframe":row.get::<String,_>("timeframe"),"session":identity["session"],"adjustment":"raw","start":start,"end":end});
                match history::fetch_ephemeral(&app, &params).await {
                    Ok(result) => {
                        for b in result["data"]["bars"].as_array().into_iter().flatten() {
                            if let Ok(bar) = serde_json::from_value::<Bar>(b.clone()) {
                                if let Err(e) = persist_bar(&app, &id, &bar, true, true).await {
                                    let _ = event(
                                        &app,
                                        &id,
                                        "gap",
                                        now(),
                                        json!({"reason":e.to_string()}),
                                        false,
                                        None,
                                    )
                                    .await;
                                }
                            }
                        }
                        last_end = end;
                    }
                    Err(e) => {
                        let _=event(&app,&id,"gap",now(),json!({"reason":"official Yahoo closed-bar reconciliation unavailable","error":e.to_string(),"start":start,"end":end}),false,None).await;
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}
async fn provisional_quote(
    app: &App,
    id: &str,
    identity: &Value,
    quote: &Value,
) -> anyhow::Result<()> {
    let time = quote["eventTime"]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Quote event time required"))?;
    if now() - time > 15000 || time > now() + 5000 {
        return Ok(());
    }
    let Some((start, end)) = super::period::bounds(identity, time / 1000)? else {
        return Ok(());
    };
    let Some(price) = crate::account::quote_mark(quote) else {
        return Ok(());
    };
    let old =
        sqlx::query("SELECT payload,closed FROM market_bars WHERE subscription_id=? AND time=?")
            .bind(id)
            .bind(start)
            .fetch_optional(&app.db)
            .await?;
    if old.as_ref().is_some_and(|r| r.get::<i64, _>("closed") != 0) {
        return Ok(());
    }
    let previous: Value = old
        .as_ref()
        .map(|r| serde_json::from_str(&r.get::<String, _>("payload")))
        .transpose()?
        .unwrap_or(Value::Null);
    let bar = json!({"time":start,"closeTime":end,"open":previous["open"].as_f64().unwrap_or(price),"high":previous["high"].as_f64().unwrap_or(price).max(price),"low":previous["low"].as_f64().unwrap_or(price).min(price),"close":price,"volume":Value::Null});
    let quality = json!({"complete":false,"stale":false,"source":"quote-derived","volumeKnown":false,"reason":"Provisional quote OHLC; exchange trade volume unavailable; not a closed strategy input"});
    let mut tx = app.db.begin().await?;
    sqlx::query("DELETE FROM market_bars WHERE subscription_id=? AND closed=0 AND time<>?")
        .bind(id)
        .bind(start)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO market_bars(subscription_id,time,payload,closed,quality) VALUES(?,?,?,0,?) ON CONFLICT(subscription_id,time) DO UPDATE SET payload=excluded.payload,quality=excluded.quality").bind(id).bind(start).bind(bar.to_string()).bind(quality.to_string()).execute(&mut *tx).await?;
    tx.commit().await?;
    event(
        app,
        id,
        "bar.update",
        time,
        bar,
        false,
        Some("quote-derived; volume unknown; cannot drive strategy decisions"),
    )
    .await?;
    Ok(())
}
async fn official_minute(app: &App, id: &str, identity: &Value, bar: &Bar) -> anyhow::Result<()> {
    let Some((start, end)) = super::period::bounds(identity, bar.time)? else {
        return Ok(());
    };
    sqlx::query("INSERT INTO market_source_bars VALUES(?,?,?,?) ON CONFLICT(subscription_id,time) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at").bind(id).bind(bar.time).bind(serde_json::to_string(bar)?).bind(now()).execute(&app.db).await?;
    let rows:Vec<String>=sqlx::query_scalar("SELECT payload FROM market_source_bars WHERE subscription_id=? AND time>=? AND time<? ORDER BY time").bind(id).bind(start).bind(end).fetch_all(&app.db).await?;
    let components: Vec<Bar> = rows
        .into_iter()
        .map(|s| serde_json::from_str(&s))
        .collect::<Result<_, _>>()?;
    let first = components.first().unwrap();
    let last = components.last().unwrap();
    let mut aggregate = first.clone();
    aggregate.time = start;
    aggregate.close_time = end;
    for b in components.iter().skip(1) {
        aggregate.high = aggregate.high.max(b.high);
        aggregate.low = aggregate.low.min(b.low);
        aggregate.close = b.close;
        aggregate.volume += b.volume;
    }
    let closed = end <= now() / 1000 && last.close_time >= end;
    let complete = (end > now() / 1000 || last.close_time == end)
        && first.time == start
        && components.windows(2).all(|w| w[0].close_time == w[1].time)
        && if closed { last.close_time == end } else { true };
    persist_bar(app, id, &aggregate, closed, complete).await?;
    sqlx::query("DELETE FROM market_source_bars WHERE subscription_id=? AND time<?")
        .bind(id)
        .bind(bar.time - 35 * 86400)
        .execute(&app.db)
        .await?;
    Ok(())
}
async fn alpaca_socket(app: &App, id: &str) -> anyhow::Result<()> {
    let row = sqlx::query("SELECT symbol,identity FROM market_subscriptions WHERE id=?")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let symbol: String = row.get("symbol");
    let meta: Value = serde_json::from_str(&row.get::<String, _>("identity"))?;
    let feed = meta["feed"].as_str().unwrap_or("iex");
    anyhow::ensure!(
        ["iex", "sip", "boats", "overnight"].contains(&feed),
        "Unsupported Alpaca stream feed"
    );
    let key = std::env::var("ALPACA_API_KEY")
        .map_err(|_| anyhow::anyhow!("Dedicated Alpaca key not configured"))?;
    let secret = std::env::var("ALPACA_API_SECRET")
        .map_err(|_| anyhow::anyhow!("Dedicated Alpaca secret not configured"))?;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("wss://stream.data.alpaca.markets/v2/{feed}"))
            .await?;
    socket
        .send(Message::Text(
            json!({"action":"auth","key":key,"secret":secret})
                .to_string()
                .into(),
        ))
        .await?;
    let mut authenticated = false;
    let mut poll = tokio::time::interval(Duration::from_secs(1));
    let mut last = tokio::time::Instant::now();
    loop {
        tokio::select! {_ = poll.tick()=>{if !wanted(app,id).await?{let _=socket.close(None).await;return Ok(())}if last.elapsed()>Duration::from_secs(30){anyhow::bail!("Alpaca stream stale/timeout")}},message=socket.next()=>{let message=message.ok_or_else(||anyhow::anyhow!("Alpaca websocket closed"))??;last=tokio::time::Instant::now();let Message::Text(text)=message else{continue};let values:Value=serde_json::from_str(text.as_str())?;for v in values.as_array().ok_or_else(||anyhow::anyhow!("Invalid Alpaca websocket envelope"))?{match v["T"].as_str().unwrap_or("") {"error"=>anyhow::bail!("Alpaca stream entitlement/auth error code {}: {}",v["code"],v["msg"]),"success" if v["msg"]=="authenticated"=>{authenticated=true;socket.send(Message::Text(json!({"action":"subscribe","quotes":[symbol],"trades":[symbol],"bars":[symbol],"updatedBars":[symbol]}).to_string().into())).await?;status(app,id,"connected",None).await?;},"q"|"t"|"b"|"u"=>{anyhow::ensure!(authenticated,"Alpaca data before authentication");if v["S"]!=symbol{continue}let time=chrono::DateTime::parse_from_rfc3339(v["t"].as_str().ok_or_else(||anyhow::anyhow!("Missing Alpaca time"))?)?.timestamp_millis();match v["T"].as_str().unwrap(){"q"=>{match super::alpaca_wire::quote(v){Ok(q)=>{provisional_quote(app,id,&meta,&q).await?;event(app,id,"quote",time,q,true,None).await?;},Err(e)=>{event(app,id,"gap",time,json!({"reason":e.to_string(),"source":v}),false,None).await?;}}},"t"=>{event(app,id,"trade",time,super::alpaca_wire::trade(v)?,true,None).await?;},_=>{official_minute(app,id,&meta,&super::alpaca_wire::minute_bar(v)?).await?;}}},_=>{}}}}}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn closed_bar_once_and_explicit_correction() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "test-token-not-network".into(),
            root: std::path::PathBuf::from(".."),
            node: std::path::PathBuf::from("/usr/bin/node"),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status) VALUES('test','coinbase','LTC-USD','1m','{}','connected')").execute(&app.db).await?;
        let mut bar = Bar {
            time: 60,
            close_time: 120,
            open: 10.,
            high: 11.,
            low: 9.,
            close: 10.5,
            volume: 2.,
        };
        persist_bar(&app, "test", &bar, true, true).await?;
        persist_bar(&app, "test", &bar, true, true).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM market_events WHERE type='bar.closed'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(count, 1);
        bar.close = 10.75;
        persist_bar(&app, "test", &bar, true, true).await?;
        let types: Vec<String> =
            sqlx::query_scalar("SELECT type FROM market_events ORDER BY cursor")
                .fetch_all(&app.db)
                .await?;
        assert_eq!(types, vec!["bar.closed", "bar.revised"]);
        assert!(persist_bar(&app, "test", &bar, false, true).await.is_err());
        let revision: i64 = sqlx::query_scalar("SELECT revision FROM market_bars")
            .fetch_one(&app.db)
            .await?;
        assert_eq!(revision, 2);
        Ok(())
    }
}
#[cfg(test)]
mod aggregation_tests {
    use super::*;
    #[tokio::test]
    async fn alpaca_minutes_aggregate_and_revise_without_fake_daily_bar() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "test-only".into(),
            root: std::path::PathBuf::from(".."),
            node: std::path::PathBuf::from("/usr/bin/node"),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let identity = identity("alpaca", "AAPL", "5m", "iex", "raw")?;
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('a','alpaca','AAPL','5m',?,'connected','iex')").bind(identity.to_string()).execute(&app.db).await?;
        let start = chrono::DateTime::parse_from_rfc3339("2026-10-13T13:30:00Z")?.timestamp();
        for i in 0..5 {
            official_minute(
                &app,
                "a",
                &identity,
                &Bar {
                    time: start + i * 60,
                    close_time: start + (i + 1) * 60,
                    open: 10.,
                    high: 11.,
                    low: 9.,
                    close: 10.,
                    volume: 1.,
                },
            )
            .await?;
        }
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM market_events WHERE type='bar.closed'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(count, 1);
        official_minute(
            &app,
            "a",
            &identity,
            &Bar {
                time: start + 60,
                close_time: start + 120,
                open: 10.,
                high: 12.,
                low: 9.,
                close: 10.,
                volume: 2.,
            },
        )
        .await?;
        let result: String =
            sqlx::query_scalar("SELECT payload FROM market_bars WHERE subscription_id='a'")
                .fetch_one(&app.db)
                .await?;
        let bar: Bar = serde_json::from_str(&result)?;
        assert_eq!(bar.close_time - start, 300);
        assert_eq!(bar.high, 12.);
        assert_eq!(bar.volume, 6.);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM market_events WHERE type='bar.revised'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(count, 1);
        Ok(())
    }
}

async fn coinbase_reconcile(app: App, id: String) {
    let Ok(row) =
        sqlx::query("SELECT provider,symbol,timeframe FROM market_subscriptions WHERE id=?")
            .bind(&id)
            .fetch_one(&app.db)
            .await
    else {
        return;
    };
    if row.get::<String, _>("provider") != "coinbase" {
        return;
    }
    while wanted(&app, &id).await.unwrap_or(false) {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if !wanted(&app, &id).await.unwrap_or(false) {
            return;
        }
        if let Err(e) = repair(
            &app,
            &id,
            &row.get::<String, _>("symbol"),
            &row.get::<String, _>("timeframe"),
        )
        .await
        {
            let _ = event(
                &app,
                &id,
                "gap",
                now(),
                json!({"reason":"confirmed REST repair unavailable","error":e.to_string()}),
                false,
                None,
            )
            .await;
        }
    }
}
#[cfg(test)]
mod precision_persistence {
    use super::*;
    #[tokio::test]
    async fn noise_does_not_emit_revision_but_one_quantity_quantum_does() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "fixture".into(),
            root: "..".into(),
            node: "/usr/bin/node".into(),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let identity = json!({"provider":"coinbase","tickSize":0.01,"sizeIncrement":0.00000001});
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status) VALUES('precision','coinbase','BTC-USD','1m',?,'connected')").bind(identity.to_string()).execute(&app.db).await?;
        let mut bar = Bar {
            time: 1,
            close_time: 61,
            open: 83661.19,
            high: 83661.19,
            low: 83661.19,
            close: 83661.19,
            volume: 5.653350159999999,
        };
        persist_bar(&app, "precision", &bar, true, true).await?;
        bar.volume = 5.65335016;
        persist_bar(&app, "precision", &bar, true, true).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM market_events WHERE type='bar.revised'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(count, 0);
        bar.volume += 0.00000001;
        persist_bar(&app, "precision", &bar, true, true).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM market_events WHERE type='bar.revised'")
                .fetch_one(&app.db)
                .await?;
        assert_eq!(count, 1);
        Ok(())
    }
}
