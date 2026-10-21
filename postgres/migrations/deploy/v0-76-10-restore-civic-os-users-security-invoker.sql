-- Deploy civic_os:v0-76-10-restore-civic-os-users-security-invoker to pg
-- requires: v0-76-9-restore-view-security-invoker
--
-- Restore security_invoker on public.civic_os_users.
--
-- v0-55-2 and v0-65-0 both set security_invoker = true on this view. v0-65-2 then ran
-- CREATE OR REPLACE VIEW (to add first_name/last_name), which resets view options, so the view has
-- run with its superuser owner's rights ever since. Same regression class as
-- v0-76-9-restore-view-security-invoker (notification_preferences).
--
-- The view already masks private columns per caller with CASE expressions, so the leak is not
-- exploitable today, but that makes it one edit away from one: the view should rely on RLS of the
-- base tables (metadata.civic_os_users, metadata.civic_os_users_private) as designed, with the CASE
-- masking as defense in depth, not as the only barrier.
--
-- Verified on a fully deployed database: output of SELECT * FROM public.civic_os_users is identical
-- before and after for web_anon, the user themself, another user, an editor and an admin.

BEGIN;

ALTER VIEW public.civic_os_users SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';

COMMIT;
