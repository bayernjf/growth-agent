-- 005_verify_checks.sql (postgres dialect)
-- Next-day verification history (design §5.D): a merged task is rechecked at
-- the 06:00 batch once it is 24h past merge; two consecutive checks with no
-- improvement end the task as verified_no_gain. The per-check history needs
-- to survive restarts, so it is a JSON column on growth_tasks rather than an
-- in-memory counter. The final summary deltas still land in verify_result.

ALTER TABLE growth_tasks ADD COLUMN verify_checks JSONB;
