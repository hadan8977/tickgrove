ALTER TABLE alerts ADD COLUMN last_event_time INTEGER;
ALTER TABLE local_positions ADD COLUMN last_event_time INTEGER NOT NULL DEFAULT 0;
