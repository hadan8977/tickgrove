//! Minimal reader for Yahoo's public PricingData wire protocol (documented by
//! yfinance/pricing.proto). No generated or copied third-party implementation.
use base64::Engine;
use serde_json::{Value, json};
fn varint(bytes: &[u8], cursor: &mut usize) -> anyhow::Result<u64> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let b = *bytes
            .get(*cursor)
            .ok_or_else(|| anyhow::anyhow!("Truncated protobuf"))?;
        *cursor += 1;
        if shift >= 64 {
            anyhow::bail!("Oversized protobuf varint")
        }
        value |= ((b & 127) as u64) << shift;
        if b & 128 == 0 {
            return Ok(value);
        }
    }
    anyhow::bail!("Invalid varint")
}
pub fn decode(text: &str) -> anyhow::Result<Value> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(text)?;
    anyhow::ensure!(bytes.len() <= 65536, "Pricing message too large");
    let mut cursor = 0;
    let mut out = json!({});
    while cursor < bytes.len() {
        let key = varint(&bytes, &mut cursor)?;
        let field = key >> 3;
        let wire = key & 7;
        let value = match wire {
            0 => {
                let n = varint(&bytes, &mut cursor)?;
                if [3, 9, 22, 24, 26, 27].contains(&field) {
                    json!(((n >> 1) as i64) ^ -((n & 1) as i64))
                } else {
                    json!(n)
                }
            }
            2 => {
                let len = varint(&bytes, &mut cursor)? as usize;
                let end = cursor
                    .checked_add(len)
                    .filter(|n| *n <= bytes.len())
                    .ok_or_else(|| anyhow::anyhow!("Bad protobuf string length"))?;
                let s = String::from_utf8_lossy(&bytes[cursor..end]).to_string();
                cursor = end;
                json!(s)
            }
            5 => {
                let end = cursor + 4;
                let slice = bytes
                    .get(cursor..end)
                    .ok_or_else(|| anyhow::anyhow!("Truncated float"))?;
                cursor = end;
                let value = f32::from_le_bytes(slice.try_into().unwrap()) as f64;
                anyhow::ensure!(value.is_finite(), "Non-finite pricing float");
                json!(value)
            }
            1 => {
                cursor += 8;
                anyhow::ensure!(cursor <= bytes.len(), "Truncated fixed64");
                Value::Null
            }
            _ => anyhow::bail!("Unsupported wire type"),
        };
        let name = match field {
            1 => "symbol",
            2 => "price",
            3 => "eventTime",
            4 => "currency",
            5 => "venue",
            6 => "quoteType",
            7 => "marketHours",
            8 => "changePercent",
            9 => "dayVolume",
            10 => "dayHigh",
            11 => "dayLow",
            12 => "change",
            13 => "name",
            15 => "open",
            16 => "previousClose",
            22 => "lastSize",
            23 => "bid",
            24 => "bidSize",
            25 => "ask",
            26 => "askSize",
            27 => "priceHint",
            _ => continue,
        };
        out[name] = value;
    }
    anyhow::ensure!(
        out["symbol"].is_string()
            && out["price"].as_f64().is_some_and(|n| n > 0.)
            && out["eventTime"].as_i64().is_some(),
        "Incomplete Yahoo pricing message"
    );
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_real_public_pricing_frame() {
        let report: Value = serde_json::from_str(include_str!(
            "../../../docs/acceptance/public-websocket-probe.json"
        ))
        .unwrap();
        let frames = report["sources"][1]["messages"].as_array().unwrap();
        assert!(!frames.is_empty());
        for frame in frames {
            let quote = decode(frame["message"].as_str().unwrap()).unwrap();
            assert_eq!(quote["symbol"], "BTC-USD");
            assert_eq!(quote["currency"], "USD");
            assert!(quote["price"].as_f64().unwrap() > 0.);
            assert!(quote["eventTime"].as_i64().unwrap() > 1_700_000_000_000);
        }
    }
    #[test]
    fn rejects_corrupt_or_truncated_frames() {
        assert!(decode("!!!!").is_err());
        assert!(decode("CgVCVA==").is_err());
        assert!(decode("").is_err());
    }
}
