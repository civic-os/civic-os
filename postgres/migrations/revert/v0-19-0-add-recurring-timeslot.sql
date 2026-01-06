-- Revert civic_os:v0-19-0-add-recurring-timeslot from pg

BEGIN;

-- ============================================================================
-- REVERT RECURRING TIMESLOT SYSTEM
-- ============================================================================
-- Version: v0.19.0
-- This script reverts all changes made by the deploy script.
-- Order matters: drop dependent objects first.
-- ============================================================================


-- ============================================================================
-- 1. DROP PUBLIC VIEW
-- ============================================================================

DROP VIEW IF EXISTS public.schema_series_groups;


-- ============================================================================
-- 2. DROP SUMMARY VIEW
-- ============================================================================

DROP VIEW IF EXISTS metadata.series_groups_summary;


-- ============================================================================
-- 3. DROP TABLES FIRST (CASCADE handles triggers, indexes, policies)
-- ============================================================================
-- IMPORTANT: Tables must be dropped BEFORE functions because triggers on tables
-- depend on the helper functions. CASCADE will automatically clean up the triggers.

DROP TABLE IF EXISTS metadata.time_slot_instances CASCADE;
DROP TABLE IF EXISTS metadata.time_slot_series CASCADE;
DROP TABLE IF EXISTS metadata.time_slot_series_groups CASCADE;


-- ============================================================================
-- 4. DROP RPC FUNCTIONS (safe to drop now that tables are gone)
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_series_membership(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.delete_series_group(BIGINT);
DROP FUNCTION IF EXISTS public.delete_series_with_instances(BIGINT);
DROP FUNCTION IF EXISTS public.update_series_template(BIGINT, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB);
DROP FUNCTION IF EXISTS public.cancel_series_occurrence(NAME, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.expand_series_instances(BIGINT, DATE);
DROP FUNCTION IF EXISTS public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.preview_recurring_conflicts(NAME, NAME, TEXT, NAME, TIMESTAMPTZ[][]);


-- ============================================================================
-- 5. DROP HELPER FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS metadata.prevent_direct_series_delete();
DROP FUNCTION IF EXISTS metadata.modify_rrule_until(TEXT, DATE);
DROP FUNCTION IF EXISTS metadata.validate_template_against_schema(NAME, JSONB);
DROP FUNCTION IF EXISTS metadata.validate_entity_template(NAME, JSONB);
DROP FUNCTION IF EXISTS metadata.validate_rrule(TEXT);


-- ============================================================================
-- 5.5 RESTORE upsert_entity_metadata (remove supports_recurring parameters)
-- ============================================================================
-- Drop the 13-parameter version (from v0.19.0) and restore the 11-parameter version (from v0.16.0)

DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL,
  p_show_calendar BOOLEAN DEFAULT FALSE,
  p_calendar_property_name TEXT DEFAULT NULL,
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the entity metadata
  INSERT INTO metadata.entities (
    table_name,
    display_name,
    description,
    sort_order,
    search_fields,
    show_map,
    map_property_name,
    show_calendar,
    calendar_property_name,
    calendar_color_property,
    enable_notes
  )
  VALUES (
    p_table_name,
    p_display_name,
    p_description,
    p_sort_order,
    p_search_fields,
    p_show_map,
    p_map_property_name,
    p_show_calendar,
    p_calendar_property_name,
    p_calendar_color_property,
    p_enable_notes
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = EXCLUDED.search_fields,
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN) IS
  'Insert or update entity metadata. Admin only. v0.16.0 signature with enable_notes parameter.';

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN) TO authenticated;


-- ============================================================================
-- 6. DROP VIEWS AND REMOVE COLUMNS (correct dependency order)
-- ============================================================================
-- schema_properties depends on schema_entities, so we must:
-- 1. Drop schema_properties first
-- 2. Drop schema_entities
-- 3. Drop columns from metadata tables
-- 4. Recreate schema_entities (which schema_properties depends on)
-- 5. Recreate schema_properties

-- Step 1: Drop schema_properties (depends on is_recurring column and schema_entities)
DROP VIEW IF EXISTS public.schema_properties;

-- Step 2: Drop schema_entities (depends on supports_recurring columns)
DROP VIEW IF EXISTS public.schema_entities;

-- Step 3: Drop columns from metadata tables
ALTER TABLE metadata.properties
    DROP COLUMN IF EXISTS is_recurring;

ALTER TABLE metadata.entities
    DROP COLUMN IF EXISTS supports_recurring,
    DROP COLUMN IF EXISTS recurring_property_name;

-- Step 4: Recreate schema_entities (v0.16.0 version - with enable_notes, without supports_recurring)
CREATE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, FALSE) AS show_map,
    entities.map_property_name,
    tables.table_name,
    public.has_permission(tables.table_name::text, 'create') AS insert,
    public.has_permission(tables.table_name::text, 'read') AS "select",
    public.has_permission(tables.table_name::text, 'update') AS update,
    public.has_permission(tables.table_name::text, 'delete') AS delete,
    COALESCE(entities.show_calendar, FALSE) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, FALSE) AS enable_notes
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
    AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

