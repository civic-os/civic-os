-- Revert civic_os:v0-50-2-fix-notification-preferences-rls from pg

BEGIN;

-- Remove security_invoker (restore definer-rights behavior)
ALTER VIEW public.notification_preferences RESET (security_invoker);

NOTIFY pgrst, 'reload schema';

COMMIT;
