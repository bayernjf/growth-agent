-- 001_growth_tasks.sql (sqlite dialect)
-- growth-agent orchestrator core schema: GrowthTask state-machine rows and the
-- api_calls cost ledger (design §3.1 fields, §3.2 states, §11.1 cost table).
-- Application-generated ids; timestamps are ISO-8601 text; JSON stored as TEXT.

CREATE TABLE IF NOT EXISTS growth_tasks (
  id TEXT PRIMARY KEY,                       -- gt_*
  site_id TEXT NOT NULL,                     -- target site config id
  task_type TEXT NOT NULL,                   -- write|fix|monitor
  signal_id TEXT,                            -- growth-os signal (evidence source)
  zeus_decision_id TEXT,                     -- zeus DecisionRecord.id
  loom_content_id TEXT,                      -- loom final_id
  pr_ref TEXT,                               -- JSON {platform, repo, number, url, branch}
  status TEXT NOT NULL,                      -- see GROWTH_TASK_TRANSITIONS
  qa_result TEXT,                            -- JSON {intent, dedupe, value, scores[]}
  verify_result TEXT,                        -- JSON {impressionsDelta, clicksDelta, positionDelta}
  qa_revision_count INTEGER NOT NULL DEFAULT 0,  -- one-shot qa_revision rework guard (§3.2)
  cost_micros_total INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,      -- gt:<id>
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_growth_tasks_status ON growth_tasks(status);
CREATE INDEX IF NOT EXISTS idx_growth_tasks_zeus ON growth_tasks(zeus_decision_id);

CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                    -- gsc|serp:<vendor>|llm
  method TEXT NOT NULL DEFAULT '',            -- HTTP method of the call
  endpoint TEXT NOT NULL,                     -- concrete interface name
  task_id TEXT,                              -- nullable: monitor-style calls attach no task
  units INTEGER NOT NULL DEFAULT 0,           -- rows returned / tokens / request count
  cost_micros INTEGER NOT NULL DEFAULT 0,     -- estimated cost in micro units
  http_status INTEGER,                        -- response status when known
  cached INTEGER NOT NULL DEFAULT 0,         -- 0|1: served from cache
  created_at TEXT NOT NULL,                   -- ISO time of the call (§11.1 "at")
  FOREIGN KEY (task_id) REFERENCES growth_tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_api_calls_task ON api_calls(task_id);
CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at);
