ALTER TABLE market_subscriptions ADD COLUMN feed TEXT NOT NULL DEFAULT 'public-websocket';
UPDATE market_subscriptions SET feed=COALESCE(json_extract(identity,'$.feed'),feed);
DROP INDEX market_active_subscription;
CREATE UNIQUE INDEX market_active_subscription ON market_subscriptions(provider,symbol,timeframe,feed) WHERE desired=1;
