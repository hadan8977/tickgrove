-- MAX source/receipt timestamps must not scan every retained trade/bar for status polling.
CREATE INDEX market_quote_event_time ON market_events(subscription_id,event_time) WHERE type='quote';
CREATE INDEX market_quote_received_at ON market_events(subscription_id,received_at) WHERE type='quote';
