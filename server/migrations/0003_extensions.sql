CREATE TABLE plugin_state(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, manifest TEXT NOT NULL);
CREATE TABLE broker_orders(client_order_id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL, remote_order TEXT, error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
