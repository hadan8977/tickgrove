ALTER TABLE paper_sessions ADD COLUMN pending_job_id TEXT REFERENCES jobs(id);
