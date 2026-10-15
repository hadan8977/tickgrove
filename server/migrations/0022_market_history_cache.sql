-- Rebuildable cache, separate from immutable strategy snapshots and journals.
CREATE TABLE market_history_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    symbol TEXT NOT NULL,
    payload TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX market_history_cache_expiry ON market_history_cache(expires_at);
CREATE INDEX market_history_cache_lru ON market_history_cache(last_accessed);
