use super::*;
pub async fn coinbase_products() -> anyhow::Result<Vec<Value>> {
    let values =
        super::http::get("https://api.exchange.coinbase.com/products", &[], None, 300).await?;
    let rows = values
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid product catalog"))?;
    Ok(rows.iter().map(|v|json!({"symbol":v["id"],"symbolId":format!("COINBASE:{}",v["id"].as_str().unwrap_or("")),"venue":"COINBASE","assetClass":"crypto","currency":v["quote_currency"],"baseCurrency":v["base_currency"],"provider":"coinbase","name":v["display_name"],"priceIncrement":v["quote_increment"],"quantityIncrement":v["base_increment"],"status":v["status"],"tradingDisabled":v["trading_disabled"]})).collect())
}
pub async fn enrich(app: &App, mut identity: Value) -> anyhow::Result<Value> {
    let provider = identity["provider"].as_str().unwrap_or("");
    let symbol = identity["symbol"].as_str().unwrap_or("").to_string();
    match provider {
        "coinbase" => {
            let value = super::http::get(
                &format!("https://api.exchange.coinbase.com/products/{symbol}"),
                &[],
                None,
                300,
            )
            .await?;
            identity["currency"] = value["quote_currency"].clone();
            identity["baseCurrency"] = value["base_currency"].clone();
            identity["priceIncrement"] = value["quote_increment"].clone();
            identity["quantityIncrement"] = value["base_increment"].clone();
            identity["tickSize"] = json!(
                value["quote_increment"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
            );
            identity["sizeIncrement"] = json!(
                value["base_increment"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
            );
            identity["pricePrecision"] = json!(value["quote_increment"].as_str().map(|s| {
                s.trim_end_matches('0')
                    .split_once('.')
                    .map(|(_, d)| d.len())
                    .unwrap_or(0)
            }));
            identity["status"] = value["status"].clone();
            identity["symbolId"] = json!(format!("COINBASE:{symbol}"));
        }
        "yahoo" => {
            let quote = super::stream::yahoo_quote(&symbol).await?;
            let metadata = &quote["metadata"];
            identity = from_yahoo(identity, metadata);
        }
        "alpaca" => {
            let (key, secret) = crate::connections::alpaca_credentials(app).await?;
            let value = super::http::get(
                &format!("https://paper-api.alpaca.markets/v2/assets/{symbol}"),
                &[],
                Some((&key, &secret)),
                300,
            )
            .await?;
            identity["venue"] = value["exchange"].clone();
            identity["assetClass"] = value["class"].clone();
            identity["symbolId"] = json!(format!(
                "ALPACA:{}:{symbol}",
                value["exchange"].as_str().unwrap_or("unknown")
            ));
            identity["assetId"] = value["id"].clone();
            identity["overnightTradable"] = value["overnight_tradable"].clone();
            identity["overnightHalted"] = value["overnight_halted"].clone();
            identity["tradable"] = value["tradable"].clone();
            identity["fractionable"] = value["fractionable"].clone();
        }
        _ => anyhow::bail!("Unsupported instrument provider"),
    };
    Ok(identity)
}
pub fn from_yahoo(mut identity: Value, metadata: &Value) -> Value {
    identity["venue"] = metadata["exchangeName"].clone();
    identity["venueName"] = metadata["fullExchangeName"].clone();
    identity["currency"] = metadata["currency"].clone();
    identity["timezone"] = metadata["exchangeTimezoneName"].clone();
    identity["assetClass"] = json!(
        metadata["instrumentType"]
            .as_str()
            .unwrap_or("unknown")
            .to_lowercase()
    );
    identity["symbolId"] = json!(format!(
        "YAHOO:{}:{}",
        metadata["exchangeName"].as_str().unwrap_or("unknown"),
        identity["symbol"].as_str().unwrap_or("")
    ));
    identity["pricePrecision"] = metadata["priceHint"].clone();
    identity["tickSize"] = json!(10f64.powi(-metadata["priceHint"].as_i64().unwrap_or(2) as i32));
    identity["delay"]["seconds"] = metadata["exchangeDataDelayedBy"].clone();
    identity
}
