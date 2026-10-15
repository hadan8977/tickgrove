-- A complete desired order set belongs to one committed computation event.
CREATE TABLE pine_host_dispatch (
  session_id TEXT NOT NULL REFERENCES pine_host_sessions(id),
  market_cursor INTEGER NOT NULL,
  response TEXT NOT NULL,
  decision_time INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','canceled')),
  PRIMARY KEY(session_id,market_cursor)
);
CREATE INDEX pine_host_dispatch_pending ON pine_host_dispatch(session_id,status,market_cursor);
