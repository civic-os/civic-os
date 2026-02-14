-- Verify civic_os:v0-29-0-source-code-visibility on pg

BEGIN;

-- ============================================================================
-- Verify schema_functions has source_code column
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'schema_functions'
  AND column_name = 'source_code';

-- ============================================================================
-- Verify schema_functions has language column
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'schema_functions'
  AND column_name = 'language';

-- ============================================================================
-- Verify schema_triggers has trigger_definition column
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'schema_triggers'
  AND column_name = 'trigger_definition';

-- ============================================================================
-- Verify schema_triggers has function_source column
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'schema_triggers'
  AND column_name = 'function_source';

-- ============================================================================
-- Verify get_entity_source_code() function exists
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'get_entity_source_code';

-- ============================================================================
-- Verify schema_rls_policies view exists
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'schema_rls_policies';

-- ============================================================================
-- Verify schema_functions has ast_json column
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'schema_functions'
  AND column_name = 'ast_json';

-- ============================================================================
-- Verify parsed_source_code table exists
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata'
  AND table_name = 'parsed_source_code';

-- ============================================================================
-- Verify parsed_source_code public view exists
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'parsed_source_code';

ROLLBACK;
