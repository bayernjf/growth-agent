-- 007_task_context.sql (postgres dialect)
-- The morning batch scores candidates that carry a query (write) or a page URL
-- (fix) and sends both to zeus, but growth_tasks only stored id / site_id /
-- task_type / signal_id. Nothing downstream could therefore recover what a
-- task was about: the production batch has no query to draft against, and the
-- verification batch has no page URL to recheck. Both stages took those values
-- as injected arguments, which only the offline smoke script ever supplied.
--
-- Persist the candidate context as JSON so the daily, production and
-- verification batches are independently runnable against the stored task.
-- Shape: {"query": string, "targetUrl"?: string, "angle": string}.

ALTER TABLE growth_tasks ADD COLUMN context JSONB;
