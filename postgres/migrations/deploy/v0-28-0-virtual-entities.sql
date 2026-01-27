-- Deploy civic_os:v0-28-0-virtual-entities to pg
-- requires: v0-27-0-ical-helpers

BEGIN;

-- ============================================================================
-- VIRTUAL ENTITIES SUPPORT
-- ============================================================================
-- Version: v0.28.0
-- Purpose: Enable PostgreSQL VIEWs with INSTEAD OF triggers to behave like
--          regular entities in Civic OS. This allows simplified form interfaces
--          (e.g., manager event creation that auto-approves).
--
-- Key Changes:
--   1. Add FK override columns to metadata.properties for computed VIEW columns
--   2. Create schema_view_relations_func() to trace VIEW columns to base FKs
--   3. Update schema_properties view with 3-way COALESCE for FK detection
--   4. Update schema_entities view to include VIEWs (hybrid: tables auto-discover,
--      VIEWs require metadata.entities entry)
--
-- FK Detection Priority (COALESCE chain):
--   1. metadata.properties.join_table  (manual override - highest priority)
--   2. schema_view_relations_func()    (auto for VIEWs via view_column_usage)
--   3. schema_relations_func()         (auto for tables via FK constraints)
--
-- Usage:
--   - Tables continue to work as before (auto-discovered, FK auto-detected)
--   - VIEWs require: metadata.entities entry + INSTEAD OF triggers
--   - VIEW columns auto-inherit FKs from base tables for simple column refs
--   - Computed VIEW columns need manual metadata.properties.join_table config
-- ============================================================================


-- ============================================================================
-- 1. ADD FK OVERRIDE COLUMNS TO metadata.properties
-- ============================================================================
-- These columns allow manual FK configuration for VIEW columns where
-- auto-detection doesn't work (computed expressions, ambiguous JOINs).

ALTER TABLE metadata.properties
  ADD COLUMN IF NOT EXISTS join_table NAME,
  ADD COLUMN IF NOT EXISTS join_column NAME;

COMMENT ON COLUMN metadata.properties.join_table IS
    'FK target table. Overrides auto-detected FK. Required for computed VIEW columns.
     Example: A VIEW with COALESCE(a.user_id, b.user_id) needs manual join_table = ''civic_os_users''.
     Added in v0.28.0.';

COMMENT ON COLUMN metadata.properties.join_column IS
    'FK target column. Overrides auto-detected FK. Usually ''id'' for standard FKs.
     Required when join_table is set.
     Added in v0.28.0.';


-- ============================================================================
-- 2. CREATE schema_view_relations_func() FOR VIEW FK INHERITANCE
-- ============================================================================
-- Traces VIEW columns back to base table FK constraints via view_column_usage.
-- This enables automatic FK dropdown population for simple VIEW column references.
--
-- How it works:
--   1. view_column_usage tells us which base table column a VIEW column comes from
--   2. We look up if that base column has an FK constraint
--   3. If so, we return the FK target for the VIEW column
--
-- Limitations (require manual join_table/join_column):
--   - Computed columns: COALESCE(a, b), CASE WHEN, etc.
--   - Aliased columns where the alias doesn't match base column
--   - Complex JOINs with ambiguous column origins

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
  -- Join to find FK constraint on the base table column
  JOIN information_schema.key_column_usage kcu
    ON kcu.table_schema = vcu.table_schema
    AND kcu.table_name = vcu.table_name
    AND kcu.column_name = vcu.column_name
  -- Get the referential constraint
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_schema = kcu.constraint_schema
    AND rc.constraint_name = kcu.constraint_name
  -- Get the target table/column of the FK
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

GRANT EXECUTE ON FUNCTION public.schema_view_relations_func() TO web_anon, authenticated;


