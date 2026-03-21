-- Deploy civic_os:v0-41-0-schema-functions-perf to pg
-- requires: v0-40-0-status-category-admin-rpcs

BEGIN;

-- ============================================================================
-- SCHEMA METADATA FUNCTION PERFORMANCE REWRITE
-- ============================================================================
-- Version: v0.41.0
-- Purpose: Replace information_schema queries with pg_catalog queries in all
--          three schema metadata functions for ~50-60x speedup.
--
-- Root Cause: information_schema views wrap pg_catalog tables with per-row
--   has_column_privilege() / pg_has_role() checks. Under SECURITY DEFINER,
--   every row passes — it's pure overhead. On a 2GB containerized PG17,
--   schema_properties takes ~3.2s; after this change, ~30ms.
--
-- Functions Rewritten:
--   1. schema_relations_func()         - Table FK detection
--   2. schema_view_relations_func()    - VIEW FK inheritance
--   3. schema_view_validations_func()  - VIEW validation inheritance
--
-- Return Types: UNCHANGED — same column names, same types, same semantics.
--   schema_properties VIEW auto-uses new implementations via CREATE OR REPLACE.
--
-- Bonus Fix: unnest(conkey, confkey) WITH ORDINALITY correctly pairs composite
--   FK columns; the old information_schema approach could produce cross-products
--   when multiple FK columns existed on the same constraint.
--
-- Precedent: schema_entity_dependencies VIEW (v0-23-0) already uses this exact
--   pg_constraint + pg_class + pg_namespace pattern for FK detection.
-- ============================================================================


-- ============================================================================
-- 1. schema_relations_func() — Table FK Detection
-- ============================================================================
-- Replaces: information_schema.key_column_usage + referential_constraints
--           + constraint_column_usage
-- Uses:     pg_constraint + pg_class + pg_namespace + pg_attribute
--           + unnest(conkey, confkey) WITH ORDINALITY

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
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT
    src_ns.nspname    AS src_schema,
    src_cl.relname    AS src_table,
    src_att.attname   AS src_column,
    uq_ns.nspname     AS constraint_schema,
    uq_con.conname    AS constraint_name,
    tgt_ns.nspname    AS join_schema,
    tgt_cl.relname    AS join_table,
    tgt_att.attname   AS join_column
  FROM pg_constraint con
  -- Source table
  JOIN pg_class src_cl ON src_cl.oid = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src_cl.relnamespace
  -- Target (referenced) table
  JOIN pg_class tgt_cl ON tgt_cl.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt_cl.relnamespace
  -- Referenced UNIQUE/PK constraint (matches old information_schema behavior)
  JOIN pg_constraint uq_con
    ON uq_con.conindid = con.conindid
   AND uq_con.conrelid = con.confrelid
   AND uq_con.contype IN ('p', 'u')
  JOIN pg_namespace uq_ns ON uq_ns.oid = uq_con.connamespace
  -- Unnest paired source/target column numbers (fixes composite FK cross-product)
  JOIN LATERAL unnest(con.conkey, con.confkey)
       WITH ORDINALITY AS cols(src_attnum, tgt_attnum, ord) ON true
  -- Source column name
  JOIN pg_attribute src_att
    ON src_att.attrelid = con.conrelid
   AND src_att.attnum = cols.src_attnum
  -- Target column name
  JOIN pg_attribute tgt_att
    ON tgt_att.attrelid = con.confrelid
   AND tgt_att.attnum = cols.tgt_attnum
  WHERE con.contype = 'f'  -- foreign key constraints only
$$;

COMMENT ON FUNCTION public.schema_relations_func IS
    'Detects FK constraints on tables via pg_catalog (50x faster than information_schema).
     Uses unnest(conkey, confkey) WITH ORDINALITY for correct composite FK pairing.
     Rewritten in v0.41.0 for performance; return type unchanged from v0.8.2.';


-- ============================================================================
-- 2. schema_view_relations_func() — VIEW FK Inheritance
-- ============================================================================
-- Replaces: information_schema.view_column_usage + key_column_usage
--           + referential_constraints + constraint_column_usage
-- Uses:     pg_rewrite + pg_depend to trace VIEW → base table columns,
--           then pg_constraint for FK lookup.
--
-- The dependency chain:
--   pg_class (view, relkind='v')
--     → pg_rewrite (ev_class = view OID)
--     → pg_depend (objid = rewrite OID, deptype='n', refobjsubid > 0)
--     → pg_class (base table) + pg_attribute (base column)
--     → pg_constraint (FK on base column)
--     → pg_class/pg_attribute (FK target)

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
SET search_path = pg_catalog
AS $$
  WITH view_base_cols AS (
    -- Find base table columns that each public VIEW depends on
    SELECT DISTINCT
      v.relname        AS view_name,
      base_att.attname AS base_column,
      base_cl.oid      AS base_relid
    FROM pg_class v
    JOIN pg_namespace v_ns ON v_ns.oid = v.relnamespace
    -- View's rewrite rule
    JOIN pg_rewrite rw ON rw.ev_class = v.oid
    -- Dependencies of that rewrite rule on base table columns
    JOIN pg_depend d
      ON d.objid = rw.oid
     AND d.classid = 'pg_rewrite'::regclass
     AND d.refclassid = 'pg_class'::regclass
     AND d.deptype = 'n'          -- normal dependency
     AND d.refobjsubid > 0        -- column-level (subid > 0)
    -- Base table
    JOIN pg_class base_cl ON base_cl.oid = d.refobjid
    -- Base column
    JOIN pg_attribute base_att
      ON base_att.attrelid = d.refobjid
     AND base_att.attnum = d.refobjsubid
     AND NOT base_att.attisdropped
    WHERE v.relkind = 'v'
      AND v_ns.nspname = 'public'
      AND base_cl.relkind IN ('r', 'v', 'f', 'p')
  )
  SELECT DISTINCT ON (vbc.view_name, vbc.base_column)
    vbc.view_name,
    vbc.base_column   AS view_column,
    tgt_ns.nspname    AS join_schema,
    tgt_cl.relname    AS join_table,
    tgt_att.attname   AS join_column
  FROM view_base_cols vbc
  -- FK constraints on the base table
  JOIN pg_constraint con
    ON con.conrelid = vbc.base_relid
   AND con.contype = 'f'
  -- Unnest to find which FK column matches our base column
  JOIN LATERAL unnest(con.conkey, con.confkey)
       WITH ORDINALITY AS cols(src_attnum, tgt_attnum, ord) ON true
  JOIN pg_attribute src_att
    ON src_att.attrelid = con.conrelid
   AND src_att.attnum = cols.src_attnum
  -- Only rows where the FK source column matches our base column
  -- Target table/column
  JOIN pg_class tgt_cl ON tgt_cl.oid = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt_cl.relnamespace
  JOIN pg_attribute tgt_att
    ON tgt_att.attrelid = con.confrelid
   AND tgt_att.attnum = cols.tgt_attnum
  WHERE src_att.attname = vbc.base_column
