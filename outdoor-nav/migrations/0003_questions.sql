-- Questions people ask Doorstep that the assistant could not answer from
-- verified facts, and organizer answers (which then become facts for everyone).
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'dismissed')),
  created_ms INTEGER NOT NULL,
  answered_ms INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS questions_status ON questions(status, created_ms);
CREATE INDEX IF NOT EXISTS questions_answered ON questions(answered_ms);
