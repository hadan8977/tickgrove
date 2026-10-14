ALTER TABLE local_orders ADD COLUMN feed TEXT NOT NULL DEFAULT 'public-websocket';
ALTER TABLE local_fills ADD COLUMN feed TEXT NOT NULL DEFAULT 'public-websocket';
UPDATE local_orders SET feed='iex' WHERE provider='alpaca';
UPDATE local_fills SET feed='iex' WHERE provider='alpaca';
