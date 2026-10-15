use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Builder {
    pub step: i64,
    pub forming: Option<Bar>,
    pub complete: bool,
    pub last_trade: Option<i64>,
}
#[derive(Debug)]
pub struct Change {
    pub closed: Option<(Bar, bool)>,
    pub forming: Option<Bar>,
    pub gap: Option<String>,
    pub duplicate: bool,
}
impl Builder {
    pub fn new(step: i64) -> Self {
        Self {
            step,
            forming: None,
            complete: false,
            last_trade: None,
        }
    }
    pub fn disconnected(&mut self) {
        self.complete = false;
    }
    pub fn trade(
        &mut self,
        id: i64,
        time_ms: i64,
        price: f64,
        size: f64,
    ) -> anyhow::Result<Change> {
        anyhow::ensure!(
            price.is_finite() && price > 0. && size.is_finite() && size >= 0.,
            "Invalid trade"
        );
        if self.last_trade.is_some_and(|old| id <= old) {
            return Ok(Change {
                closed: None,
                forming: self.forming.clone(),
                gap: None,
                duplicate: true,
            });
        }
        let mut gap = None;
        if self.last_trade.is_some_and(|old| id > old + 1) {
            self.complete = false;
            gap = Some("Missing trade IDs; current candle is incomplete".into());
        }
        self.last_trade = Some(id);
        let offset = if self.step == 604800 { 4 * 86400 } else { 0 };
        let bucket = (time_ms / 1000 - offset).div_euclid(self.step) * self.step + offset;
        let mut closed = None;
        if let Some(bar) = &self.forming {
            if bucket < bar.time {
                self.complete = false;
                return Ok(Change {
                    closed: None,
                    forming: self.forming.clone(),
                    gap: Some("Late trade for past bucket; no silent historical rewrite".into()),
                    duplicate: false,
                });
            }
            if bucket > bar.time {
                closed = Some((bar.clone(), self.complete));
                if bucket > bar.close_time {
                    gap = Some("Missing/no-trade buckets; no synthetic candles".into());
                }
                self.forming = None;
                self.complete = true;
            }
        }
        match &mut self.forming {
            Some(bar) => {
                bar.high = bar.high.max(price);
                bar.low = bar.low.min(price);
                bar.close = price;
                bar.volume += size
            }
            None => {
                self.forming = Some(Bar {
                    time: bucket,
                    close_time: bucket + self.step,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: size,
                })
            }
        }
        Ok(Change {
            closed,
            forming: self.forming.clone(),
            gap,
            duplicate: false,
        })
    }
    pub fn watermark(&mut self, time_ms: i64) -> Option<(Bar, bool)> {
        if self
            .forming
            .as_ref()
            .is_some_and(|b| b.close_time * 1000 <= time_ms)
        {
            let bar = self.forming.take().unwrap();
            let complete = self.complete;
            self.complete = true;
            Some((bar, complete))
        } else {
            None
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trades_form_and_close_real_bars() {
        let mut b = Builder::new(60);
        b.trade(1, 60000, 10., 2.).unwrap();
        b.trade(2, 61000, 12., 3.).unwrap();
        let c = b.trade(3, 120000, 11., 1.).unwrap();
        let (bar, complete) = c.closed.unwrap();
        assert_eq!(
            (bar.open, bar.high, bar.low, bar.close, bar.volume),
            (10., 12., 10., 12., 5.)
        );
        assert!(!complete);
        assert!(b.watermark(180000).unwrap().1);
    }
    #[test]
    fn duplicate_gap_disconnect_and_late_events_are_explicit() {
        let mut b = Builder::new(60);
        b.trade(4, 60000, 10., 1.).unwrap();
        assert!(b.trade(4, 61000, 99., 10.).unwrap().duplicate);
        assert_eq!(b.forming.as_ref().unwrap().volume, 1.);
        assert!(b.trade(6, 62000, 11., 1.).unwrap().gap.is_some());
        b.disconnected();
        assert!(!b.watermark(120000).unwrap().1);
        b.trade(7, 120000, 12., 1.).unwrap();
        assert!(b.trade(8, 60000, 1., 1.).unwrap().gap.is_some());
    }
}
