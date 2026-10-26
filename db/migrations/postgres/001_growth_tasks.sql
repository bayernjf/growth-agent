-- 001_growth_tasks.sql (postgres dialect)
-- growth-agent orchestrator core schema: GrowthTask state-machine rows and the
-- api_calls cost ledger (design §3.1 fields, §3.2 states, §11.1 cost table).
-- Application-generated ids; timestamps are ISO-8601 text; JSON stored as JSONB.

CREATE TABLE IF NOT EXISTS growth_tasks (
  id TEXT PRIMARY KEY,                       -- gt_*
  site_id TEXT NOT NULL,
  task_type TEXT NOT NULL,                   -- write|fix|monitor
  signal_id TEXT,
  zeus_decision_id TEXT,
  loom_content_id TEXT,
  pr_ref JSONB,
  status TEXT NOT NULL,
  qa_result JSONB,
  verify_result JSONB,
  qa_revision_count INTEGER NOT NULL DEFAULT 0,
  cost_micros_total INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_growth_tasks_status ON growth_tasks(status);
CREATE INDEX IF NOT EXISTS idx_growth_tasks_zeus ON growth_tasks(zeus_decision_id);

CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL,
  task_id TEXT REFERENCES growth_tasks(id),
  units INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  cached BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_calls_task ON api_calls(task_id);
CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at);
