-- Revert civic_os:v0-41-0-schema-functions-perf from pg

BEGIN;

-- ============================================================================
-- RESTORE ORIGINAL information_schema VERSIONS
-- ============================================================================
-- Since we used CREATE OR REPLACE (same return types), revert is simply
-- replacing the function bodies back to the information_schema versions.
-- No views need to be dropped/recreated.
-- ============================================================================


-- ============================================================================
-- 1. RESTORE schema_relations_func() (from v0-8-2)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.schema_relations_func()
RETURNS TABLE (
  src_schema NAME,
  src_table NAME,
  src_column NAME,
  constraint_schema NAME,
  constraint_name NAME,
  join_schema NAME,
  join_table NAME,
  join_column NAME
)
LANGUAGE 'sql'
SECURITY DEFINER
AS $BODY$
SELECT
  k_c_u.table_schema AS src_schema,
  k_c_u.table_name AS src_table,
  k_c_u.column_name AS src_column,
  c_c_u.constraint_schema,
  c_c_u.constraint_name,
  c_c_u.table_schema AS join_schema,
  c_c_u.table_name AS join_table,
  c_c_u.column_name AS join_column
FROM
  information_schema.key_column_usage AS k_c_u
  JOIN information_schema.referential_constraints r_c
    ON k_c_u.constraint_name::name = r_c.constraint_name::name
  JOIN information_schema.constraint_column_usage c_c_u
    ON r_c.unique_constraint_name::name = c_c_u.constraint_name::name
    AND r_c.unique_constraint_schema::name = c_c_u.constraint_schema::name;  -- FIX: Also match schema
$BODY$;


-- ============================================================================
-- 2. RESTORE schema_view_relations_func() (from v0-28-0)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.schema_view_relations_func()
RETURNS TABLE (
  view_name NAME,
  view_column NAME,
  join_schema NAME,
  join_table NAME,
  join_column NAME
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT DISTINCT ON (vcu.view_name, vcu.column_name)
    vcu.view_name::name,
    vcu.column_name::name AS view_column,
    ccu.table_schema::name AS join_schema,
    ccu.table_name::name AS join_table,
    ccu.column_name::name AS join_column
  FROM information_schema.view_column_usage vcu
  JOIN information_schema.key_column_usage kcu
    ON kcu.table_schema = vcu.table_schema
    AND kcu.table_name = vcu.table_name
    AND kcu.column_name = vcu.column_name
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_schema = kcu.constraint_schema
    AND rc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_schema = rc.unique_constraint_schema
    AND ccu.constraint_name = rc.unique_constraint_name
  WHERE vcu.view_schema = 'public'
$$;

COMMENT ON FUNCTION public.schema_view_relations_func IS
    'Traces VIEW columns to base table FK constraints via view_column_usage.
     Enables automatic FK dropdown population for VIEW columns that directly
     reference base table columns with FK constraints.
     Returns: view_name, view_column, join_schema, join_table, join_column.
     Limitations: Does not work for computed columns or complex expressions.
     Added in v0.28.0.';


-- ============================================================================
-- 3. RESTORE schema_view_validations_func() (from v0-28-0)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.schema_view_validations_func()
RETURNS TABLE (
  view_name NAME,
  view_column NAME,
  validation_rules JSONB
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT DISTINCT ON (vcu.view_name, vcu.column_name)
    vcu.view_name::name,
    vcu.column_name::name AS view_column,
    base_validations.validation_rules
  FROM information_schema.view_column_usage vcu
  JOIN (
    SELECT
      table_name,
      column_name,
      jsonb_agg(
        jsonb_build_object(
          'type', validation_type,
          'value', validation_value,
          'message', error_message
        )
        ORDER BY sort_order
      ) AS validation_rules
    FROM metadata.validations
    GROUP BY table_name, column_name
  ) base_validations
    ON base_validations.table_name = vcu.table_name::name
    AND base_validations.column_name = vcu.column_name::name
  WHERE vcu.view_schema = 'public'
$$;

COMMENT ON FUNCTION public.schema_view_validations_func IS
    'Traces VIEW columns to base table validation rules via view_column_usage.
     Enables automatic validation inheritance for VIEW columns that directly
     reference base table columns with validation rules.
     Returns: view_name, view_column, validation_rules.
     Priority: Direct VIEW validations override inherited validations.
     Limitations: Does not work for computed columns or complex expressions.
     Added in v0.28.0.';


-- ============================================================================
-- 4. REMOVE SCHEMA DECISION
-- ============================================================================

DELETE FROM metadata.schema_decisions
WHERE migration_id = 'v0-41-0-schema-functions-perf';


NOTIFY pgrst, 'reload schema';


COMMIT;
