-- 002_zeus_webhook.sql (postgres dialect)
-- Inbound zeus decision-event webhook persistence (design §2.2 event flow,
-- §6.1 dual-track writeback, §9 channel failure visibility).
-- Table set must stay identical to db/migrations/sqlite/002_zeus_webhook.sql.

CREATE TABLE IF NOT EXISTS zeus_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_id TEXT,
  signature_valid BOOLEAN NOT NULL DEFAULT true,
  processing_result TEXT NOT NULL,
  error_code TEXT,
  event_payload JSONB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zeus_deliveries_decision ON zeus_webhook_deliveries(decision_id);
CREATE INDEX IF NOT EXISTS idx_zeus_deliveries_result ON zeus_webhook_deliveries(processing_result);

CREATE TABLE IF NOT EXISTS channel_failures (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  reason TEXT NOT NULL,
  external_ref TEXT,
  retryable BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_failures_channel ON channel_failures(channel);
