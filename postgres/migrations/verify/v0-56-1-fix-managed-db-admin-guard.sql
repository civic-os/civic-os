-- Verify v0-56-1-fix-managed-db-admin-guard

-- 1. Verify metadata._is_db_admin() exists
SELECT 1 FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = '_is_db_admin';

-- 2. Verify all 3 functions reference _is_db_admin in their source
SELECT 1 FROM pg_proc
WHERE proname = 'register_guided_form'
  AND prosrc LIKE '%_is_db_admin%';

SELECT 1 FROM pg_proc
WHERE proname = 'add_guided_form_step'
  AND prosrc LIKE '%_is_db_admin%';

SELECT 1 FROM pg_proc
WHERE proname = 'grant_guided_form_permissions'
  AND prosrc LIKE '%_is_db_admin%';
