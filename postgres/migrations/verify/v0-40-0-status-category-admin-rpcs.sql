-- Verify civic_os:v0-40-0-status-category-admin-rpcs on pg

BEGIN;

-- ============================================================================
-- 1. PERMISSION INFRASTRUCTURE
-- ============================================================================

-- Verify metadata permission rows exist
SELECT 1/COUNT(*)
FROM metadata.permissions
WHERE table_name = 'metadata.statuses' AND permission = 'create';

SELECT 1/COUNT(*)
FROM metadata.permissions
WHERE table_name = 'metadata.categories' AND permission = 'update';

SELECT 1/COUNT(*)
FROM metadata.permissions
WHERE table_name = 'metadata.status_transitions' AND permission = 'delete';

SELECT 1/COUNT(*)
FROM metadata.permissions
WHERE table_name = 'metadata.status_types' AND permission = 'read';

SELECT 1/COUNT(*)
FROM metadata.permissions
WHERE table_name = 'metadata.category_groups' AND permission = 'create';

-- ============================================================================
-- 2. BULK PERMISSION LOADING RPC EXISTS
-- ============================================================================

SELECT pg_catalog.has_function_privilege(
  'public.get_current_user_permissions()',
  'execute'
);

-- ============================================================================
-- 3. STATUS CRUD RPCs EXIST
-- ============================================================================

SELECT pg_catalog.has_function_privilege(
  'public.upsert_status_type(text, text, text)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.delete_status_type(text)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.upsert_status(text, varchar, text, text, int, boolean, boolean, int)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.delete_status(int)',
  'execute'
);

-- ============================================================================
-- 4. TRANSITION RPCs EXIST
-- ============================================================================

SELECT pg_catalog.has_function_privilege(
  'public.get_status_transitions_for_entity(text)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.upsert_status_transition(text, int, int, name, varchar, text, int, boolean, int)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.delete_status_transition(int)',
  'execute'
);

-- ============================================================================
-- 5. CATEGORY RPCs EXIST
-- ============================================================================

SELECT pg_catalog.has_function_privilege(
  'public.get_category_entity_types()',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.upsert_category_group(text, text, text)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.delete_category_group(text)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.upsert_category(text, varchar, text, text, int, int)',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.delete_category(int)',
  'execute'
);

-- ============================================================================
-- 6. RLS POLICIES USE has_permission() (spot check)
-- ============================================================================

-- Check that the new policy exists (it should have been recreated)
SELECT 1/COUNT(*)
FROM pg_policies
WHERE tablename = 'statuses'
  AND schemaname = 'metadata'
  AND policyname = 'statuses_insert';

SELECT 1/COUNT(*)
FROM pg_policies
WHERE tablename = 'categories'
  AND schemaname = 'metadata'
  AND policyname = 'categories_update';

-- ============================================================================
-- 7. SCHEMA DECISION RECORDED
-- ============================================================================

SELECT 1/COUNT(*)
FROM metadata.schema_decisions
WHERE migration_id = 'v0-40-0-status-category-admin-rpcs';

ROLLBACK;
