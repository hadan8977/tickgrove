CREATE TABLE market_subscriptions(id TEXT PRIMARY KEY, provider TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL, desired INTEGER NOT NULL DEFAULT 1, last_event_at INTEGER, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX market_active_subscription ON market_subscriptions(provider,symbol,timeframe) WHERE desired=1;
CREATE TABLE market_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT NOT NULL REFERENCES market_subscriptions(id), type TEXT NOT NULL, event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, payload TEXT NOT NULL, quality TEXT NOT NULL);
CREATE INDEX market_events_subscription ON market_events(subscription_id,cursor);
CREATE TABLE market_bars(subscription_id TEXT NOT NULL REFERENCES market_subscriptions(id), time INTEGER NOT NULL, payload TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL, PRIMARY KEY(subscription_id,time));
CREATE TABLE market_trade_ids(subscription_id TEXT NOT NULL REFERENCES market_subscriptions(id), trade_id INTEGER NOT NULL, PRIMARY KEY(subscription_id,trade_id));
