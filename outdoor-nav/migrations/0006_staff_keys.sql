-- Named keys for staff (e.g. "Transportation dispatch"): they can post and lift
-- closures and parking statuses, and review reports, but not read usage stats,
-- answer organizer questions or manage keys. Only a hash of each key is stored.
CREATE TABLE IF NOT EXISTS staff_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL,
  last_used_ms INTEGER,
  revoked_ms INTEGER
);
