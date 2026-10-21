-- Revert civic_os:v0-76-10-restore-civic-os-users-security-invoker from pg
--
-- WARNING: restores the state in which the view runs with its owner's rights and bypasses RLS on
-- its base tables. Intended only for round-trip migration testing.

BEGIN;

ALTER VIEW public.civic_os_users RESET (security_invoker);

NOTIFY pgrst, 'reload schema';

COMMIT;
