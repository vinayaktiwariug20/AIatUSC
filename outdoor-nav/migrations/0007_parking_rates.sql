-- Staff-posted parking prices for a structure: hourly (optional daily max), all day,
-- a flat event rate (replaces the others while it applies) or free. Rows have a date
-- range and may repeat on days of the week. Kept apart from parking_status.
CREATE TABLE IF NOT EXISTS parking_rates (
  id TEXT PRIMARY KEY,
  parking TEXT NOT NULL,
  starts_ms INTEGER NOT NULL,
  ends_ms INTEGER NOT NULL CHECK (ends_ms > starts_ms),
  created_ms INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS parking_rates_time ON parking_rates(ends_ms, starts_ms);
