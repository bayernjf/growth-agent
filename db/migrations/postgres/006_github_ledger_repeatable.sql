-- 006_github_ledger_repeatable.sql (postgres dialect)
-- A PR can receive many `synchronize` events (human edit pushes after the
-- bot opens the PR; PRD §8.1 indicator 3). Dedup is by delivery id (primary
-- key, now keyed by push head SHA for audit actions), so the composite
-- unique from migration 004 must go.

DROP INDEX IF EXISTS uq_github_delivery_action;
CREATE INDEX IF NOT EXISTS idx_github_delivery_pr ON github_webhook_deliveries(pr_number);
