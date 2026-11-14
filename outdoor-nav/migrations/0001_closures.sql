CREATE TABLE IF NOT EXISTS closures (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('approved', 'unverified', 'rejected')),
  starts_ms INTEGER NOT NULL,
  ends_ms INTEGER NOT NULL CHECK (ends_ms > starts_ms),
  created_ms INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS closures_active ON closures(ends_ms, starts_ms, status);
