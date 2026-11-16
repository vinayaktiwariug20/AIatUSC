-- Anonymous usage counts per event link: just date + link key + kind + count.
-- No IP, no device or user id, no location, no cookies.
CREATE TABLE IF NOT EXISTS usage_counts (
  day TEXT NOT NULL,          -- YYYY-MM-DD, Los Angeles
  link TEXT NOT NULL,         -- short hash of (building, room, event name)
  kind TEXT NOT NULL,         -- open | route | arrive | inside | ask
  count INTEGER NOT NULL,
  PRIMARY KEY (day, link, kind)
);