-- ============================================================================
-- 3. CREATE schema_view_validations_func() FOR VALIDATION INHERITANCE
-- ============================================================================
-- Traces VIEW columns back to base table validation rules via view_column_usage.
-- This enables automatic validation inheritance for simple VIEW column references.
--
-- How it works:
--   1. view_column_usage tells us which base table column a VIEW column comes from
--   2. We look up if that base column has validation rules in metadata.validations
--   3. If so, we return those rules for the VIEW column
--
-- Priority (handled in schema_properties COALESCE):
--   1. Direct validations on VIEW column (override - explicit validation for VIEW)
--   2. Inherited validations from base table (this function)
--   3. Empty array (no validations)
--
-- Limitations (validations won't inherit):
--   - Computed columns: COALESCE(a, b), CASE WHEN, etc.
--   - Aliased columns where the alias doesn't match base column name
--   - Complex JOINs with ambiguous column origins

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
  -- Join to get validation rules from the base table column
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

GRANT EXECUTE ON FUNCTION public.schema_view_validations_func() TO web_anon, authenticated;


-- ============================================================================
-- 5. UPDATE schema_properties VIEW WITH 3-WAY FK COALESCE + VALIDATION INHERITANCE
-- ============================================================================
-- Priority order for FK detection:
--   1. metadata.properties.join_table  (manual override - highest priority)
--   2. schema_view_relations_func()    (auto for VIEWs)
--   3. schema_relations_func()         (auto for tables)
--
-- Priority order for validation inheritance:
--   1. Direct validations on column (explicit - allows VIEW-specific rules)
--   2. Inherited validations from base table (for VIEWs)
--   3. Empty array (no validations)

CREATE OR REPLACE VIEW public.schema_properties AS
SELECT
  columns.table_catalog,
  columns.table_schema,
  columns.table_name,
  columns.column_name,
  COALESCE(properties.display_name, initcap(replace(columns.column_name::text, '_', ' '))) AS display_name,
  properties.description,
  COALESCE(properties.sort_order, columns.ordinal_position::integer) AS sort_order,
  properties.column_width,
  COALESCE(properties.sortable, true) AS sortable,
  COALESCE(properties.filterable, false) AS filterable,
  COALESCE(properties.show_on_list,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END
  ) AS show_on_list,
  COALESCE(properties.show_on_create,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END
  ) AS show_on_create,
  COALESCE(properties.show_on_edit,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END
  ) AS show_on_edit,
  COALESCE(properties.show_on_detail,
    CASE WHEN columns.column_name IN ('id', 'civic_os_text_search') THEN false
         WHEN columns.column_name IN ('created_at', 'updated_at') THEN true ELSE true END
  ) AS show_on_detail,
  columns.column_default,
  columns.is_nullable::text = 'YES' AS is_nullable,
  columns.data_type,
  columns.character_maximum_length,
  columns.udt_schema,
  COALESCE(pg_type_info.domain_name, columns.udt_name) AS udt_name,
  columns.is_self_referencing::text = 'YES' AS is_self_referencing,
  columns.is_identity::text = 'YES' AS is_identity,
  columns.is_generated::text = 'ALWAYS' AS is_generated,
  columns.is_updatable::text = 'YES' AS is_updatable,
  -- v0.28.0: 3-way COALESCE for FK detection
  -- join_schema: Use table relations or view relations (no manual override for schema)
  COALESCE(table_relations.join_schema, view_relations.join_schema) AS join_schema,
  -- join_table: Manual override > VIEW auto-inherit > Table auto-detect
  COALESCE(
    properties.join_table,      -- 1. Manual override (highest priority)
    view_relations.join_table,  -- 2. Auto-inherit from VIEW base table
    table_relations.join_table  -- 3. Auto-detect from table FK
  ) AS join_table,
  -- join_column: Same priority order
  COALESCE(
    properties.join_column,
    view_relations.join_column,
    table_relations.join_column
  ) AS join_column,
  CASE
    WHEN columns.udt_name IN ('geography', 'geometry') THEN
      SUBSTRING(pg_type_info.formatted_type FROM '\(([A-Za-z]+)')
    ELSE NULL
  END AS geography_type,
  -- v0.28.0: Validation inheritance for VIEWs
  -- Direct validations override inherited validations (all-or-nothing per column)
  COALESCE(
    direct_validations.validation_rules,    -- 1. Direct validations (explicit override)
    inherited_validations.validation_rules, -- 2. Inherited from base table (for VIEWs)
    '[]'::jsonb                             -- 3. No validations
  ) AS validation_rules,
  properties.status_entity_type,
  COALESCE(properties.is_recurring, false) AS is_recurring
FROM information_schema.columns
-- Table FK detection (existing pattern)
LEFT JOIN (SELECT * FROM schema_relations_func()) table_relations
  ON columns.table_schema::name = table_relations.src_schema
  AND columns.table_name::name = table_relations.src_table
  AND columns.column_name::name = table_relations.src_column
-- VIEW FK inheritance (new in v0.28.0)
LEFT JOIN (SELECT * FROM schema_view_relations_func()) view_relations
  ON columns.table_name::name = view_relations.view_name
  AND columns.column_name::name = view_relations.view_column
-- Manual metadata override
LEFT JOIN metadata.properties
  ON properties.table_name = columns.table_name::name
  AND properties.column_name = columns.column_name::name
-- Type info for domains/geography
LEFT JOIN (
  SELECT c.relname AS table_name, a.attname AS column_name,
         format_type(a.atttypid, a.atttypmod) AS formatted_type,
         CASE WHEN t.typtype = 'd' THEN t.typname ELSE NULL END AS domain_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_type t ON a.atttypid = t.oid
  WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
) pg_type_info
  ON pg_type_info.table_name = columns.table_name::name
  AND pg_type_info.column_name = columns.column_name::name
-- Direct validation rules (on the column itself)
LEFT JOIN (
  SELECT table_name, column_name,
         jsonb_agg(jsonb_build_object('type', validation_type, 'value', validation_value, 'message', error_message) ORDER BY sort_order) AS validation_rules
  FROM metadata.validations GROUP BY table_name, column_name
) direct_validations
  ON direct_validations.table_name = columns.table_name::name
  AND direct_validations.column_name = columns.column_name::name
-- Inherited validation rules from base table (for VIEWs, new in v0.28.0)
LEFT JOIN (SELECT * FROM schema_view_validations_func()) inherited_validations
  ON columns.table_name::name = inherited_validations.view_name
  AND columns.column_name::name = inherited_validations.view_column
WHERE columns.table_schema::name = 'public'
  AND columns.table_name::name IN (SELECT table_name FROM schema_entities);

COMMENT ON VIEW public.schema_properties IS
    'Property metadata view with 3-way FK COALESCE and validation inheritance.
     FK priority: manual override > VIEW auto-inherit > table auto-detect.
     Validation priority: direct (override) > inherited from base > empty.
     Updated in v0.28.0.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 6. UPDATE schema_entities VIEW FOR VIRTUAL ENTITIES
-- ============================================================================
-- Changes from previous version:
--   1. table_type filter: 'BASE TABLE' → IN ('BASE TABLE', 'VIEW')
--   2. Hybrid WHERE clause: Tables auto-discovered, VIEWs require metadata entry
--   3. New column: is_view BOOLEAN for frontend awareness

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    -- v0.28.0: New column to identify Virtual Entities
    (tables.table_type::text = 'VIEW'::text) AS is_view
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  -- v0.28.0: Include VIEWs alongside BASE TABLEs
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  -- HYBRID: Tables are auto-discovered, VIEWs require explicit metadata entry
  -- This prevents random VIEWs from appearing in the entity list
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with Virtual Entities support.
     Tables are auto-discovered; VIEWs require explicit metadata.entities entry.
     VIEWs with INSTEAD OF triggers can behave like tables for CRUD operations.
     Added is_view column for frontend awareness.
     Updated in v0.28.0.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;


-- ============================================================================
-- 7. UPDATE upsert_property_metadata RPC TO INCLUDE FK OVERRIDE
-- ============================================================================
-- Add join_table and join_column parameters for manual FK configuration.

-- Drop old function signature (13 parameters from v0.19.0)
DROP FUNCTION IF EXISTS public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN);

