CREATE TABLE pine_libraries(reference TEXT PRIMARY KEY,publisher TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,source TEXT NOT NULL,hash TEXT NOT NULL,license TEXT,source_url TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE strategy_versions ADD COLUMN library_lock TEXT;
