-- The newest bulletins, keyed by the date printed on them.
CREATE TABLE IF NOT EXISTS bulletins (
  bulletin_date TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  weekday       TEXT,
  day_color     TEXT,
  date_text     TEXT NOT NULL,
  blocks_json   TEXT NOT NULL,
  source        TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

-- One row, so the Worker can tell a burst of opens apart from a real retry.
CREATE TABLE IF NOT EXISTS fetch_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error      TEXT
);

INSERT OR IGNORE INTO fetch_state (id) VALUES (1);
