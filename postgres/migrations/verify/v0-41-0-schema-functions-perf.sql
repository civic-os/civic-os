-- Verify civic_os:v0-41-0-schema-functions-perf on pg

BEGIN;

-- ============================================================================
-- 1. FUNCTIONS EXIST AND ARE EXECUTABLE
-- ============================================================================

SELECT pg_catalog.has_function_privilege(
  'public.schema_relations_func()',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.schema_view_relations_func()',
  'execute'
);

SELECT pg_catalog.has_function_privilege(
  'public.schema_view_validations_func()',
  'execute'
);

-- ============================================================================
-- 2. RETURN TYPES ARE CORRECT (columns exist and can be selected)
-- ============================================================================

-- schema_relations_func: 8 columns
SELECT src_schema, src_table, src_column,
       constraint_schema, constraint_name,
       join_schema, join_table, join_column
FROM schema_relations_func()
LIMIT 0;

-- schema_view_relations_func: 5 columns
SELECT view_name, view_column,
       join_schema, join_table, join_column
FROM schema_view_relations_func()
LIMIT 0;

-- schema_view_validations_func: 3 columns
SELECT view_name, view_column, validation_rules
FROM schema_view_validations_func()
LIMIT 0;

-- ============================================================================
-- 3. FUNCTIONS HAVE search_path CONFIGURED (indicates pg_catalog rewrite)
-- ============================================================================
-- proconfig stores SET parameters; the rewritten functions have
-- SET search_path = pg_catalog (the old versions had no proconfig)

SELECT 1/COUNT(*)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'schema_relations_func'
  AND p.proconfig IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM unnest(p.proconfig) AS cfg
    WHERE cfg LIKE 'search_path=%pg_catalog%'
  );

SELECT 1/COUNT(*)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'schema_view_relations_func'
  AND p.proconfig IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM unnest(p.proconfig) AS cfg
    WHERE cfg LIKE 'search_path=%pg_catalog%'
  );

SELECT 1/COUNT(*)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'schema_view_validations_func'
  AND p.proconfig IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM unnest(p.proconfig) AS cfg
    WHERE cfg LIKE 'search_path=%pg_catalog%'
  );

-- ============================================================================
-- 4. SCHEMA DECISION RECORDED
-- ============================================================================

SELECT 1/COUNT(*)
FROM metadata.schema_decisions
WHERE migration_id = 'v0-41-0-schema-functions-perf';

ROLLBACK;
