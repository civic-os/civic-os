-- Verify civic_os:v0-30-0-schema-decisions on pg

BEGIN;

-- ============================================================================
-- Verify schema_decisions table exists in metadata schema
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata'
  AND table_name = 'schema_decisions';

-- ============================================================================
-- Verify schema_decisions has expected columns
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'schema_decisions'
  AND column_name = 'entity_types';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'schema_decisions'
  AND column_name = 'property_names';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'schema_decisions'
  AND column_name = 'superseded_by_id';

-- ============================================================================
-- Verify create_schema_decision() function exists
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'create_schema_decision';

-- ============================================================================
-- Verify public.schema_decisions view exists
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'schema_decisions';

-- ============================================================================
-- Verify RLS is enabled on the table
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'metadata'
  AND c.relname = 'schema_decisions'
  AND c.relrowsecurity = true;

ROLLBACK;
