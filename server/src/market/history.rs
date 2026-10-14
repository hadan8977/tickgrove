use super::*;
use chrono::{DateTime, Utc};
use std::collections::BTreeMap;
fn timestamp(v: &Value, name: &str) -> anyhow::Result<i64> {
    if let Some(n) = v[name].as_i64() {
        return Ok(n);
    }
    if let Some(s) = v[name].as_str() {
        return Ok(DateTime::parse_from_rfc3339(s)?.timestamp());
    }
    anyhow::bail!("{name} must be Unix seconds or RFC3339")
}
async fn get(
    url: &str,
    query: &[(String, String)],
    headers: Option<(&str, &str)>,
) -> anyhow::Result<Value> {
    let mut request = client()?.get(url).query(query);
    if let Some((key, secret)) = headers {
        request = request
            .header("APCA-API-KEY-ID", key)
            .header("APCA-API-SECRET-KEY", secret)
    }
    let response = request.send().await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Provider response {}",
        response.status()
    );
    Ok(response.json().await?)
}
fn num(v: &Value) -> anyhow::Result<f64> {
    let n = v
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("Provider missing numeric OHLCV"))?;
    anyhow::ensure!(n.is_finite(), "Nonfinite provider number");
    Ok(n)
}
pub async fn fetch(app: &App, p: &Value) -> anyhow::Result<Value> {
    fetch_internal(app, p, true).await
}
pub async fn fetch_ephemeral(app: &App, p: &Value) -> anyhow::Result<Value> {
    fetch_internal(app, p, false).await
}
async fn fetch_internal(app: &App, p: &Value, persist: bool) -> anyhow::Result<Value> {
    let _permit = super::HTTP_BUDGET.acquire().await?;
    let provider = required(p, "provider")?;
    let symbol = required(p, "symbol")?;
    let tf = p["timeframe"].as_str().unwrap_or("1D");
    let step = seconds(tf)?;
    let start = timestamp(p, "start")?;
    let requested_end = timestamp(p, "end")?;
    let confirmation = if provider == "coinbase" {
        super::confirmation_seconds()
    } else {
        0
    };
    let end = requested_end.min(now() / 1000 - confirmation);
    anyhow::ensure!(
        start < end && requested_end <= now() / 1000,
        "Invalid history interval/future end"
    );
    anyhow::ensure!(
        (end - start) / step <= 20_000,
        "Requested range exceeds 20000 buckets"
    );
    let adjustment = p["adjustment"]
        .as_str()
        .unwrap_or(if provider == "coinbase" {
            "none"
        } else {
            "raw"
        });
    let feed = p["feed"].as_str().unwrap_or(if provider == "alpaca" {
        "iex"
    } else {
        "public"
    });
    let mut meta = identity(provider, symbol, tf, feed, adjustment)?;
    if let Some(session) = p["session"].as_str() {
        anyhow::ensure!(
            (provider == "yahoo" && ["regular", "extended"].contains(&session))
                || (provider == "coinbase" && session == "24x7")
                || (provider == "alpaca" && Some(session) == meta["session"].as_str()),
            "Unsupported provider/session selection"
        );
        meta["session"] = json!(session);
    }
    if provider != "yahoo" {
        meta = instruments::enrich(meta).await?;
    }
    let mut bars = BTreeMap::new();
    let mut gaps = Vec::new();
    let mut trimmed = Vec::new();
    let mut pages = 0;
    let mut raw_meta = Value::Null;
    match provider {
        "coinbase" => {
            let granularity = if step == 14400 {
                3600
            } else if step == 604800 {
                86400
            } else {
                step
            };
            let mut cursor = start / granularity * granularity;
            while cursor < end {
                let until = (cursor + granularity * 299).min(end);
                let url = format!("https://api.exchange.coinbase.com/products/{symbol}/candles");
                let response = get(
                    &url,
                    &[
                        ("granularity".into(), granularity.to_string()),
                        (
                            "start".into(),
                            DateTime::<Utc>::from_timestamp(cursor, 0)
                                .unwrap()
                                .to_rfc3339(),
                        ),
                        (
                            "end".into(),
                            DateTime::<Utc>::from_timestamp(until, 0)
                                .unwrap()
                                .to_rfc3339(),
                        ),
                    ],
                    None,
                )
                .await?;
                pages += 1;
                for row in response
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid Coinbase candle response"))?
                {
                    let time = row[0]
                        .as_i64()
                        .ok_or_else(|| anyhow::anyhow!("Invalid candle timestamp"))?;
                    if time >= start && time + granularity <= end {
                        bars.insert(
                            time,
                            Bar {
                                time,
                                close_time: time + granularity,
                                low: num(&row[1])?,
                                high: num(&row[2])?,
                                open: num(&row[3])?,
                                close: num(&row[4])?,
                                volume: num(&row[5])?,
                            },
                        );
                    }
                }
                cursor = until;
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            }
            let gran = if step == 14400 {
                3600
            } else if step == 604800 {
                86400
            } else {
                step
            };
            let mut cursor = ((start + gran - 1) / gran) * gran;
            while cursor + gran <= end {
                if !bars.contains_key(&cursor) {
                    gaps.push(json!({"start":cursor,"end":cursor+gran,"reason":"provider omitted bucket; no synthetic replacement"}));
                }
                cursor += gran;
            }
        }
        "yahoo" => {
            anyhow::ensure!(
                ["raw", "split-dividend-adjusted"].contains(&adjustment),
                "Yahoo adjustment must be raw or split-dividend-adjusted"
            );
            let interval = match step {
                60 => "1m",
                300 => "5m",
                900 => "15m",
                3600 | 14400 => "60m",
                86400 | 604800 => {
                    if meta["session"] == "extended" {
                        "60m"
                    } else {
                        "1d"
                    }
                }
                _ => anyhow::bail!("Yahoo timeframe unavailable"),
            };
            let response = get(
                &format!("https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"),
                &[
                    ("period1".into(), start.to_string()),
                    ("period2".into(), end.to_string()),
                    ("interval".into(), interval.into()),
                    (
                        "includePrePost".into(),
                        if meta["session"] == "extended" {
                            "true"
                        } else {
                            "false"
                        }
                        .into(),
                    ),
                    ("events".into(), "div,splits".into()),
                ],
                None,
            )
            .await?;
            pages = 1;
            let result = &response["chart"]["result"][0];
            anyhow::ensure!(
                response["chart"]["error"].is_null() && !result.is_null(),
                "Yahoo chart unavailable: {}",
                response["chart"]["error"]
            );
            raw_meta = result["meta"].clone();
            meta = instruments::from_yahoo(meta, &raw_meta);
            anyhow::ensure!(
                meta["timezone"] == "America/New_York",
                "History requires supported exchange calendar; this instrument timezone is not XNYS"
            );
            meta["venue"] = result["meta"]["exchangeName"].clone();
            meta["currency"] = result["meta"]["currency"].clone();
            meta["timezone"] = result["meta"]["exchangeTimezoneName"].clone();
            meta["delay"]["seconds"] = result["meta"]["exchangeDataDelayedBy"].clone();
            let times = result["timestamp"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Yahoo returned no timestamps"))?;
            let quote = &result["indicators"]["quote"][0];
            let adj = &result["indicators"]["adjclose"][0]["adjclose"];
            let mut base_identity = meta.clone();
            base_identity["timeframe"] = json!(if step >= 86400 && meta["session"] != "extended" {
                "1D"
            } else if step >= 3600 {
                "1H"
            } else {
                tf
            });
            for (i, t) in times.iter().enumerate() {
                let time = t
                    .as_i64()
                    .ok_or_else(|| anyhow::anyhow!("Bad Yahoo timestamp"))?;
                if time < start || time >= end {
                    continue;
                }
                let Some((_, close_time)) = super::period::bounds(&base_identity, time)? else {
                    trimmed.push(json!({"time":time,"reason":"provider timestamp outside selected session; source row excluded without rewriting"}));
                    continue;
                };
                let values = [
                    &quote["open"][i],
                    &quote["high"][i],
                    &quote["low"][i],
                    &quote["close"][i],
                    &quote["volume"][i],
                ];
                if values.iter().any(|v| v.is_null()) {
                    gaps.push(json!({"start":time,"reason":"Yahoo null OHLCV"}));
                    continue;
                }
                let mut b = Bar {
                    time,
                    close_time,
                    open: num(values[0])?,
                    high: num(values[1])?,
                    low: num(values[2])?,
                    close: num(values[3])?,
                    volume: num(values[4])?,
                };
                if adjustment == "split-dividend-adjusted" {
                    let ratio = num(&adj[i])? / b.close;
                    anyhow::ensure!(ratio.is_finite() && ratio > 0., "Missing adjustment factor");
                    b.open *= ratio;
                    b.high *= ratio;
                    b.low *= ratio;
                    b.close *= ratio;
                }
                if b.close_time <= end {
                    bars.insert(time, b);
                }
            }
        }
        "alpaca" => {
            anyhow::ensure!(
                ["iex", "sip", "boats", "overnight"].contains(&feed),
                "Unsupported Alpaca feed"
            );
            anyhow::ensure!(
                ["raw", "split", "dividend", "all"].contains(&adjustment),
                "Unsupported Alpaca adjustment"
            );
            let key = std::env::var("ALPACA_API_KEY")
                .map_err(|_| anyhow::anyhow!("Dedicated Alpaca market key not configured"))?;
            let secret = std::env::var("ALPACA_API_SECRET")
                .map_err(|_| anyhow::anyhow!("Dedicated Alpaca market secret not configured"))?;
            let tf = match step {
                60 => "1Min",
                300 => "5Min",
                900 => "15Min",
                3600 => "1Hour",
                14400 => "4Hour",
                86400 => "1Day",
                604800 => "1Day",
                _ => anyhow::bail!("Unsupported Alpaca period"),
            };
            let mut token: Option<String> = None;
            loop {
                let mut query = vec![
                    (
                        "start".into(),
                        DateTime::<Utc>::from_timestamp(start, 0)
                            .unwrap()
                            .to_rfc3339(),
                    ),
                    (
                        "end".into(),
                        DateTime::<Utc>::from_timestamp(end, 0)
                            .unwrap()
                            .to_rfc3339(),
                    ),
                    ("timeframe".into(), tf.into()),
                    ("feed".into(), feed.into()),
                    ("adjustment".into(), adjustment.into()),
                    ("limit".into(), "10000".into()),
                ];
                if let Some(t) = &token {
                    query.push(("page_token".into(), t.clone()));
                }
                let response = get(
                    &format!("https://data.alpaca.markets/v2/stocks/{symbol}/bars"),
                    &query,
                    Some((&key, &secret)),
                )
                .await?;
                pages += 1;
                anyhow::ensure!(pages <= 100, "Alpaca pagination exceeded budget");
                for row in response["bars"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid Alpaca bars"))?
                {
                    let time = DateTime::parse_from_rfc3339(
                        row["t"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("Missing bar timestamp"))?,
                    )?
                    .timestamp();
                    let time = if step >= 86400 && feed != "boats" && feed != "overnight" {
                        let date = DateTime::from_timestamp(time, 0)
                            .unwrap()
                            .with_timezone(&chrono_tz::America::New_York)
                            .date_naive();
                        calendar::session(date)?
                            .ok_or_else(|| anyhow::anyhow!("Daily bar on closed session"))?
                            .0
                    } else {
                        time
                    };
                    let bar = Bar {
                        time,
                        close_time: if feed == "boats" || feed == "overnight" {
                            time + step
                        } else {
                            calendar::bar_close(time, if step == 604800 { 86400 } else { step })?
                        },
                        open: num(&row["o"])?,
                        high: num(&row["h"])?,
                        low: num(&row["l"])?,
                        close: num(&row["c"])?,
                        volume: num(&row["v"])?,
                    };
                    if time >= start && bar.close_time <= end {
                        bars.insert(time, bar);
                    }
                }
                let next = response["next_page_token"].as_str().map(String::from);
                if next.is_none() {
                    break;
                }
                anyhow::ensure!(next != token, "Alpaca pagination repeated token");
                token = next;
            }
        }
        _ => anyhow::bail!("Unsupported history provider"),
    }
    if provider == "yahoo" {
        let base = if step >= 86400 && meta["session"] != "extended" {
            86400
        } else {
            step.min(3600)
        };
        let mut base_identity = meta.clone();
        base_identity["timeframe"] = json!(match base {
            60 => "1m",
            300 => "5m",
            900 => "15m",
            3600 => "1H",
            _ => "1D",
        });
        for time in super::period::expected_base_times(&meta, start, end, base)? {
            if super::period::bounds(&base_identity, time)?.is_some_and(|(_, close)| close <= end)
                && !bars.contains_key(&time)
            {
                gaps.push(json!({"start":time,"end":super::period::bounds(&base_identity,time)?.unwrap().1,"reason":"Yahoo omitted source bucket; inactivity versus transport/provider gap is unverified"}));
            }
        }
    }
    if (provider != "alpaca" && step == 14400)
        || step == 604800
        || (provider == "yahoo" && meta["session"] == "extended" && step == 86400)
    {
        let base = if step == 604800 && meta["session"] != "extended" {
            86400
        } else {
            3600
        };
        let mut groups: BTreeMap<i64, Vec<Bar>> = BTreeMap::new();
        for b in bars.values() {
            if let Some((anchor, _)) = super::period::bounds(&meta, b.time)? {
                groups.entry(anchor).or_default().push(b.clone());
            }
        }
        let mut aggregate = BTreeMap::new();
        for (anchor, group) in groups {
            let (_, target_end) = super::period::bounds(&meta, group[0].time)?.unwrap();
            if anchor < start || target_end > end {
                trimmed.push(json!({"start":anchor,"end":target_end,"reason":"requested interval does not include a complete closed aggregate"}));
                continue;
            }
            let expected = super::period::expected_base_times(&meta, anchor, target_end, base)?;
            let actual: Vec<i64> = group.iter().map(|b| b.time).collect();
            if actual != expected || group.last().unwrap().close_time != target_end {
                gaps.push(
                    json!({"start":anchor,"end":target_end,"reason":"aggregate has missing source buckets; available real OHLCV only"}),
                );
                if p["allowGaps"] != true {
                    continue;
                }
            }
            let mut b = group[0].clone();
            b.time = anchor;
            b.close_time = target_end;
            for c in group.iter().skip(1) {
                b.high = b.high.max(c.high);
                b.low = b.low.min(c.low);
                b.close = c.close;
                b.volume += c.volume;
            }
            aggregate.insert(anchor, b);
        }
        bars = aggregate;
    }
    if provider == "coinbase" {
        for bar in bars.values_mut() {
            *bar = super::normalize_bar(bar.clone(), &meta);
        }
    }
    anyhow::ensure!(
        !bars.is_empty(),
        "Provider returned no complete closed bars"
    );
    anyhow::ensure!(bars.len() <= 20_000, "Normalized snapshot exceeds budget");
    anyhow::ensure!(
        gaps.is_empty() || p["allowGaps"] == true,
        "Provider missing {} buckets; retry narrower interval or explicitly accept gaps",
        gaps.len()
    );
    let provenance = json!({"provider":provider,"feed":feed,"requestedStart":start,"requestedEnd":requested_end,"confirmedThrough":end,"confirmationLagSeconds":confirmation,"receivedAt":now(),"eventTime":bars.values().last().unwrap().close_time*1000,"pages":pages,"realMarketData":true,"synthetic":false,"rawMetadata":raw_meta,"trimmedPartialPeriods":trimmed,"calendarPolicy":if provider=="coinbase"{"UTC 24x7 buckets"}else{"Versioned XNYS 1990–2035 exchange_calendars 4.11.2; IANA New York DST; future unscheduled closures need update; outside range rejects"},"gaps":gaps});
    let data = json!({"symbol":symbol,"timeframe":tf,"metadata":{"type":meta["assetClass"],"prefix":meta["venue"],"mintick":meta["tickSize"],"mincontract":meta["sizeIncrement"].as_f64().unwrap_or(1.),"minmove":1,"pricescale":meta["tickSize"].as_f64().map(|tick|1./tick),"basecurrency":meta["baseCurrency"],"pricePrecision":meta["pricePrecision"],"timezone":meta["timezone"],"currency":meta["currency"],"session":meta["session"],"provider":provider,"adjustment":adjustment,"identity":meta,"provenance":provenance},"bars":bars.values().collect::<Vec<_>>()});
    crate::commands::validate_data(&data)?;
    let payload = data.to_string();
    let digest = crate::commands::hash(&payload);
    let id = uuid::Uuid::new_v4().to_string();
    if persist {
        sqlx::query("INSERT INTO snapshots(id,payload,hash) VALUES(?,?,?)")
            .bind(&id)
            .bind(payload)
            .bind(&digest)
            .execute(&app.db)
            .await?;
    }
    Ok(
        json!({"snapshot_id":if persist{json!(id)}else{Value::Null},"hash":digest,"bars":bars.len(),"data":data,"identity":meta,"provenance":provenance,"gaps":gaps}),
    )
}
