CREATE TABLE pine_alert_history(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,job_id TEXT NOT NULL,event_time INTEGER NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,UNIQUE(session_id,event_time,id));
CREATE INDEX pine_alert_history_time ON pine_alert_history(received_at);
