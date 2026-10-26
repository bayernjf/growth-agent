-- 006_github_ledger_repeatable.sql (sqlite dialect)
-- Migration 004 created a standalone unique index uq_github_delivery_action
-- on (pr_number, action). A PR can receive many `synchronize` events (each
-- human edit push after the bot opens the PR; PRD §8.1 indicator 3 counts
-- their median), so the composite unique is removed. Dedup is by delivery
-- id (primary key), which now carries the push head SHA for repeatable
-- audit actions. No table rebuild is needed: the index was created with
-- CREATE UNIQUE INDEX rather than an inline table constraint.

DROP INDEX IF EXISTS uq_github_delivery_action;
CREATE INDEX IF NOT EXISTS idx_github_delivery_pr ON github_webhook_deliveries(pr_number);
