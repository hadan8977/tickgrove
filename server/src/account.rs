use crate::{App, commands::required, market};
use serde_json::{Value, json};
use sqlx::Row;
pub fn quote_price(v: &Value, side: &str) -> Option<f64> {
    let num = |key: &str| {
        v[key]
            .as_f64()
            .or_else(|| v[key].as_str().and_then(|s| s.parse().ok()))
            .filter(|n| n.is_finite() && *n > 0.)
    };
    if side == "buy" {
        num("ask").or_else(|| num("best_ask")).or_else(|| num("ap"))
    } else {
        num("bid").or_else(|| num("best_bid")).or_else(|| num("bp"))
    }
    .or_else(|| num("price"))
    .or_else(|| num("p"))
}
pub fn quote_mark(v: &Value) -> Option<f64> {
    v["price"]
        .as_f64()
        .or_else(|| v["price"].as_str().and_then(|s| s.parse().ok()))
        .or_else(|| v["p"].as_f64())
        .or_else(|| {
            quote_price(v, "buy")
                .zip(quote_price(v, "sell"))
                .map(|(a, b)| (a + b) / 2.)
        })
        .filter(|n| n.is_finite() && *n > 0.)
}
fn order_session<'a>(provider: &str, feed: &str, request: &'a Value) -> anyhow::Result<&'a str> {
    anyhow::ensure!(
        request["session"].is_null() || request["session"].is_string(),
        "Order session must be a string"
    );
    let default = if provider == "coinbase" {
        "24x7"
    } else if ["boats", "overnight"].contains(&feed) {
        "overnight"
    } else {
        "regular"
    };
    let session = request["session"].as_str().unwrap_or(default);
    anyhow::ensure!(
        if provider == "coinbase" {
            session == "24x7"
        } else if ["boats", "overnight"].contains(&feed) {
            session == "overnight"
        } else {
            ["regular", "extended"].contains(&session)
        },
        "Order session is not supported by its source feed"
    );
    Ok(session)
}
fn order_session_open(identity: &Value, request: &Value, event_time: i64) -> anyhow::Result<bool> {
    let mut selected = identity.clone();
    selected["session"] = json!(order_session(
        required(identity, "provider")?,
        required(identity, "feed")?,
        request
    )?);
    Ok(market::period::market_state(&selected, event_time)["open"] == true)
}
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "account.state" => state(app).await,
        "account.placeOrder" => {
            let client = required(p, "client_order_id")?;
            let provider = required(p, "provider")?;
            let symbol = required(p, "symbol")?;
            let feed = p["feed"].as_str().unwrap_or(if provider == "alpaca" {
                "iex"
            } else {
                "public-websocket"
            });
            let session = order_session(provider, feed, p)?;
            market::identity(provider, symbol, "1m", "manual-local", "none")?;
            anyhow::ensure!(
                provider != "yahoo",
                "Yahoo quotes have unknown/delayed exchange policy and cannot execute local orders; use Coinbase or configured Alpaca"
            );
            let side = required(p, "side")?;
            anyhow::ensure!(["buy", "sell"].contains(&side), "Invalid side");
            let kind = required(p, "type")?;
            anyhow::ensure!(
                ["market", "limit", "stop", "stop-limit"].contains(&kind),
                "Unsupported local order type"
            );
            let qty = p["qty"]
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.)
                .ok_or_else(|| anyhow::anyhow!("Positive finite qty required"))?;
            let price = p["price"].as_f64();
            let stop = p["stopPrice"].as_f64();
            if ["limit", "stop-limit"].contains(&kind) {
                anyhow::ensure!(
                    price.is_some_and(|n| n.is_finite() && n > 0.),
                    "Limit price required"
                );
            }
            if ["stop", "stop-limit"].contains(&kind) {
                anyhow::ensure!(
                    stop.is_some_and(|n| n.is_finite() && n > 0.),
                    "Stop price required"
                );
            }
            let mut tx = app.db.begin().await?;
            if let Some(r) = sqlx::query(
                "SELECT id,request,status,error FROM local_orders WHERE client_order_id=?",
            )
            .bind(client)
            .fetch_optional(&mut *tx)
            .await?
            {
                anyhow::ensure!(
                    r.get::<String, _>("request") == p.to_string(),
                    "client_order_id_conflict"
                );
                return Ok(
                    json!({"id":r.get::<String,_>("id"),"status":r.get::<String,_>("status"),"duplicate":true,"error":r.get::<Option<String>,_>("error")}),
                );
            }
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO local_orders(id,client_order_id,request,provider,symbol,side,type,qty,price,stop_price,status,created_at,feed) VALUES(?,?,?,?,?,?,?,?,?,?,'working',?,?)").bind(&id).bind(client).bind(p.to_string()).bind(provider).bind(symbol).bind(side).bind(kind).bind(qty).bind(price).bind(stop).bind(market::now()).bind(feed).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO local_order_events(order_id,kind,payload,time) VALUES(?,'created',?,?)").bind(&id).bind(p.to_string()).bind(market::now()).execute(&mut *tx).await?;
            tx.commit().await?;
            let subscription = match crate::market::execute(
                app,
                "market.subscribe",
                &json!({"provider":provider,"symbol":symbol,"timeframe":"1m","feed":feed,"session":session}),
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    let error = e.to_string();
                    let mut tx = app.db.begin().await?;
                    sqlx::query("UPDATE local_orders SET status='rejected',error=? WHERE id=? AND status='working'").bind(&error).bind(&id).execute(&mut *tx).await?;
                    sqlx::query("INSERT INTO local_order_events(order_id,kind,payload,time) VALUES(?,'rejected',?,?)").bind(&id).bind(json!({"error":error,"reason":"market preflight failed; no fill permitted"}).to_string()).bind(market::now()).execute(&mut *tx).await?;
                    tx.commit().await?;
                    return Ok(json!({"id":id,"status":"rejected","error":error}));
                }
            };
            if let Err(error) = market::execution_eligibility(
                &subscription["identity"],
                &json!({"complete":true,"stale":false}),
            ) {
                sqlx::query("UPDATE local_orders SET status='rejected',error=? WHERE id=? AND status='working'").bind(error.to_string()).bind(&id).execute(&app.db).await?;
                return Ok(json!({"id":id,"status":"rejected","error":error.to_string()}));
            }
            if subscription["identity"]["currency"] != "USD" {
                sqlx::query("UPDATE local_orders SET status='rejected',error='USD account has no FX conversion' WHERE id=?").bind(&id).execute(&app.db).await?;
                return Ok(
                    json!({"id":id,"status":"rejected","error":"USD account has no FX conversion"}),
                );
            }
            if let Some(q)=sqlx::query("SELECT e.cursor,e.event_time,e.received_at,e.payload,e.quality,s.identity,s.status FROM market_events e JOIN market_subscriptions s ON e.subscription_id=s.id WHERE s.provider=? AND s.symbol=? AND json_extract(s.identity,'$.feed')=? AND e.type='quote' ORDER BY e.cursor DESC LIMIT 1").bind(provider).bind(symbol).bind(feed).fetch_optional(&app.db).await? {if q.get::<String,_>("status")=="connected"{
                let identity:Value=serde_json::from_str(&q.get::<String,_>("identity"))?;
                let quality:Value=serde_json::from_str(&q.get::<String,_>("quality"))?;
                if market::execution_eligibility(&identity,&quality).is_ok(){on_quote(app,q.get("cursor"),provider,symbol,feed,q.get("event_time"),q.get("received_at"),&serde_json::from_str(&q.get::<String,_>("payload"))?,&identity,&quality).await?;}
            }}
            let status: String = sqlx::query_scalar("SELECT status FROM local_orders WHERE id=?")
                .bind(&id)
                .fetch_one(&app.db)
                .await?;
            Ok(json!({"id":id,"status":status}))
        }
        "account.cancelOrder" => {
            let id = required(p, "id")?;
            let mut tx = app.db.begin().await?;
            let n=sqlx::query("UPDATE local_orders SET status='canceled' WHERE id=? AND status IN ('working','triggered')").bind(id).execute(&mut *tx).await?.rows_affected();
            if n > 0 {
                sqlx::query("INSERT INTO local_order_events(order_id,kind,payload,time) VALUES(?,'canceled','{}',?)").bind(id).bind(market::now()).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            Ok(json!({"id":id,"canceled":n>0}))
        }
        "account.modifyOrder" => {
            for key in ["qty", "price", "stopPrice"] {
                anyhow::ensure!(
                    p.get(key)
                        .is_none_or(|v| v.as_f64().is_some_and(|n| n.is_finite() && n > 0.)),
                    "Invalid numeric amendment {key}"
                );
            }
            let id = required(p, "id")?;
            let mut tx = app.db.begin().await?;
            let row = sqlx::query("SELECT * FROM local_orders WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            anyhow::ensure!(
                ["working", "triggered"].contains(&row.get::<String, _>("status").as_str()),
                "Only working orders can be modified"
            );
            let qty = p["qty"].as_f64().unwrap_or(row.get("qty"));
            let price = p["price"].as_f64().or(row.get("price"));
            let stop = p["stopPrice"].as_f64().or(row.get("stop_price"));
            anyhow::ensure!(
                qty.is_finite()
                    && qty > 0.
                    && price.is_none_or(|n| n.is_finite() && n > 0.)
                    && stop.is_none_or(|n| n.is_finite() && n > 0.),
                "Invalid order amendment"
            );
            sqlx::query("UPDATE local_orders SET qty=?,price=?,stop_price=? WHERE id=?")
                .bind(qty)
                .bind(price)
                .bind(stop)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO local_order_events(order_id,kind,payload,time) VALUES(?,'modified',?,?)").bind(id).bind(p.to_string()).bind(market::now()).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(json!({"id":id,"modified":true}))
        }
        "account.flatten" => {
            let provider = required(p, "provider")?;
            let symbol = required(p, "symbol")?;
            let qty = sqlx::query_scalar::<_, f64>(
                "SELECT qty FROM local_positions WHERE provider=? AND symbol=?",
            )
            .bind(provider)
            .bind(symbol)
            .fetch_optional(&app.db)
            .await?
            .unwrap_or(0.);
            anyhow::ensure!(qty != 0., "No position to flatten");
            let mut request = json!({"provider":provider,"symbol":symbol,"side":if qty>0.{"sell"}else{"buy"},"type":"market","qty":qty.abs(),"feed":p["feed"],"client_order_id":required(p,"client_order_id")?});
            if let Some(session) = p["session"].as_str() {
                request["session"] = json!(session)
            }
            Box::pin(execute(app, "account.placeOrder", &request)).await
        }
        "account.reset" => {
            anyhow::ensure!(
                p["confirm"] == "RESET_LOCAL_ACCOUNT",
                "Explicit RESET_LOCAL_ACCOUNT confirmation required"
            );
            let cash = p["startingCash"].as_f64().unwrap_or(100000.);
            anyhow::ensure!(cash.is_finite() && cash > 0., "Invalid starting cash");
            let mut tx = app.db.begin().await?;
            for table in [
                "local_fills",
                "local_order_events",
                "local_orders",
                "local_positions",
            ] {
                sqlx::query(&format!("DELETE FROM {table}"))
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE local_account SET starting_cash=?,cash=?,realized_pnl=0,total_fees=0 WHERE id=1").bind(cash).bind(cash).execute(&mut *tx).await?;
            tx.commit().await?;
            state(app).await
        }
        "account.events" => {
            let rows = sqlx::query(
                "SELECT * FROM local_order_events WHERE cursor>? ORDER BY cursor LIMIT 1000",
            )
            .bind(p["cursor"].as_i64().unwrap_or(0))
            .fetch_all(&app.db)
            .await?;
            Ok(json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("cursor"),"orderId":r.get::<String,_>("order_id"),"kind":r.get::<String,_>("kind"),"time":r.get::<i64,_>("time"),"payload":serde_json::from_str::<Value>(&r.get::<String,_>("payload")).unwrap()})).collect::<Vec<_>>()))
        }
        _ => anyhow::bail!("Unknown local account command"),
    }
}
async fn state(app: &App) -> anyhow::Result<Value> {
    let a = sqlx::query("SELECT * FROM local_account WHERE id=1")
        .fetch_one(&app.db)
        .await?;
    let pos = sqlx::query("SELECT * FROM local_positions WHERE qty!=0")
        .fetch_all(&app.db)
        .await?;
    let positions:Vec<Value>=pos.iter().map(|r|{let qty:f64=r.get("qty");let avg:f64=r.get("avg");let last:f64=r.get("last");json!({"provider":r.get::<String,_>("provider"),"symbol":r.get::<String,_>("symbol"),"qty":qty,"avg":avg,"last":last,"unrealizedPnl":qty*(last-avg)})}).collect();
    let cash: f64 = a.get("cash");
    let equity = cash
        + positions
            .iter()
            .map(|p| p["qty"].as_f64().unwrap() * p["last"].as_f64().unwrap())
            .sum::<f64>();
    let unreal = positions
        .iter()
        .map(|p| p["unrealizedPnl"].as_f64().unwrap())
        .sum::<f64>();
    let orders = sqlx::query("SELECT * FROM local_orders ORDER BY created_at DESC LIMIT 1000")
        .fetch_all(&app.db)
        .await?;
    let fills = sqlx::query("SELECT * FROM local_fills ORDER BY time DESC LIMIT 1000")
        .fetch_all(&app.db)
        .await?;
    Ok(
        json!({"startingCash":a.get::<f64,_>("starting_cash"),"cash":cash,"equity":equity,"unrealizedPnl":unreal,"realizedPnl":a.get::<f64,_>("realized_pnl"),"totalFees":a.get::<f64,_>("total_fees"),"positions":positions,"orders":orders.iter().map(|r|json!({"id":r.get::<String,_>("id"),"client_order_id":r.get::<String,_>("client_order_id"),"provider":r.get::<String,_>("provider"),"symbol":r.get::<String,_>("symbol"),"side":r.get::<String,_>("side"),"type":r.get::<String,_>("type"),"qty":r.get::<f64,_>("qty"),"price":r.get::<Option<f64>,_>("price"),"stopPrice":r.get::<Option<f64>,_>("stop_price"),"status":r.get::<String,_>("status"),"createdAt":r.get::<i64,_>("created_at"),"source":"manual-local-real-quote","feed":r.get::<String,_>("feed"),"error":r.get::<Option<String>,_>("error")})).collect::<Vec<_>>(),"fills":fills.iter().map(|r|json!({"id":r.get::<String,_>("id"),"orderId":r.get::<String,_>("order_id"),"provider":r.get::<String,_>("provider"),"symbol":r.get::<String,_>("symbol"),"side":r.get::<String,_>("side"),"qty":r.get::<f64,_>("qty"),"price":r.get::<f64,_>("price"),"time":r.get::<i64,_>("time"),"fee":r.get::<f64,_>("fee"),"marketCursor":r.get::<i64,_>("market_cursor"),"feed":r.get::<String,_>("feed")})).collect::<Vec<_>>(),"quotePolicy":{"commissionBps":a.get::<f64,_>("commission_bps"),"maxQuoteAgeMs":15000,"maxGrossLeverage":1,"currency":"USD","execution":"ask/bid preferred, source last reference fallback","requiresConnected":true,"executableProviders":["coinbase","alpaca"],"rejectUnknownOrDelayedQuotes":true,"pineLedgerImported":false}}),
    )
}
pub async fn on_quote(
    app: &App,
    cursor: i64,
    provider: &str,
    symbol: &str,
    feed: &str,
    event_time: i64,
    received: i64,
    quote: &Value,
    identity: &Value,
    quality: &Value,
) -> anyhow::Result<()> {
    market::execution_eligibility(identity, quality)?;
    anyhow::ensure!(
        identity["provider"] == provider
            && identity["symbol"] == symbol
            && identity["feed"] == feed,
        "Execution quote identity mismatch"
    );
    if market::now() - event_time > 15000
        || market::now() - received > 15000
        || event_time > market::now() + 5000
    {
        return Ok(());
    }
    let mark = quote_mark(quote).ok_or_else(|| anyhow::anyhow!("No valid execution quote"))?;
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE local_positions SET last=?,last_event_time=? WHERE provider=? AND symbol=? AND last_event_time<=?")
        .bind(mark)
        .bind(event_time)
        .bind(provider)
        .bind(symbol)
        .bind(event_time)
        .execute(&mut *tx)
        .await?;
    let orders=sqlx::query("SELECT * FROM local_orders WHERE provider=? AND symbol=? AND feed=? AND status IN ('working','triggered') ORDER BY created_at,rowid").bind(provider).bind(symbol).bind(feed).fetch_all(&mut *tx).await?;
    for order in orders {
        let request: Value = serde_json::from_str(&order.get::<String, _>("request"))?;
        // Sockets can serve regular and extended charts together. The order's
        // own session controls fills; a chart subscription cannot expand it.
        if !order_session_open(identity, &request, event_time)? {
            continue;
        }
        if request["afterEventTime"]
            .as_i64()
            .is_some_and(|after| event_time < after)
        {
            continue;
        }
        let id: String = order.get("id");
        let side: String = order.get("side");
        let kind: String = order.get("type");
        let price = quote_price(quote, &side).unwrap();
        let limit: Option<f64> = order.get("price");
        let stop: Option<f64> = order.get("stop_price");
        let status: String = order.get("status");
        if kind.starts_with("stop") && status == "working" {
            let crossed = if side == "buy" {
                mark >= stop.unwrap()
            } else {
                mark <= stop.unwrap()
            };
            if !crossed {
                continue;
            }
            sqlx::query("UPDATE local_orders SET status='triggered' WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
        if ["limit", "stop-limit"].contains(&kind.as_str())
            && !if side == "buy" {
                price <= limit.unwrap()
            } else {
                price >= limit.unwrap()
            }
        {
            continue;
        }
        let qty: f64 = order.get("qty");
        let delta = if side == "buy" { qty } else { -qty };
        let account = sqlx::query("SELECT * FROM local_account WHERE id=1")
            .fetch_one(&mut *tx)
            .await?;
        let cash: f64 = account.get("cash");
        let fee = qty * price * account.get::<f64, _>("commission_bps") / 10000.;
        let position =
            sqlx::query("SELECT qty,avg FROM local_positions WHERE provider=? AND symbol=?")
                .bind(provider)
                .bind(symbol)
                .fetch_optional(&mut *tx)
                .await?;
        let old = position
            .as_ref()
            .map(|r| r.get::<f64, _>("qty"))
            .unwrap_or(0.);
        let avg = position
            .as_ref()
            .map(|r| r.get::<f64, _>("avg"))
            .unwrap_or(price);
        let next = old + delta;
        let other =
            sqlx::query("SELECT qty,last FROM local_positions WHERE NOT(provider=? AND symbol=?)")
                .bind(provider)
                .bind(symbol)
                .fetch_all(&mut *tx)
                .await?;
        let other_value = other
            .iter()
            .map(|r| r.get::<f64, _>("qty") * r.get::<f64, _>("last"))
            .sum::<f64>();
        let gross = other
            .iter()
            .map(|r| (r.get::<f64, _>("qty") * r.get::<f64, _>("last")).abs())
            .sum::<f64>()
            + next.abs() * price;
        let next_cash = cash - delta * price - fee;
        let equity = next_cash + next * price + other_value;
        if !gross.is_finite()
            || !equity.is_finite()
            || !next_cash.is_finite()
            || !fee.is_finite()
            || (next.abs() > old.abs() && (gross > equity + 1e-8 || equity <= 0.))
        {
            sqlx::query("UPDATE local_orders SET status='rejected',error='gross leverage/buying power exceeded' WHERE id=?").bind(&id).execute(&mut *tx).await?;
            continue;
        }
        let closed = if old * delta < 0. {
            old.abs().min(delta.abs())
        } else {
            0.
        };
        let realized = closed * (price - avg) * old.signum() - fee;
        let next_avg = if next == 0. {
            0.
        } else if old * delta >= 0. {
            (old.abs() * avg + delta.abs() * price) / next.abs()
        } else if old.abs() >= delta.abs() {
            avg
        } else {
            price
        };
        sqlx::query("UPDATE local_account SET cash=?,realized_pnl=realized_pnl+?,total_fees=total_fees+? WHERE id=1").bind(next_cash).bind(realized).bind(fee).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO local_positions(provider,symbol,qty,avg,last,last_event_time) VALUES(?,?,?,?,?,?) ON CONFLICT(provider,symbol) DO UPDATE SET qty=excluded.qty,avg=excluded.avg,last=excluded.last,last_event_time=excluded.last_event_time").bind(provider).bind(symbol).bind(next).bind(next_avg).bind(mark).bind(event_time).execute(&mut *tx).await?;
        let fill = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO local_fills(id,order_id,provider,symbol,side,qty,price,time,fee,market_cursor,feed) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&fill)
            .bind(&id)
            .bind(provider)
            .bind(symbol)
            .bind(&side)
            .bind(qty)
            .bind(price)
            .bind(event_time)
            .bind(fee)
            .bind(cursor)
            .bind(feed)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE local_orders SET status='filled' WHERE id=? AND status IN ('working','triggered')").bind(&id).execute(&mut *tx).await?;
        sqlx::query(
            "INSERT INTO local_order_events(order_id,kind,payload,time) VALUES(?,'filled',?,?)",
        )
        .bind(&id)
        .bind(
            json!({"fillId":fill,"price":price,"qty":qty,"fee":fee,"marketCursor":cursor})
                .to_string(),
        )
        .bind(market::now())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_quote_side_and_mark() {
        let v = json!({"price":"100","best_bid":"99","best_ask":"101"});
        assert_eq!(quote_price(&v, "buy"), Some(101.));
        assert_eq!(quote_price(&v, "sell"), Some(99.));
        assert_eq!(quote_mark(&v), Some(100.));
        assert_eq!(quote_mark(&json!({"bid":99.,"ask":101.})), Some(100.));
        assert_eq!(quote_mark(&json!({"price":0})), None);
    }
    #[test]
    fn order_session_is_independent_of_the_chart_subscription() -> anyhow::Result<()> {
        let at = |value: &str| {
            chrono::DateTime::parse_from_rfc3339(value)
                .unwrap()
                .timestamp_millis()
        };
        let mut stock = market::identity("alpaca", "SPY", "1m", "sip", "none")?;
        stock["session"] = json!("extended");
        let regular = json!({});
        let extended = json!({"session":"extended"});
        assert!(order_session_open(
            &stock,
            &regular,
            at("2026-10-14T14:00:00Z")
        )?);
        assert!(order_session_open(
            &stock,
            &extended,
            at("2026-10-14T14:00:00Z")
        )?);
        assert!(!order_session_open(
            &stock,
            &regular,
            at("2026-10-14T21:00:00Z")
        )?);
        assert!(order_session_open(
            &stock,
            &extended,
            at("2026-10-14T21:00:00Z")
        )?);
        assert!(!order_session_open(
            &stock,
            &extended,
            at("2026-10-15T02:00:00Z")
        )?);
        assert!(
            order_session_open(
                &stock,
                &json!({"session":"overnight"}),
                at("2026-10-15T02:00:00Z")
            )
            .is_err()
        );
        let night = market::identity("alpaca", "SPY", "1m", "boats", "none")?;
        assert!(order_session_open(
            &night,
            &json!({}),
            at("2026-10-15T02:00:00Z")
        )?);
        assert!(!order_session_open(
            &night,
            &json!({}),
            at("2026-10-15T14:00:00Z")
        )?);
        let crypto = market::identity("coinbase", "TEST-USD", "1m", "public-websocket", "none")?;
        assert!(order_session_open(
            &crypto,
            &json!({}),
            at("2026-10-18T02:00:00Z")
        )?);
        assert!(
            order_session_open(
                &crypto,
                &json!({"session":"regular"}),
                at("2026-10-18T02:00:00Z")
            )
            .is_err()
        );
        Ok(())
    }
}
#[cfg(test)]
mod ledger_tests {
    use super::*;
    #[tokio::test]
    async fn durable_quote_fees_idempotency_stale_and_limits() -> anyhow::Result<()> {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!().run(&db).await?;
        let app = App {
            db,
            token: "test-token-only-not-network".into(),
            root: std::path::PathBuf::from(".."),
            node: std::path::PathBuf::from("/usr/bin/node"),
            execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };
        async fn order(
            app: &App,
            id: &str,
            side: &str,
            kind: &str,
            limit: Option<f64>,
        ) -> anyhow::Result<()> {
            sqlx::query("INSERT INTO local_orders(id,client_order_id,request,provider,symbol,side,type,qty,price,status,created_at) VALUES(?,?, '{}','coinbase','LTC-USD',?,?,2,?,'working',?)").bind(id).bind(id).bind(side).bind(kind).bind(limit).bind(market::now()).execute(&app.db).await?;
            Ok(())
        }
        order(&app, "a", "buy", "market", None).await?;
        let now = market::now();
        let quote = json!({"price":100,"bid":99,"ask":101});
        let identity = json!({"provider":"coinbase","symbol":"LTC-USD","feed":"public-websocket","executionEligible":true,"quoteKind":"executable","delay":{"kind":"realtime"}});
        let quality = json!({"complete":true,"stale":false});
        for change in [
            json!({"executionEligible":false}),
            json!({"quoteKind":"indicative"}),
            json!({"delay":{"kind":"unknown"}}),
            json!({"delay":{"kind":"delayed"}}),
        ] {
            let mut denied = identity.clone();
            for (k, v) in change.as_object().unwrap() {
                denied[k] = v.clone();
            }
            assert!(
                on_quote(
                    &app,
                    0,
                    "coinbase",
                    "LTC-USD",
                    "public-websocket",
                    now,
                    now,
                    &quote,
                    &denied,
                    &quality
                )
                .await
                .is_err()
            );
        }
        assert!(
            on_quote(
                &app,
                0,
                "coinbase",
                "LTC-USD",
                "public-websocket",
                now,
                now,
                &quote,
                &identity,
                &json!({"complete":false})
            )
            .await
            .is_err()
        );
        assert!(
            on_quote(
                &app,
                0,
                "coinbase",
                "LTC-USD",
                "public-websocket",
                now,
                now,
                &quote,
                &identity,
                &json!({"complete":true,"stale":true})
            )
            .await
            .is_err()
        );
        assert_eq!(state(&app).await?["fills"].as_array().unwrap().len(), 0);
        on_quote(
            &app,
            1,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now - 20000,
            now,
            &quote,
            &identity,
            &quality,
        )
        .await?;
        assert_eq!(state(&app).await?["fills"].as_array().unwrap().len(), 0);
        on_quote(
            &app,
            2,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &quote,
            &identity,
            &quality,
        )
        .await?;
        on_quote(
            &app,
            2,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &quote,
            &identity,
            &quality,
        )
        .await?;
        let s = state(&app).await?;
        assert_eq!(s["fills"].as_array().unwrap().len(), 1);
        assert!((s["cash"].as_f64().unwrap() - 99797.899).abs() < 1e-8);
        assert_eq!(s["positions"][0]["qty"], 2.);
        order(&app, "b", "sell", "limit", Some(110.)).await?;
        on_quote(
            &app,
            3,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &json!({"price":110,"bid":109,"ask":111}),
            &identity,
            &quality,
        )
        .await?;
        assert_eq!(state(&app).await?["fills"].as_array().unwrap().len(), 1);
        execute(&app, "account.modifyOrder", &json!({"id":"b","price":109.})).await?;
        on_quote(
            &app,
            4,
            "coinbase",
            "LTC-USD",
            "public-websocket",
            now,
            now,
            &json!({"price":110,"bid":109,"ask":111}),
            &identity,
            &quality,
        )
        .await?;
        let s = state(&app).await?;
        assert_eq!(s["fills"].as_array().unwrap().len(), 2);
        assert!(s["positions"].as_array().unwrap().is_empty());
        assert!((s["cash"].as_f64().unwrap() - 100015.79).abs() < 1e-8);
        assert!((s["realizedPnl"].as_f64().unwrap() - 15.79).abs() < 1e-8);
        assert!((s["totalFees"].as_f64().unwrap() - 0.21).abs() < 1e-8);
        Ok(())
    }
    #[tokio::test]
    async fn cached_indicative_quotes_cannot_fill_new_orders() -> anyhow::Result<()> {
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
        let identity = market::identity("alpaca", "SPY", "1m", "overnight", "none")?;
        sqlx::query("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('indicative','alpaca','SPY','1m',?,'connected','overnight')").bind(identity.to_string()).execute(&app.db).await?;
        let now = market::now();
        sqlx::query("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES('indicative','quote',?,?,'{\"price\":100,\"bid\":99,\"ask\":101}','{\"complete\":true,\"stale\":false}')").bind(now).bind(now).execute(&app.db).await?;
        let placed=execute(&app,"account.placeOrder",&json!({"provider":"alpaca","symbol":"SPY","feed":"overnight","side":"buy","type":"market","qty":1,"client_order_id":"fixture-cached-indicative"})).await?;
        assert_eq!(placed["status"], "rejected");
        assert_eq!(state(&app).await?["fills"].as_array().unwrap().len(), 0);
        Ok(())
    }
}
