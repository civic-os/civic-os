-- Verify civic_os:v0-47-1-fix-keycloak-update-email on pg

BEGIN;

-- Verify update_user_info function exists and contains 'email' in River job args
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'update_user_info'
  AND pg_get_functiondef(p.oid) LIKE '%''email''%';

-- Verify refresh_current_user includes first_name/last_name
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'refresh_current_user'
  AND pg_get_functiondef(p.oid) LIKE '%first_name%';

ROLLBACK;
