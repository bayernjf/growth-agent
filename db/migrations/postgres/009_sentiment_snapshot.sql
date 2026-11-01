-- 009_sentiment_snapshot.sql (postgres dialect)
-- Daily sentiment snapshot (W6 / OP-40).
-- Table set must stay identical to db/migrations/sqlite/009_sentiment_snapshot.sql.
-- Idempotency: same-day rerun overwrites via ON CONFLICT on the unique key.

CREATE TABLE IF NOT EXISTS sentiment_daily_snapshot (
  keyword TEXT NOT NULL,
  source TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  metric_value INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sentiment_snapshot
  ON sentiment_daily_snapshot(keyword, source, snapshot_date, url);
CREATE INDEX IF NOT EXISTS idx_sentiment_snapshot_kw
  ON sentiment_daily_snapshot(keyword, snapshot_date);
