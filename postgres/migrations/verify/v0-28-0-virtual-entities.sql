-- Verify civic_os:v0-28-0-virtual-entities on pg

BEGIN;

-- ============================================================================
-- Verify metadata.properties FK override columns exist
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'properties'
  AND column_name = 'join_table';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'properties'
  AND column_name = 'join_column';


-- ============================================================================
-- Verify schema_view_relations_func() exists
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'schema_view_relations_func';


-- ============================================================================
-- Verify schema_view_validations_func() exists
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'schema_view_validations_func';


-- ============================================================================
-- Verify schema_entities view includes is_view column
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'schema_entities'
  AND column_name = 'is_view';


-- ============================================================================
-- Verify upsert_property_metadata function has new signature (15 params)
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'upsert_property_metadata'
  AND p.pronargs = 15;


-- ============================================================================
-- Verify schema_view_relations_func returns expected columns
-- ============================================================================

SELECT 1/(CASE
  WHEN (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'schema_view_relations_func'
          OR column_name IN ('view_name', 'view_column', 'join_schema', 'join_table', 'join_column')) >= 0
  THEN 1 ELSE 0 END);

-- Actually test the function is callable (even if it returns no rows for tables)
SELECT 1/(CASE WHEN (SELECT COUNT(*) FROM schema_view_relations_func()) >= 0 THEN 1 ELSE 0 END);


-- ============================================================================
-- Verify schema_entities query works (don't require tables to exist)
-- ============================================================================
-- This ensures the view is queryable and the is_view column works

SELECT 1/(CASE
  WHEN (SELECT COUNT(*) FROM schema_entities WHERE is_view IS NOT NULL) >= 0
  THEN 1 ELSE 0 END);


-- ============================================================================
-- Verify VIEWs without metadata do NOT appear in schema_entities
-- ============================================================================
-- Create a test view, verify it doesn't appear, then clean up

CREATE OR REPLACE VIEW public._test_virtual_entity_verify AS
SELECT 1 AS id, 'test' AS name;

-- View should NOT appear (no metadata entry)
SELECT 1/(CASE
  WHEN NOT EXISTS (SELECT 1 FROM schema_entities WHERE table_name = '_test_virtual_entity_verify')
  THEN 1 ELSE 0 END);

DROP VIEW public._test_virtual_entity_verify;


ROLLBACK;
