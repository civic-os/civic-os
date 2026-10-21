-- Revert civic_os:v0-76-9-restore-view-security-invoker from pg
--
-- WARNING: restores the insecure state in which both views run with their owner's rights and
-- bypass RLS on the base tables. Intended only for round-trip migration testing.

BEGIN;

ALTER VIEW public.entity_notes RESET (security_invoker);
ALTER VIEW public.notification_preferences RESET (security_invoker);

NOTIFY pgrst, 'reload schema';

COMMIT;