-- Create new function signature (15 parameters - adds join_table, join_column)
CREATE OR REPLACE FUNCTION public.upsert_property_metadata(
  p_table_name NAME,
  p_column_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_column_width INT,
  p_sortable BOOLEAN,
  p_filterable BOOLEAN,
  p_show_on_list BOOLEAN,
  p_show_on_create BOOLEAN,
  p_show_on_edit BOOLEAN,
  p_show_on_detail BOOLEAN,
  p_is_recurring BOOLEAN DEFAULT NULL,
  p_join_table NAME DEFAULT NULL,
  p_join_column NAME DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the property metadata
  INSERT INTO metadata.properties (
    table_name,
    column_name,
    display_name,
    description,
    sort_order,
    column_width,
    sortable,
    filterable,
    show_on_list,
    show_on_create,
    show_on_edit,
    show_on_detail,
    is_recurring,
    join_table,
    join_column
  )
  VALUES (
    p_table_name,
    p_column_name,
    p_display_name,
    p_description,
    p_sort_order,
    p_column_width,
    p_sortable,
    p_filterable,
    p_show_on_list,
    p_show_on_create,
    p_show_on_edit,
    p_show_on_detail,
    COALESCE(p_is_recurring, FALSE),
    p_join_table,
    p_join_column
  )
  ON CONFLICT (table_name, column_name)
  DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, metadata.properties.display_name),
    description = COALESCE(EXCLUDED.description, metadata.properties.description),
    sort_order = COALESCE(EXCLUDED.sort_order, metadata.properties.sort_order),
    column_width = COALESCE(EXCLUDED.column_width, metadata.properties.column_width),
    sortable = COALESCE(EXCLUDED.sortable, metadata.properties.sortable),
    filterable = COALESCE(EXCLUDED.filterable, metadata.properties.filterable),
    show_on_list = COALESCE(EXCLUDED.show_on_list, metadata.properties.show_on_list),
    show_on_create = COALESCE(EXCLUDED.show_on_create, metadata.properties.show_on_create),
    show_on_edit = COALESCE(EXCLUDED.show_on_edit, metadata.properties.show_on_edit),
    show_on_detail = COALESCE(EXCLUDED.show_on_detail, metadata.properties.show_on_detail),
    is_recurring = COALESCE(EXCLUDED.is_recurring, metadata.properties.is_recurring),
    join_table = COALESCE(EXCLUDED.join_table, metadata.properties.join_table),
    join_column = COALESCE(EXCLUDED.join_column, metadata.properties.join_column);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NAME, NAME) IS
    'Upsert property metadata including FK override (join_table, join_column).
     Use join_table/join_column for VIEW columns with computed FKs.
     Updated in v0.28.0.';

GRANT EXECUTE ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NAME, NAME) TO authenticated;


-- ============================================================================
-- 8. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
