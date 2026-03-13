-- Verify civic_os:v0-37-0-dashboard-features on pg

BEGIN;

-- ============================================================================
-- 1. Verify show_title column exists on metadata.dashboards
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'dashboards'
  AND column_name = 'show_title';

-- ============================================================================
-- 2. Verify dashboard_role_defaults table exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.tables
WHERE table_schema = 'metadata'
  AND table_name = 'dashboard_role_defaults';

-- ============================================================================
-- 3. Verify unique constraint on role_id
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.table_constraints
WHERE table_schema = 'metadata'
  AND table_name = 'dashboard_role_defaults'
  AND constraint_type = 'UNIQUE';

-- ============================================================================
-- 4. Verify get_dashboard() function exists
-- ============================================================================

SELECT has_function_privilege('public.get_dashboard(INT)', 'execute');

-- ============================================================================
-- 5. Verify get_user_default_dashboard() function exists
-- ============================================================================

SELECT has_function_privilege('public.get_user_default_dashboard()', 'execute');

-- ============================================================================
-- 6. Verify get_dashboards() function exists
-- ============================================================================

SELECT has_function_privilege('public.get_dashboards()', 'execute');

ROLLBACK;
