-- Feedback from people using Doorstep: "Was this route right? No" on a route card,
-- and "Send feedback" in the footer. No name or contact details are stored.
-- A done item is deleted 90 days after it was marked done.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  created_ms INTEGER NOT NULL,
  done_ms INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, created_ms);
