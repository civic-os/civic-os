-- Verify civic_os:v0-15-0-add-status-type on pg

BEGIN;

-- ============================================================================
-- Verify Tables Exist with Correct Structure
-- ============================================================================

-- Verify status_types table structure
SELECT entity_type, description, created_at, updated_at
FROM metadata.status_types
WHERE FALSE;

-- Verify statuses table structure
SELECT id, entity_type, display_name, description, color, sort_order,
       is_initial, is_terminal, created_at, updated_at
FROM metadata.statuses
WHERE FALSE;


-- ============================================================================
-- Verify Indexes Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND indexname = 'idx_statuses_entity_type';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND indexname = 'idx_statuses_entity_sort';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND indexname = 'idx_statuses_single_initial';


-- ============================================================================
-- Verify Functions Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'get_initial_status';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'get_statuses_for_entity';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'get_status_entity_types';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'validate_status_entity_type';


-- ============================================================================
-- Verify Row Level Security is Enabled
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'status_types' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND rowsecurity = true;


-- ============================================================================
-- Verify RLS Policies Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'status_types' AND policyname = 'status_types_select';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'status_types' AND policyname = 'status_types_insert';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'status_types' AND policyname = 'status_types_update';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'status_types' AND policyname = 'status_types_delete';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND policyname = 'statuses_select';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND policyname = 'statuses_insert';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND policyname = 'statuses_update';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'statuses' AND policyname = 'statuses_delete';


-- ============================================================================
-- Verify metadata.properties Has status_entity_type Column
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'properties' AND column_name = 'status_entity_type';


-- ============================================================================
-- Verify schema_properties View Includes status_entity_type
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_properties' AND column_name = 'status_entity_type';


-- ============================================================================
-- Verify public.statuses View Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'statuses';


-- ============================================================================
-- Verify schema_cache_versions Includes statuses Cache Entry
-- ============================================================================

DO $$
BEGIN
  ASSERT EXISTS(
    SELECT 1 FROM public.schema_cache_versions
    WHERE cache_name = 'statuses'
  ), 'schema_cache_versions missing statuses cache entry';
END $$;


-- ============================================================================
-- Verify Foreign Key Constraint
-- ============================================================================

DO $$
BEGIN
  ASSERT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname = 'statuses_entity_type_fkey'
      AND conrelid = 'metadata.statuses'::regclass
  ), 'statuses.entity_type FK constraint missing';
END $$;


-- ============================================================================
-- Test Functions Actually Work
-- ============================================================================

-- Test get_status_entity_types() returns empty set when no types exist
DO $$
DECLARE
  result_count INT;
BEGIN
  SELECT COUNT(*) INTO result_count FROM get_status_entity_types();
  -- Should return 0 or more (doesn't error)
END $$;

-- Test get_initial_status() returns NULL when no type exists
DO $$
DECLARE
  result INT;
BEGIN
  SELECT get_initial_status('nonexistent_type') INTO result;
  ASSERT result IS NULL, 'get_initial_status should return NULL for nonexistent type';
END $$;

-- Test get_statuses_for_entity() returns empty set when no type exists
DO $$
DECLARE
  result_count INT;
BEGIN
  SELECT COUNT(*) INTO result_count FROM get_statuses_for_entity('nonexistent_type');
  ASSERT result_count = 0, 'get_statuses_for_entity should return 0 rows for nonexistent type';
END $$;


ROLLBACK;
