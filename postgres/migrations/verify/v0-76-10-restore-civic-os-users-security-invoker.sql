-- Verify civic_os:v0-76-10-restore-civic-os-users-security-invoker

BEGIN;

SELECT 1/COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'civic_os_users'
  AND c.reloptions @> ARRAY['security_invoker=true'];

ROLLBACK;
