-- Verify civic_os:v0-31-0-user-provisioning on pg

BEGIN;

-- ============================================================================
-- Verify user_provisioning table exists
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata'
  AND table_name = 'user_provisioning';

-- ============================================================================
-- Verify role_can_manage table exists
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata'
  AND table_name = 'role_can_manage';

-- ============================================================================
-- Verify user_provisioning has expected columns
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'user_provisioning'
  AND column_name = 'email';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'user_provisioning'
  AND column_name = 'initial_roles';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'user_provisioning'
  AND column_name = 'keycloak_user_id';

-- ============================================================================
-- Verify managed_users view exists (read-only, for data retrieval)
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'managed_users';

-- ============================================================================
-- Verify mutation RPCs exist
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'create_provisioned_user';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'retry_user_provisioning';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'bulk_provision_users';

-- ============================================================================
-- Verify role management RPCs exist
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'can_manage_role';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'get_manageable_roles';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'assign_user_role';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'revoke_user_role';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'delete_role';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'set_role_can_manage';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'get_role_can_manage';

-- ============================================================================
-- Verify RLS is enabled on new tables
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'metadata'
  AND c.relname = 'user_provisioning'
  AND c.relrowsecurity = true;

SELECT 1/COUNT(*) FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'metadata'
  AND c.relname = 'role_can_manage'
  AND c.relrowsecurity = true;

ROLLBACK;
