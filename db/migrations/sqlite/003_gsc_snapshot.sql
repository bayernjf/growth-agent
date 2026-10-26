-- 003_gsc_snapshot.sql (sqlite dialect)
-- Daily GSC searchanalytics snapshot (design §4.1): pulled every 06:00 and
-- stored locally so ranking movement (today position - yesterday position)
-- can be computed offline and reused by the weekly report / fix candidates.
--
-- dimension_key is the dimension VALUE aligned with queryAnalytics dimensions:
--   dimension 'query' -> the query string; 'page' -> the page path; 'date' ->
--   the ISO date itself. (dimension type is the caller's contract, not a column
--  — the §4.1 shape is exactly site_url/snapshot_date/dimension_key/...).
--
-- Idempotency (fixed choice: same-day rerun OVERWRITES): the UNIQUE index on
-- (site_url, snapshot_date, dimension_key) lets the repository upsert; a
-- re-run of the 06:00 job refreshes corrected numbers instead of failing.

CREATE TABLE IF NOT EXISTS gsc_daily_snapshot (
  site_url TEXT NOT NULL,                   -- e.g. https://bayjf.com/
  snapshot_date TEXT NOT NULL,              -- YYYY-MM-DD (GSC requestDate)
  dimension_key TEXT NOT NULL,              -- query / page / date value
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,         -- average position this day
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gsc_snapshot_day
  ON gsc_daily_snapshot(site_url, snapshot_date, dimension_key);
CREATE INDEX IF NOT EXISTS idx_gsc_snapshot_site ON gsc_daily_snapshot(site_url, snapshot_date);
