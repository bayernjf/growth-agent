-- 001_smoke.sql (postgres fixture; migration runner tests only)
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS smoke_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
