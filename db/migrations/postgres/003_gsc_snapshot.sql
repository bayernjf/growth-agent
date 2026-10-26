-- 003_gsc_snapshot.sql (postgres dialect)
-- Daily GSC searchanalytics snapshot (design §4.1).
-- Table set must stay identical to db/migrations/sqlite/003_gsc_snapshot.sql.
-- Idempotency: same-day rerun overwrites via ON CONFLICT on the unique key.

CREATE TABLE IF NOT EXISTS gsc_daily_snapshot (
  site_url TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gsc_snapshot_day
  ON gsc_daily_snapshot(site_url, snapshot_date, dimension_key);
CREATE INDEX IF NOT EXISTS idx_gsc_snapshot_site ON gsc_daily_snapshot(site_url, snapshot_date);
