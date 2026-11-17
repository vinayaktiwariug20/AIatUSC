-- Staff-posted status of a parking structure: closed to daily (Text2Park) parkers
-- on a weekly schedule, or live Open / Filling / Full on game days. Kept apart
-- from mobility_rules, whose kind CHECK allows only gate and road.
CREATE TABLE IF NOT EXISTS parking_status (
  id TEXT PRIMARY KEY,
  parking TEXT NOT NULL,
  starts_ms INTEGER NOT NULL,
  ends_ms INTEGER NOT NULL CHECK (ends_ms > starts_ms),
  created_ms INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS parking_status_time ON parking_status(ends_ms, starts_ms);
