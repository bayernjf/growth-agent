-- 002_zeus_webhook.sql (sqlite dialect)
-- Inbound zeus decision-event webhook persistence (design §2.2 event flow,
-- §6.1 dual-track writeback, §9 channel failure visibility).
--
-- zeus pushes approved/rejected/timed-out (plus created/late for audit) with
-- HMAC over the exact JSON body; this migration holds the two ledger tables:
--   zeus_webhook_deliveries: one row per x-zeus-delivery-id ever seen. Serves
--     at-least-once dedupe AND the audit trail; processing_result records
--     whether the event was applied or durably rejected (drift / unknown task).
--   channel_failures: per (channel, reason) aggregate so the weekly report can
--     show "which channel failed N times" (§9); attempts is incremented by
--     upsert, last_error is sanitized (never the secret).

CREATE TABLE IF NOT EXISTS zeus_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,              -- <decisionId>:<type>:<at> (x-zeus-delivery-id)
  decision_id TEXT NOT NULL,                 -- zeus DecisionRecord.id
  event_type TEXT NOT NULL,                 -- created|late|approved|rejected|timed-out
  task_id TEXT,                             -- local growth_tasks.id; NULL when unresolved
  signature_valid INTEGER NOT NULL DEFAULT 1,
  processing_result TEXT NOT NULL,           -- accepted|rejected
  error_code TEXT,                           -- UNKNOWN_TASK|INVALID_TRANSITION; NULL on accepted
  event_payload TEXT,                        -- JSON: zeus DecisionEvent (audit; holds approver/outcome)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zeus_deliveries_decision ON zeus_webhook_deliveries(decision_id);
CREATE INDEX IF NOT EXISTS idx_zeus_deliveries_result ON zeus_webhook_deliveries(processing_result);

CREATE TABLE IF NOT EXISTS channel_failures (
  id TEXT PRIMARY KEY,                       -- cf:<channel>:<reason>
  channel TEXT NOT NULL,                     -- zeus_webhook
  reason TEXT NOT NULL,                     -- INVALID_SIGNATURE|UNKNOWN_TASK|INVALID_TRANSITION
  external_ref TEXT,                        -- latest delivery_id / decision_id of an occurrence
  retryable INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,                           -- sanitized message; never contains the HMAC secret
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_failures_channel ON channel_failures(channel);
