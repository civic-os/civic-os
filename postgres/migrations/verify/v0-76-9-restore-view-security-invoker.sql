-- Verify civic_os:v0-76-9-restore-view-security-invoker

BEGIN;

SELECT 1/COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'notification_preferences'
  AND c.reloptions @> ARRAY['security_invoker=true'];

SELECT 1/COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'entity_notes'
  AND c.reloptions @> ARRAY['security_invoker=true'];

ROLLBACK;
