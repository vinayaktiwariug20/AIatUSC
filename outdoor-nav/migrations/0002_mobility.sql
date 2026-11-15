CREATE TABLE IF NOT EXISTS mobility_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('gate','road')),
  starts_ms INTEGER NOT NULL,
  ends_ms INTEGER NOT NULL CHECK (ends_ms > starts_ms),
  created_ms INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS mobility_rules_time ON mobility_rules(ends_ms, starts_ms);
CREATE TABLE IF NOT EXISTS routing_usage (
  slot TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
