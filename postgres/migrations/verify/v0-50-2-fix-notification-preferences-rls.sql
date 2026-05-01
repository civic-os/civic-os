-- Verify civic_os:v0-50-2-fix-notification-preferences-rls on pg

BEGIN;

-- Verify security_invoker is set on the VIEW
SELECT 1/COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'notification_preferences'
  AND c.reloptions @> ARRAY['security_invoker=true'];

ROLLBACK;
