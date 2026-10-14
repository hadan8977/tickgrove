ALTER TABLE paper_sessions ADD COLUMN subscription_id TEXT REFERENCES market_subscriptions(id);
ALTER TABLE paper_sessions ADD COLUMN stream_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_sessions ADD COLUMN error TEXT;
ALTER TABLE paper_sessions ADD COLUMN name TEXT;
CREATE TABLE paper_bindings(session_id TEXT NOT NULL REFERENCES paper_sessions(id),subscription_id TEXT NOT NULL REFERENCES market_subscriptions(id),symbol TEXT NOT NULL,PRIMARY KEY(session_id,subscription_id),UNIQUE(session_id,symbol));
CREATE TABLE paper_market_pending(session_id TEXT NOT NULL REFERENCES paper_sessions(id),symbol TEXT NOT NULL,time INTEGER NOT NULL,payload TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(session_id,symbol,time));