$$;

COMMENT ON FUNCTION public.schema_view_relations_func IS
    'Traces VIEW columns to base table FK constraints via pg_depend/pg_rewrite
     (50x faster than information_schema.view_column_usage).
     Returns: view_name, view_column, join_schema, join_table, join_column.
     Limitations: Does not work for computed columns or complex expressions.
     Rewritten in v0.41.0 for performance; return type unchanged from v0.28.0.';


-- ============================================================================
-- 3. schema_view_validations_func() — VIEW Validation Inheritance
-- ============================================================================
-- Same pg_depend/pg_rewrite tracing as above, but JOINs to
-- metadata.validations instead of pg_constraint for FK lookup.

CREATE OR REPLACE FUNCTION public.schema_view_validations_func()
RETURNS TABLE (
  view_name NAME,
  view_column NAME,
  validation_rules JSONB
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, metadata
AS $$
  WITH view_base_cols AS (
    -- Find base table columns that each public VIEW depends on
    SELECT DISTINCT
      v.relname        AS view_name,
      base_att.attname AS base_column,
      base_cl.relname  AS base_table
    FROM pg_class v
    JOIN pg_namespace v_ns ON v_ns.oid = v.relnamespace
    JOIN pg_rewrite rw ON rw.ev_class = v.oid
    JOIN pg_depend d
      ON d.objid = rw.oid
     AND d.classid = 'pg_rewrite'::regclass
     AND d.refclassid = 'pg_class'::regclass
     AND d.deptype = 'n'
     AND d.refobjsubid > 0
    JOIN pg_class base_cl ON base_cl.oid = d.refobjid
    JOIN pg_attribute base_att
      ON base_att.attrelid = d.refobjid
     AND base_att.attnum = d.refobjsubid
     AND NOT base_att.attisdropped
    WHERE v.relkind = 'v'
      AND v_ns.nspname = 'public'
      AND base_cl.relkind IN ('r', 'v', 'f', 'p')
  )
  SELECT DISTINCT ON (vbc.view_name, vbc.base_column)
    vbc.view_name,
    vbc.base_column AS view_column,
    base_validations.validation_rules
  FROM view_base_cols vbc
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
    ON base_validations.table_name = vbc.base_table
   AND base_validations.column_name = vbc.base_column
$$;

COMMENT ON FUNCTION public.schema_view_validations_func IS
    'Traces VIEW columns to base table validation rules via pg_depend/pg_rewrite
     (50x faster than information_schema.view_column_usage).
     Returns: view_name, view_column, validation_rules.
     Priority: Direct VIEW validations override inherited validations.
     Rewritten in v0.41.0 for performance; return type unchanged from v0.28.0.';


-- ============================================================================
-- 4. SCHEMA DECISION
-- ============================================================================

INSERT INTO metadata.schema_decisions (
  migration_id,
  title,
  status,
  decision,
  context,
  consequences
) VALUES (
  'v0-41-0-schema-functions-perf',
  'Rewrite schema metadata functions from information_schema to pg_catalog',
  'accepted',
  'Replace information_schema queries with direct pg_catalog queries in schema_relations_func(), schema_view_relations_func(), and schema_view_validations_func(). Same return types, same semantics.',
  'schema_properties VIEW takes ~3.2s on containerized PG17. EXPLAIN ANALYZE shows information_schema per-row privilege checks (has_column_privilege, pg_has_role) dominate. Since functions are SECURITY DEFINER, checks always pass — pure overhead. Worsened after v0-23-0 added more public schema objects.',
  'Expected ~50-60x speedup (3.2s → ~30ms). Fixes latent composite FK cross-product bug via unnest(conkey, confkey) WITH ORDINALITY. No frontend changes needed — same function signatures. schema_entity_dependencies VIEW (v0-23-0) already uses this pg_catalog pattern as precedent.'
);


-- ============================================================================
-- 5. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
