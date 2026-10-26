-- 004_github_webhook.sql (postgres dialect)
-- Inbound GitHub pull_request webhook persistence (design §4.3, §6.1).
--
-- GitHub signs events with X-Hub-Signature-256 (HMAC-SHA256 over the exact
-- body). This migration holds the PR-event delivery ledger: one row per
-- (PR number, action), serving at-least-once idempotency (§9: GitHub events
-- are deduped by PR number) plus the audit trail. GitHub channel failures
-- reuse the channel_failures table from migration 002 with
-- channel='github_webhook'.

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  id TEXT PRIMARY KEY,                       -- gh:<pr_number>:<action>
  pr_number INTEGER NOT NULL,                -- pull_request.number (§9 dedupe key)
  event_type TEXT NOT NULL,                  -- pull_request
  action TEXT NOT NULL,                      -- opened|reopened|closed|merged ...
  task_id TEXT,                              -- local growth_tasks.id; NULL when unresolved
  signature_valid BOOLEAN NOT NULL DEFAULT true,
  processing_result TEXT NOT NULL,           -- accepted|rejected|ignored
  error_code TEXT,                           -- UNKNOWN_TASK|INVALID_TRANSITION; NULL on accepted
  event_payload JSONB,                       -- GitHub pull_request event (audit)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_github_delivery_action
  ON github_webhook_deliveries(pr_number, action);
CREATE INDEX IF NOT EXISTS idx_github_delivery_task ON github_webhook_deliveries(task_id);
