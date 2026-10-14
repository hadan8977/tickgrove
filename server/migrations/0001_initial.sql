CREATE TABLE strategy_versions(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER immutable_strategy_update BEFORE UPDATE ON strategy_versions BEGIN SELECT RAISE(ABORT, 'strategy versions are immutable'); END;
CREATE TABLE snapshots(id TEXT PRIMARY KEY, payload TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER immutable_snapshot_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'data snapshots are immutable'); END;
CREATE TABLE jobs(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES strategy_versions(id), snapshot_id TEXT NOT NULL REFERENCES snapshots(id), manifest TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE commands(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
