-- 008_webhook_nonces.sql (sqlite dialect)
-- v2 decision-webhook replay defense: one row per x-zeus-webhook-nonce
-- accepted inside the freshness window. Rows are pruned on insert; the
-- deterministic x-zeus-delivery-id ledger (migration 002) still owns
-- at-least-once business idempotency, this table only rejects replays.

CREATE TABLE IF NOT EXISTS zeus_webhook_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zeus_nonces_seen_at ON zeus_webhook_nonces(seen_at);
