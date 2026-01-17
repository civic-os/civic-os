-- Verify civic_os:v0-26-0-impersonation on pg

BEGIN;

-- Verify admin_audit_log table exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables
WHERE schemaname = 'metadata' AND tablename = 'admin_audit_log';

-- Verify admin_audit_log has expected columns
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'admin_audit_log' AND column_name = 'event_type';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'admin_audit_log' AND column_name = 'event_data';

-- Verify is_real_admin function exists in both schemas
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'is_real_admin';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'is_real_admin';

-- Verify log_impersonation function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'log_impersonation';

-- Verify get_admin_audit_log function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'get_admin_audit_log';

-- Verify get_user_roles still exists (was modified, not removed)
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'get_user_roles';

ROLLBACK;
