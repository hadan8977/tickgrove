//! Versioned XNYS schedule from exchange_calendars 4.11.2, 1990–2035.
//! Future unscheduled closures require updates; an explicit file can extend/replace it.
//! Unsupported years are rejected instead of assigning fabricated close times.
use chrono::{Datelike, NaiveDate, TimeZone, Weekday};
use chrono_tz::America::New_York;
pub fn session(date: NaiveDate) -> anyhow::Result<Option<(i64, i64)>> {
    {
        static CONFIG: std::sync::OnceLock<Result<serde_json::Value, String>> =
            std::sync::OnceLock::new();
        let config = CONFIG
            .get_or_init(|| {
                let text = match std::env::var("TRADING_CALENDAR_FILE") {
                    Ok(path) => std::fs::read_to_string(path).map_err(|e| e.to_string())?,
                    Err(_) => include_str!("../../data/xnys-calendar.json").to_string(),
                };
                serde_json::from_str(&text).map_err(|e| e.to_string())
            })
            .as_ref()
            .map_err(|e| anyhow::anyhow!("Calendar configuration: {e}"))?;
        if let Some(value) = config["sessions"].get(date.to_string()) {
            if value.is_null() {
                return Ok(None);
            }
            let open = chrono::DateTime::parse_from_rfc3339(
                value["open"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Calendar open required"))?,
            )?;
            let close = chrono::DateTime::parse_from_rfc3339(
                value["close"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Calendar close required"))?,
            )?;
            anyhow::ensure!(
                close > open && open.with_timezone(&New_York).date_naive() == date,
                "Invalid calendar extension session"
            );
            return Ok(Some((open.timestamp(), close.timestamp())));
        }
    }

    let (holidays, early): (&[&str], &[&str]) = match date.year() {
        2025 => (
            &[
                "01-01", "01-09", "01-20", "02-17", "04-18", "05-26", "06-19", "07-04", "09-01",
                "11-27", "12-25",
            ],
            &["07-03", "11-28", "12-24"],
        ),
        2026 => (
            &[
                "01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26",
                "12-25",
            ],
            &["11-27", "12-24"],
        ),
        2027 => (
            &[
                "01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25",
                "12-24",
            ],
            &["11-26"],
        ),
        2028 => (
            &[
                "01-17", "02-21", "04-14", "05-29", "06-19", "07-04", "09-04", "11-23", "12-25",
            ],
            &["07-03", "11-24"],
        ),
        _ => anyhow::bail!(
            "NYSE calendar is certified for 2025–2028 only; provide a calendar extension for this historical year"
        ),
    };
    let key = date.format("%m-%d").to_string();
    if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) || holidays.contains(&key.as_str()) {
        return Ok(None);
    }
    let open = New_York
        .from_local_datetime(&date.and_hms_opt(9, 30, 0).unwrap())
        .single()
        .ok_or_else(|| anyhow::anyhow!("Ambiguous session open"))?
        .timestamp();
    let close = New_York
        .from_local_datetime(
            &date
                .and_hms_opt(
                    if early.contains(&key.as_str()) {
                        13
                    } else {
                        16
                    },
                    0,
                    0,
                )
                .unwrap(),
        )
        .single()
        .ok_or_else(|| anyhow::anyhow!("Ambiguous session close"))?
        .timestamp();
    Ok(Some((open, close)))
}
pub fn bar_close(time: i64, step: i64) -> anyhow::Result<i64> {
    let date = chrono::DateTime::from_timestamp(time, 0)
        .ok_or_else(|| anyhow::anyhow!("Invalid session timestamp"))?
        .with_timezone(&New_York)
        .date_naive();
    let (_, close) = session(date)?
        .ok_or_else(|| anyhow::anyhow!("Provider bar appears on closed NYSE regular session"))?;
    Ok(if step >= 86400 {
        close
    } else {
        (time + step).min(close)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dst_early_close_and_holidays() {
        let a = session(NaiveDate::from_ymd_opt(2026, 3, 6).unwrap())
            .unwrap()
            .unwrap();
        let b = session(NaiveDate::from_ymd_opt(2026, 3, 9).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(a.0.rem_euclid(86400), 14 * 3600 + 30 * 60);
        assert_eq!(b.0.rem_euclid(86400), 13 * 3600 + 30 * 60);
        let early = session(NaiveDate::from_ymd_opt(2026, 11, 27).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(early.1 - early.0, 12600);
        assert!(
            session(NaiveDate::from_ymd_opt(2026, 11, 26).unwrap())
                .unwrap()
                .is_none()
        );
    }
}
