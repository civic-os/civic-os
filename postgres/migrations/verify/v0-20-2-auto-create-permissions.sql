-- Verify v0-20-2-auto-create-permissions

BEGIN;

-- Verify set_role_permission function exists with correct signature
SELECT 1/COUNT(*)
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'set_role_permission'
  AND pg_get_function_arguments(p.oid) = 'p_role_id smallint, p_table_name text, p_permission text, p_enabled boolean';

-- Verify ensure_table_permissions function exists
SELECT 1/COUNT(*)
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'ensure_table_permissions';

ROLLBACK;
