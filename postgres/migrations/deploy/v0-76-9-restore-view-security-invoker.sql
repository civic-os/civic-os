-- Deploy civic_os:v0-76-9-restore-view-security-invoker to pg
-- requires: v0-76-8-payment-checkout-translations
--
-- Security fix: restore security_invoker on public.notification_preferences and
-- public.entity_notes so row-level security on their base tables applies again.
--
-- notification_preferences: v0-50-2 set security_invoker = true, then v0-70-0 ran
--   CREATE OR REPLACE VIEW, which resets view options, silently undoing the fix.
-- entity_notes: v0-16-0 documented "RLS on underlying table handles permissions" but never
--   set security_invoker, so the view has always run with its superuser owner's rights.
--
-- Both views run as a superuser (BYPASSRLS) without security_invoker, so any authenticated
-- user could read other users' notification preferences and every entity's notes regardless of
-- the {entity}:notes:read permission, and write through the views without the RLS WITH CHECK.
--
-- With security_invoker the calling role's own table privileges and RLS apply. `authenticated`
-- already holds the base-table grants (verified: SELECT on both; INSERT/UPDATE/DELETE on notes),
-- so permitted access is unchanged; only access RLS was meant to deny is now denied.
--
-- ALTER VIEW ... SET is used instead of re-creating the views, so definitions, grants and
-- dependent objects are untouched. Future CREATE OR REPLACE VIEW statements for these views
-- must carry WITH (security_invoker = true) or re-issue this ALTER.

BEGIN;

ALTER VIEW public.notification_preferences SET (security_invoker = true);
ALTER VIEW public.entity_notes SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';

COMMIT;
