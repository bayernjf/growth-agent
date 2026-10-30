-- 008_webhook_nonces.sql (postgres dialect)
-- Table set must stay identical to db/migrations/sqlite/008_webhook_nonces.sql.

CREATE TABLE IF NOT EXISTS zeus_webhook_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zeus_nonces_seen_at ON zeus_webhook_nonces(seen_at);
