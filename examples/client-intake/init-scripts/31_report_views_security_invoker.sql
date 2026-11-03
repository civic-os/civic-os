-- 31_report_views_security_invoker.sql
-- Client Intake example: the six report views (scripts 04 and 12) were plain views over RLS-protected
-- tables (clients, referrals, follow_up_surveys, client_service_needs, referral_service_categories).
-- Views run with their owner's rights (a superuser), so they ignored those policies and returned
-- aggregates over every row to any role holding SELECT on the view (all of `authenticated`; for
-- referrals_per_week also `web_anon`). Script 23 documented them as "definer VIEWs", which is the
-- opposite of the rule in CLAUDE.md (View Security).
--
-- They are now security_invoker, so the caller's RLS on the base tables applies:
--   - staff and admin hold read on clients, referrals and follow_up_surveys (script 02), so the
--     clients_select, referrals_select, surveys_select, csn_select and rsc_select policies pass for
--     them and the reports return the same rows as before.
--   - other signed-in users now see aggregates over only their own client, referral and survey rows
--     (their view of the base tables) instead of the whole population.
--   - partners, service_categories and metadata.statuses / metadata.categories have no restrictive
--     SELECT policy (statuses and categories: "everyone reads"), and `authenticated` already holds
--     SELECT on all of them, so no base-table grant is missing.
--
-- referrals_per_week was also granted to web_anon (script 12). web_anon holds no SELECT on referrals
-- and its RLS would deny every row anyway, so the grant would now only produce permission errors for
-- anonymous visitors of the public dashboard; it is revoked. The chart widget is unaffected for
-- signed-in staff.
--
-- Supersedes the definitions in 04_client_intake_reports.sql and 12_icgf_referrals_chart_widget.sql
-- (migration-first: those scripts are left as shipped). Columns and the authenticated grants are
-- unchanged. Safe to re-run.

BEGIN;

ALTER VIEW public.monthly_referral_summary   SET (security_invoker = true);
ALTER VIEW public.client_contact_summary     SET (security_invoker = true);
ALTER VIEW public.top_needs_report           SET (security_invoker = true);
ALTER VIEW public.partner_utilization_report SET (security_invoker = true);
ALTER VIEW public.time_lag_report            SET (security_invoker = true);
ALTER VIEW public.referrals_per_week         SET (security_invoker = true);

REVOKE SELECT ON public.referrals_per_week FROM web_anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
