-- 16_summary_view_security_invoker.sql
-- Pothole example: public.issue_status_summary (script 11) was a plain view over "Issue" and
-- statuses. Views run with their owner's rights (a superuser), so it ignored the "Issue" read
-- policy (has_permission('Issue', 'read')) and counted every issue for every caller.
--
-- It is now security_invoker, so the caller's RLS on "Issue" applies to the counts. Callers
-- already hold SELECT on "Issue" (01_pot_hole_schema.sql) and on the statuses bridge view.
--
-- Supersedes the definition in 11_summary_view.sql (migration-first: that script is left as
-- shipped). Columns and grants are unchanged. Safe to re-run.

BEGIN;

ALTER VIEW public.issue_status_summary SET (security_invoker = true);

COMMIT;
