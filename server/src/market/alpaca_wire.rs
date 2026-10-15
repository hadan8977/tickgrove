//! Normalize official Alpaca websocket fields before public APIs consume them.
use super::*;
pub fn timestamp(v: &Value) -> anyhow::Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(
        v["t"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing Alpaca timestamp"))?,
    )?
    .timestamp_millis())
}
fn positive(v: &Value, key: &str) -> anyhow::Result<f64> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or_else(|| anyhow::anyhow!("Invalid positive Alpaca {key}"))
}
pub fn quote(v: &Value) -> anyhow::Result<Value> {
    let bid = positive(v, "bp")?;
    let ask = positive(v, "ap")?;
    anyhow::ensure!(ask >= bid, "Crossed quote excluded from execution");
    Ok(
        json!({"provider":"alpaca","symbol":v["S"],"price":(bid+ask)/2.,"priceKind":"mid","bid":bid,"ask":ask,"bidSize":v["bs"],"askSize":v["as"],"bidExchange":v["bx"],"askExchange":v["ax"],"eventTime":timestamp(v)?,"receivedAt":now(),"conditions":v["c"],"source":v}),
    )
}
pub fn trade(v: &Value) -> anyhow::Result<Value> {
    let price = positive(v, "p")?;
    let size = v["s"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or_else(|| anyhow::anyhow!("Invalid trade size"))?;
    Ok(
        json!({"provider":"alpaca","symbol":v["S"],"price":price,"priceKind":"last-trade","size":size,"tradeId":v["i"],"exchange":v["x"],"conditions":v["c"],"eventTime":timestamp(v)?,"receivedAt":now(),"source":v}),
    )
}
pub fn minute_bar(v: &Value) -> anyhow::Result<Bar> {
    let time = timestamp(v)? / 1000;
    let b = Bar {
        time,
        close_time: time + 60,
        open: positive(v, "o")?,
        high: positive(v, "h")?,
        low: positive(v, "l")?,
        close: positive(v, "c")?,
        volume: v["v"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.)
            .ok_or_else(|| anyhow::anyhow!("Invalid bar volume"))?,
    };
    anyhow::ensure!(
        b.high >= b.open.max(b.close) && b.low <= b.open.min(b.close) && b.high >= b.low,
        "Invalid Alpaca OHLC"
    );
    Ok(b)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_quote_trade_and_minute() {
        let q = quote(
            &json!({"S":"AAPL","t":"2026-10-13T14:01:00Z","bp":100.,"ap":102.,"bs":4,"as":5}),
        )
        .unwrap();
        assert_eq!(q["price"], 101.);
        assert_eq!(q["bid"], 100.);
        assert_eq!(q["eventTime"], 1791900060000i64);
        let t =
            trade(&json!({"S":"AAPL","t":"2026-10-13T14:01:00Z","p":101.,"s":2,"i":42})).unwrap();
        assert_eq!(t["size"], 2.);
        let b=minute_bar(&json!({"S":"AAPL","t":"2026-10-13T14:01:00Z","o":100.,"h":102.,"l":99.,"c":101.,"v":0})).unwrap();
        assert_eq!(b.close_time - b.time, 60);
        assert_eq!(b.volume, 0.);
        assert!(quote(&json!({"t":"2026-10-13T14:01:00Z","bp":102.,"ap":100.})).is_err());
    }
}