ALTER VIEW public.schema_entities SET (security_invoker = true);

COMMENT ON VIEW public.schema_entities IS
    'Exposes entity metadata including notes configuration. Updated in v0.16.0 to add enable_notes column.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;

-- Step 5: Recreate schema_properties (v0.15.0 version - without is_recurring)
CREATE VIEW public.schema_properties AS
SELECT
  columns.table_catalog,
  columns.table_schema,
  columns.table_name,
  columns.column_name,
  COALESCE(
    properties.display_name,
    initcap(replace(columns.column_name::text, '_'::text, ' '::text))
  ) AS display_name,
  properties.description,
  COALESCE(
    properties.sort_order,
    columns.ordinal_position::integer
  ) AS sort_order,
  properties.column_width,
  COALESCE(properties.sortable, true) AS sortable,
  COALESCE(properties.filterable, false) AS filterable,
  COALESCE(properties.show_on_list,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_list,
  COALESCE(properties.show_on_create,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_create,
  COALESCE(properties.show_on_edit,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_edit,
  COALESCE(properties.show_on_detail,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search') THEN false
         WHEN columns.column_name::text IN ('created_at', 'updated_at') THEN true
         ELSE true
    END
  ) AS show_on_detail,
  columns.column_default,
  columns.is_nullable::text = 'YES'::text AS is_nullable,
  columns.data_type,
  columns.character_maximum_length,
  columns.udt_schema,
  COALESCE(pg_type_info.domain_name, columns.udt_name) AS udt_name,
  columns.is_self_referencing::text = 'YES'::text AS is_self_referencing,
  columns.is_identity::text = 'YES'::text AS is_identity,
  columns.is_generated::text = 'ALWAYS'::text AS is_generated,
  columns.is_updatable::text = 'YES'::text AS is_updatable,
  relations.join_schema,
  relations.join_table,
  relations.join_column,
  CASE
    WHEN columns.udt_name::text IN ('geography', 'geometry') THEN
      SUBSTRING(
        pg_type_info.formatted_type
        FROM '\(([A-Za-z]+)'
      )
    ELSE NULL
  END AS geography_type,
  COALESCE(
    validation_rules_agg.validation_rules,
    '[]'::jsonb
  ) AS validation_rules,
  properties.status_entity_type
FROM information_schema.columns
LEFT JOIN (
  SELECT
    schema_relations_func.src_schema,
    schema_relations_func.src_table,
    schema_relations_func.src_column,
    schema_relations_func.constraint_schema,
    schema_relations_func.constraint_name,
    schema_relations_func.join_schema,
    schema_relations_func.join_table,
    schema_relations_func.join_column
  FROM schema_relations_func() schema_relations_func(
    src_schema, src_table, src_column, constraint_schema, constraint_name,
    join_schema, join_table, join_column
  )
) relations
  ON columns.table_schema::name = relations.src_schema
  AND columns.table_name::name = relations.src_table
  AND columns.column_name::name = relations.src_column
LEFT JOIN metadata.properties
  ON properties.table_name = columns.table_name::name
  AND properties.column_name = columns.column_name::name
LEFT JOIN (
  SELECT
    c.relname AS table_name,
    a.attname AS column_name,
    format_type(a.atttypid, a.atttypmod) AS formatted_type,
    CASE WHEN t.typtype = 'd' THEN t.typname ELSE NULL END AS domain_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_type t ON a.atttypid = t.oid
  WHERE n.nspname = 'public'
    AND a.attnum > 0
    AND NOT a.attisdropped
) pg_type_info
  ON pg_type_info.table_name = columns.table_name::name
  AND pg_type_info.column_name = columns.column_name::name
LEFT JOIN (
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
) validation_rules_agg
  ON validation_rules_agg.table_name = columns.table_name::name
  AND validation_rules_agg.column_name = columns.column_name::name
WHERE columns.table_schema::name = 'public'::name
  AND columns.table_name::name IN (
    SELECT schema_entities.table_name FROM schema_entities
  );

ALTER VIEW public.schema_properties SET (security_invoker = true);

COMMENT ON VIEW public.schema_properties IS
  'Exposes property metadata including status_entity_type for Status type detection.
   Frontend detects Status type when: join_table = ''statuses'' AND join_schema = ''metadata''
   AND status_entity_type IS NOT NULL. Updated in v0.15.0 to add status_entity_type.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 7. REMOVE ENTITY REGISTRATIONS
-- ============================================================================

-- Delete permission_roles by looking up permission IDs through permissions table
DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT id FROM metadata.permissions
  WHERE table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances')
);

-- Delete permissions for the recurring timeslot tables
DELETE FROM metadata.permissions
WHERE table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances');

-- Delete entity registrations
DELETE FROM metadata.entities
WHERE table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances');


-- ============================================================================
-- 8. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
