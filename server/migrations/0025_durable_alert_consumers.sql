-- Cursor/state/history are committed together. Existing alerts begin at this
-- upgrade boundary; previously missed events cannot be asserted retroactively.
ALTER TABLE alerts ADD COLUMN subscription_id TEXT REFERENCES market_subscriptions(id);
ALTER TABLE alerts ADD COLUMN source_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN error TEXT;
UPDATE alerts SET source_cursor=(SELECT COALESCE(MAX(cursor),0) FROM market_events),previous_price=NULL;
CREATE INDEX alerts_active_consumer ON alerts(status,subscription_id);
