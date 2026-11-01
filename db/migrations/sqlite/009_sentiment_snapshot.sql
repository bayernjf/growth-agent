-- 009_sentiment_snapshot.sql (sqlite dialect)
-- Daily sentiment snapshot (W6 / OP-40): pulled once a day from public
-- sources (GitHub stars/releases, HN, Reddit, brand mentions) and stored so
-- negative mentions can trigger a weekly-report alert and feed daily
-- candidates, offline and reusable.
--
-- Idempotency (same as gsc_daily_snapshot): same-day rerun OVERWRITES via the
-- UNIQUE index on (keyword, source, snapshot_date, url).

CREATE TABLE IF NOT EXISTS sentiment_daily_snapshot (
  keyword TEXT NOT NULL,            -- tracked brand keyword (e.g. bayjf)
  source TEXT NOT NULL,             -- github / hn / reddit / brand
  snapshot_date TEXT NOT NULL,      -- YYYY-MM-DD
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  sentiment TEXT NOT NULL,          -- positive / neutral / negative
  metric_value INTEGER NOT NULL DEFAULT 0,  -- stars / upvotes / mention count
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sentiment_snapshot
  ON sentiment_daily_snapshot(keyword, source, snapshot_date, url);
CREATE INDEX IF NOT EXISTS idx_sentiment_snapshot_kw
  ON sentiment_daily_snapshot(keyword, snapshot_date);
