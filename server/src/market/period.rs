//! Market period boundaries. Quotes never change regular-session bars outside that session.
use super::*;
use chrono::{DateTime, Datelike, TimeZone, Utc};
use chrono_tz::America::New_York;
pub fn bounds(identity: &Value, time: i64) -> anyhow::Result<Option<(i64, i64)>> {
    let step = seconds(identity["timeframe"].as_str().unwrap_or("1m"))?;
    if identity["provider"] == "coinbase" {
        let anchor = if step == 604800 {
            (time - 4 * 86400).div_euclid(step) * step + 4 * 86400
        } else {
            time.div_euclid(step) * step
        };
        return Ok(Some((anchor, anchor + step)));
    }
    let local = DateTime::<Utc>::from_timestamp(time, 0)
        .ok_or_else(|| anyhow::anyhow!("Invalid event time"))?
        .with_timezone(&New_York);
    let date = local.date_naive();
    let overnight = identity["session"] == "overnight";
    if overnight {
        let hour = chrono::Timelike::hour(&local);
        let day = if hour >= 20 {
            date + chrono::Duration::days(1)
        } else if hour < 4 {
            date
        } else {
            return Ok(None);
        };
        if calendar::session(day)?.is_none() {
            return Ok(None);
        }
        let start = New_York
            .from_local_datetime(
                &(day - chrono::Duration::days(1))
                    .and_hms_opt(20, 0, 0)
                    .unwrap(),
            )
            .single()
            .unwrap()
            .timestamp();
        let end = New_York
            .from_local_datetime(&day.and_hms_opt(4, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp();
        let anchor = if step >= 86400 {
            start
        } else {
            start + (time - start).div_euclid(step) * step
        };
        return Ok(Some((anchor, (anchor + step).min(end))));
    }
    let Some((open, close)) = calendar::session(date)? else {
        return Ok(None);
    };
    let extended = identity["session"] == "extended";
    let pre = New_York
        .from_local_datetime(&date.and_hms_opt(4, 0, 0).unwrap())
        .single()
        .unwrap()
        .timestamp();
    let post = close + 4 * 3600;
    let (segment_start, segment_end) = if extended && time >= pre && time < open {
        (pre, open)
    } else if time >= open && time < close {
        (open, close)
    } else if extended && time >= close && time < post {
        (close, post)
    } else {
        return Ok(None);
    };
    if step == 604800 {
        let monday = date - chrono::Duration::days(date.weekday().num_days_from_monday() as i64);
        let mut sessions = Vec::new();
        for n in 0..7 {
            if let Some(s) = calendar::session(monday + chrono::Duration::days(n))? {
                sessions.push(s)
            }
        }
        let first = sessions.first().unwrap();
        let last = sessions.last().unwrap();
        let start = if extended {
            New_York
                .from_local_datetime(
                    &DateTime::<Utc>::from_timestamp(first.0, 0)
                        .unwrap()
                        .with_timezone(&New_York)
                        .date_naive()
                        .and_hms_opt(4, 0, 0)
                        .unwrap(),
                )
                .single()
                .unwrap()
                .timestamp()
        } else {
            first.0
        };
        return Ok(Some((start, last.1 + if extended { 4 * 3600 } else { 0 })));
    }
    if step >= 86400 {
        return Ok(Some((
            if extended { pre } else { open },
            if extended { post } else { close },
        )));
    }
    let anchor = segment_start + (time - segment_start).div_euclid(step) * step;
    Ok(Some((anchor, (anchor + step).min(segment_end))))
}
pub fn expected_base_times(
    identity: &Value,
    start: i64,
    end: i64,
    base: i64,
) -> anyhow::Result<Vec<i64>> {
    let mut times = Vec::new();
    if identity["provider"] == "coinbase" {
        let mut t = start;
        while t < end {
            times.push(t);
            t += base
        }
        return Ok(times);
    }
    let mut day = DateTime::<Utc>::from_timestamp(start, 0)
        .unwrap()
        .with_timezone(&New_York)
        .date_naive();
    let last = DateTime::<Utc>::from_timestamp(end - 1, 0)
        .unwrap()
        .with_timezone(&New_York)
        .date_naive();
    while day <= last {
        if let Some((open, close)) = calendar::session(day)? {
            let pre = New_York
                .from_local_datetime(&day.and_hms_opt(4, 0, 0).unwrap())
                .single()
                .unwrap()
                .timestamp();
            let segments = if identity["session"] == "extended" {
                vec![(pre, open), (open, close), (close, close + 4 * 3600)]
            } else {
                vec![(open, close)]
            };
            for (a, b) in segments {
                let mut t = a;
                while t < b {
                    if t >= start && t < end {
                        times.push(t)
                    }
                    t += base
                }
            }
        }
        day += chrono::Duration::days(1);
    }
    Ok(times)
}
pub fn last_closed(identity: &Value, now: i64) -> anyhow::Result<Option<(i64, i64)>> {
    if let Some((start, _)) = bounds(identity, now)? {
        if let Some(previous) = bounds(identity, start - 1)? {
            if previous.1 <= now {
                return Ok(Some(previous));
            }
        }
    }
    let local = DateTime::<Utc>::from_timestamp(now, 0)
        .unwrap()
        .with_timezone(&New_York);
    for n in 0..14 {
        let date = local.date_naive() - chrono::Duration::days(n);
        if let Some((_, close)) = calendar::session(date)? {
            let end = close
                + if identity["session"] == "extended" {
                    4 * 3600
                } else {
                    0
                };
            if end <= now {
                if let Some(period) = bounds(identity, end - 1)? {
                    if period.1 <= now {
                        return Ok(Some(period));
                    }
                }
            }
        }
    }
    Ok(None)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regular_extended_dst_half_day_week_and_closed_window() {
        let mut identity =
            identity("yahoo", "SPY", "1H", "public-pricing-websocket", "raw").unwrap();
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().timestamp();
        assert_eq!(
            bounds(&identity, at("2026-03-09T13:45:00Z")).unwrap(),
            Some((at("2026-03-09T13:30:00Z"), at("2026-03-09T14:30:00Z")))
        );
        assert!(
            bounds(&identity, at("2026-03-09T12:00:00Z"))
                .unwrap()
                .is_none()
        );
        identity["session"] = json!("extended");
        assert_eq!(
            bounds(&identity, at("2026-03-09T12:50:00Z")).unwrap(),
            Some((at("2026-03-09T12:00:00Z"), at("2026-03-09T13:00:00Z")))
        );
        identity["timeframe"] = json!("1D");
        assert_eq!(
            bounds(&identity, at("2026-11-27T15:00:00Z")).unwrap(),
            Some((at("2026-11-27T09:00:00Z"), at("2026-11-27T22:00:00Z")))
        );
        assert!(
            bounds(&identity, at("2026-11-26T15:00:00Z"))
                .unwrap()
                .is_none()
        );
        identity["timeframe"] = json!("1W");
        assert_eq!(
            bounds(&identity, at("2026-09-08T13:30:00Z"))
                .unwrap()
                .unwrap()
                .0,
            at("2026-09-08T08:00:00Z")
        );
    }
}
pub fn next(identity: &Value, after: i64) -> anyhow::Result<Option<(i64, i64)>> {
    if let Some(period) = bounds(identity, after)? {
        return Ok(Some(period));
    }
    let date = DateTime::<Utc>::from_timestamp(after, 0)
        .unwrap()
        .with_timezone(&New_York)
        .date_naive();
    for n in 0..15 {
        let day = date + chrono::Duration::days(n);
        if let Some((open, _)) = calendar::session(day)? {
            let candidate = if identity["session"] == "extended" {
                New_York
                    .from_local_datetime(&day.and_hms_opt(4, 0, 0).unwrap())
                    .single()
                    .unwrap()
                    .timestamp()
            } else if identity["session"] == "overnight" {
                New_York
                    .from_local_datetime(
                        &(day - chrono::Duration::days(1))
                            .and_hms_opt(20, 0, 0)
                            .unwrap(),
                    )
                    .single()
                    .unwrap()
                    .timestamp()
            } else {
                open
            };
            if candidate >= after {
                if let Some(period) = bounds(identity, candidate)? {
                    return Ok(Some(period));
                }
            }
        }
    }
    Ok(None)
}
