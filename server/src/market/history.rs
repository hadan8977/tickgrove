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
    super::http::get(url, query, headers, 1).await
}
fn num(v: &Value) -> anyhow::Result<f64> {
    let n = v
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("Provider missing numeric OHLCV"))?;
    anyhow::ensure!(n.is_finite(), "Nonfinite provider number");
    Ok(n)
}
pub async fn fetch(app: &App, p: &Value) -> anyhow::Result<Value> {
    fetch_cached(app, p, true).await
}
pub async fn fetch_ephemeral(app: &App, p: &Value) -> anyhow::Result<Value> {
    fetch_cached(app, p, false).await
}
async fn fetch_cached(app: &App, p: &Value, persist: bool) -> anyhow::Result<Value> {
    let credentials = if p["provider"] == "alpaca" {
        let (k, s) = crate::connections::alpaca_credentials(app).await?;
        crate::commands::hash(&format!("{k}:{s}"))
    } else {
        String::new()
    };
    let key = crate::commands::hash(&format!(
        "history-v3|{}|{}|{}",
        p,
        credentials,
        super::confirmation_seconds()
    ));
    let _lock = super::cache::lock(app, &key).await;
    let mut result = if let Some(v) = super::cache::get(app, &key).await? {
        v
    } else {
        let mut v = fetch_internal(app, p, false).await?;
        super::cache::put(app, &key, p, &mut v).await?;
        v
    };
    if persist {
        crate::commands::validate_data(&result["data"])?;
        let payload = result["data"].to_string();
        let hash = crate::commands::hash(&payload);
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM snapshots WHERE hash=? LIMIT 1")
                .bind(&hash)
                .fetch_optional(&app.db)
                .await?;
        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        sqlx::query("INSERT OR IGNORE INTO snapshots(id,payload,hash) VALUES(?,?,?)")
            .bind(&id)
            .bind(payload)
            .bind(&hash)
            .execute(&app.db)
            .await?;
        result["snapshot_id"] = json!(id);
    }
    Ok(result)
}
/// Chart pages are ephemeral views, never automatically strategy snapshots.
pub async fn page(app: &App, p: &Value) -> anyhow::Result<Value> {
    let provider = required(p, "provider")?;
    let symbol = required(p, "symbol")?;
    let tf = p["timeframe"].as_str().unwrap_or("1D");
    let step = seconds(tf)?;
    let limit = p["limit"].as_i64().unwrap_or(1000).clamp(1, 5000);
    let latest = now() / 1000
        - if provider == "coinbase" {
            super::confirmation_seconds()
        } else {
            0
        };
    let end = p["before"]
        .as_i64()
        .or(p["end"].as_i64())
        .unwrap_or(latest.div_euclid(60) * 60)
        .min(latest);
    let guard = if provider == "yahoo" {
        match step {
            60 => Some(30 * 86400),
            300 | 900 => Some(60 * 86400),
            3600 | 14400 => Some(730 * 86400),
            _ if p["session"] == "extended" => Some(730 * 86400),
            _ => None,
        }
    } else {
        None
    };
    let coverage = guard
        .map(|age| (now() / 60000) * 60 - age + 120)
        .unwrap_or(631152000); // adapter calendar starts 1990
    let mut span = if provider == "coinbase" {
        step * limit
    } else if step < 86400 {
        (step * limit * 3).max(4 * 86400)
    } else {
        step * limit * 2
    };
    if provider == "yahoo" && step == 60 {
        span = span.min(7 * 86400);
    }
    let start = p["start"]
        .as_i64()
        .unwrap_or((end - span).max(coverage))
        .max(coverage);
    let mut params = p.clone();
    params["start"] = json!(start);
    params["end"] = json!(end);
    params["timeframe"] = json!(tf);
    params["allowGaps"] = json!(true);
    params["allowEmpty"] = json!(true);
    for key in ["before", "limit"] {
        params.as_object_mut().unwrap().remove(key);
    }
    let mut result = if start >= end {
        let meta = identity(
            provider,
            symbol,
            tf,
            p["feed"].as_str().unwrap_or(if provider == "alpaca" {
                "iex"
            } else {
                "public"
            }),
            p["adjustment"].as_str().unwrap_or("raw"),
        )?;
        json!({"snapshot_id":null,"identity":meta,"data":{"symbol":symbol,"timeframe":tf,"metadata":{},"bars":[]},"bars":0,"gaps":[],"provenance":{}})
    } else {
        fetch_cached(app, &params, false).await?
    };
    let bars = result["data"]["bars"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid page bars"))?;
    if bars.len() > limit as usize {
        bars.drain(..bars.len() - limit as usize);
    }
    let first = bars.first().and_then(|b| b["time"].as_i64());
    let last = bars.last().and_then(|b| b["closeTime"].as_i64());
    let count = bars.len();
    let next = first.unwrap_or(start).min(end);
    let coverage = coverage.max(
        result["provenance"]["rawMetadata"]["firstTradeDate"]
            .as_i64()
            .unwrap_or(coverage),
    );
    let has_more = next > coverage && next < end;
    let visible_start = first.unwrap_or(start);
    let visible_end = last.unwrap_or(end);
    let gaps = result["gaps"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|g| {
            let a = g["start"]
                .as_i64()
                .or(g["time"].as_i64())
                .unwrap_or(visible_start);
            let b = g["end"].as_i64().unwrap_or(a + step);
            a < visible_end && b > visible_start
        })
        .collect::<Vec<_>>();
    result["gaps"] = json!(gaps);
    result["provenance"]["gaps"] = json!(gaps);
    result["data"]["metadata"]["provenance"] = result["provenance"].clone();
    result["bars"] = json!(count);
    result["snapshot_id"] = Value::Null;
    result["page"] = json!({"hasMore":has_more,"nextBefore":if has_more{Some(next)}else{None},"limit":limit,"requestedStart":start,"requestedEnd":end,"coverageStart":coverage,"actualStart":first,"actualEnd":last,"reason":if start>=end{"Provider/timeframe history window reached; use a longer interval or import an archive"}else if count==0{"No bars in this window; earlier windows may contain history"}else if !has_more{"Provider/timeframe history window reached"}else{""},"coveragePolicy":if guard.is_some(){"Yahoo public intraday retention (1m:30d, 5m/15m:60d, hourly:730d); 1m requests are split into at most7d pages; availability remains provider controlled"}else{"Versioned calendar from 1990; source listing/history may start later"}});
    result["hash"] = json!(crate::commands::hash(&result["data"].to_string()));
    Ok(result)
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
    let end = requested_end.min(now() / 1000 - confirmation).min(
        if provider == "alpaca" && p["feed"] == "overnight" {
            now() / 1000 - 900
        } else {
            requested_end
        },
    );
    anyhow::ensure!(
        start < end && requested_end <= now() / 1000,
        "Invalid history interval/future end"
    );
    let calendar_budget = if ["yahoo", "alpaca"].contains(&provider) && step < 86400 {
        100_000
    } else {
        20_000
    };
    anyhow::ensure!(
        (end - start) / step <= calendar_budget,
        "Requested range exceeds {calendar_budget} calendar-time buckets; narrow the range or use a longer interval (snapshot limit remains 20000 actual bars)"
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
                || (provider == "alpaca"
                    && (Some(session) == meta["session"].as_str()
                        || (meta["session"] == "regular" && session == "extended"))),
            "Unsupported provider/session selection"
        );
        meta["session"] = json!(session);
    }
    if provider != "yahoo" {
        meta = instruments::enrich(app, meta).await?;
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
            let mut request_start = start;
            while request_start < end {
                let request_end = if step == 60 {
                    (request_start + 7 * 86400).min(end)
                } else {
                    end
                };
                let response = get(
                    &format!("https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"),
                    &[
                        ("period1".into(), request_start.to_string()),
                        ("period2".into(), request_end.to_string()),
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
                pages += 1;
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
                let empty = Vec::new();
                let times = result["timestamp"].as_array().unwrap_or(&empty);
                let quote = &result["indicators"]["quote"][0];
                let adj = &result["indicators"]["adjclose"][0]["adjclose"];
                let mut base_identity = meta.clone();
                base_identity["timeframe"] =
                    json!(if step >= 86400 && meta["session"] != "extended" {
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
                    if time < request_start || time >= request_end {
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
                        anyhow::ensure!(
                            ratio.is_finite() && ratio > 0.,
                            "Missing adjustment factor"
                        );
                        b.open *= ratio;
                        b.high *= ratio;
                        b.low *= ratio;
                        b.close *= ratio;
                    }
                    if b.close_time <= end {
                        bars.insert(time, b);
                    }
                }
                request_start = request_end;
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
            let (key, secret) = crate::connections::alpaca_credentials(app).await?;
            let source_step = if step >= 86400 && meta["session"] == "regular" {
                86400
            } else {
                60
            };
            let tf = match source_step {
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
                    (
                        "feed".into(),
                        if feed == "overnight" { "boats" } else { feed }.into(),
                    ),
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
                    let mut base_meta = meta.clone();
                    base_meta["timeframe"] = json!(if source_step == 86400 { "1D" } else { "1m" });
                    let time = if source_step == 86400 {
                        let date = DateTime::from_timestamp(time, 0)
                            .unwrap()
                            .with_timezone(&chrono_tz::America::New_York)
                            .date_naive();
                        let Some((open, _)) = calendar::session(date)? else {
                            continue;
                        };
                        open
                    } else {
                        time
                    };
                    let Some((_, close_time)) = super::period::bounds(&base_meta, time)? else {
                        continue;
                    };
                    let bar = Bar {
                        time,
                        close_time,
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
    if (provider == "alpaca" && (step != 60 && (step < 86400 || meta["session"] != "regular")))
        || (provider != "alpaca" && step == 14400)
        || step == 604800
        || (provider == "yahoo" && meta["session"] == "extended" && step == 86400)
    {
        let base = if provider == "alpaca" && (step < 86400 || meta["session"] != "regular") {
            60
        } else if step == 604800 && meta["session"] != "extended" {
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
        !bars.is_empty() || p["allowEmpty"] == true,
        "Provider returned no complete closed bars"
    );
    anyhow::ensure!(bars.len() <= 20_000, "Normalized snapshot exceeds budget");
    anyhow::ensure!(
        gaps.is_empty() || p["allowGaps"] == true,
        "Provider missing {} buckets; retry narrower interval or explicitly accept gaps",
        gaps.len()
    );
    if provider == "alpaca" && feed == "overnight" {
        meta["feed"] = json!("boats");
        meta["requestedFeed"] = json!("overnight");
        meta["delay"]["kind"] = json!("delayed");
        meta["delay"]["seconds"] = json!(900);
        meta["executionEligible"] = json!(false);
    }
    let provenance = json!({"provider":provider,"feed":if provider=="alpaca"&&feed=="overnight"{"boats"}else{feed},"requestedFeed":feed,"requestedStart":start,"requestedEnd":requested_end,"confirmedThrough":end,"confirmationLagSeconds":confirmation,"receivedAt":now(),"eventTime":bars.values().last().map(|b|b.close_time*1000),"pages":pages,"realMarketData":true,"synthetic":false,"rawMetadata":raw_meta,"trimmedPartialPeriods":trimmed,"calendarPolicy":if provider=="coinbase"{"UTC 24x7 buckets"}else{"Versioned XNYS 1990–2035 exchange_calendars 4.11.2; IANA New York DST; future unscheduled closures need update; outside range rejects"},"gaps":gaps});
    let data = json!({"symbol":symbol,"timeframe":tf,"metadata":{"type":meta["assetClass"],"prefix":meta["venue"],"mintick":meta["tickSize"],"mincontract":meta["sizeIncrement"].as_f64().unwrap_or(1.),"minmove":1,"pricescale":meta["tickSize"].as_f64().map(|tick|1./tick),"basecurrency":meta["baseCurrency"],"pricePrecision":meta["pricePrecision"],"timezone":meta["timezone"],"currency":meta["currency"],"session":meta["session"],"provider":provider,"adjustment":adjustment,"identity":meta,"provenance":provenance},"bars":bars.values().collect::<Vec<_>>()});
    if !bars.is_empty() {
        crate::commands::validate_data(&data)?;
    }
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
