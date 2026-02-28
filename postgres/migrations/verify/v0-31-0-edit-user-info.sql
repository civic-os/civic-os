-- Verify civic_os:v0-31-0-edit-user-info on pg

BEGIN;

-- Verify first_name/last_name columns exist on civic_os_users_private
SELECT first_name, last_name FROM metadata.civic_os_users_private LIMIT 0;

-- Verify update_user_info function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'update_user_info';

-- Verify managed_users view includes new columns
SELECT first_name, last_name FROM managed_users LIMIT 0;

ROLLBACK;
