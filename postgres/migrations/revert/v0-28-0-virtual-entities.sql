-- Revert civic_os:v0-28-0-virtual-entities from pg

BEGIN;

-- ============================================================================
-- REVERT ORDER IS IMPORTANT:
-- 1. Drop schema_properties (depends on schema_entities via subquery)
-- 2. Drop schema_entities
-- 3. Recreate schema_entities (no is_view column)
-- 4. Recreate schema_properties (no VIEW FK/validation inheritance)
-- 5. Restore upsert_property_metadata (old signature)
-- 6. Drop schema_view_relations_func
-- 7. Drop schema_view_validations_func
-- 8. Drop FK override columns from metadata.properties
-- ============================================================================


-- ============================================================================
-- 1. DROP VIEWS IN CORRECT ORDER
-- ============================================================================
-- schema_properties depends on schema_entities via subquery, so drop it first

DROP VIEW IF EXISTS public.schema_properties;
DROP VIEW IF EXISTS public.schema_entities;


-- ============================================================================
-- 2. RESTORE schema_entities VIEW (BASE TABLE only, no is_view column)
-- ============================================================================

CREATE VIEW public.schema_entities AS
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
    entities.recurring_property_name
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with recurring configuration. Updated in v0.19.0.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;


-- ============================================================================
-- 3. RESTORE schema_properties VIEW (no VIEW FK inheritance)
-- ============================================================================

CREATE VIEW public.schema_properties AS
SELECT columns.table_catalog,
    columns.table_schema,
    columns.table_name,
    columns.column_name,
    COALESCE(properties.display_name, initcap(replace(columns.column_name::text, '_'::text, ' '::text))) AS display_name,
    properties.description,
    COALESCE(properties.sort_order, columns.ordinal_position::integer) AS sort_order,
    properties.column_width,
    COALESCE(properties.sortable, true) AS sortable,
    COALESCE(properties.filterable, false) AS filterable,
    COALESCE(properties.show_on_list,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text, 'created_at'::text, 'updated_at'::text]) THEN false
            ELSE true
        END) AS show_on_list,
    COALESCE(properties.show_on_create,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text, 'created_at'::text, 'updated_at'::text]) THEN false
            ELSE true
        END) AS show_on_create,
    COALESCE(properties.show_on_edit,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text, 'created_at'::text, 'updated_at'::text]) THEN false
            ELSE true
        END) AS show_on_edit,
    COALESCE(properties.show_on_detail,
        CASE
            WHEN columns.column_name::text = ANY (ARRAY['id'::text, 'civic_os_text_search'::text]) THEN false
            WHEN columns.column_name::text = ANY (ARRAY['created_at'::text, 'updated_at'::text]) THEN true
            ELSE true
        END) AS show_on_detail,
    columns.column_default,
    columns.is_nullable::text = 'YES'::text AS is_nullable,
    columns.data_type,
    columns.character_maximum_length,
    columns.udt_schema,
    COALESCE(pg_type_info.domain_name, columns.udt_name::name) AS udt_name,
    columns.is_self_referencing::text = 'YES'::text AS is_self_referencing,
    columns.is_identity::text = 'YES'::text AS is_identity,
    columns.is_generated::text = 'ALWAYS'::text AS is_generated,
    columns.is_updatable::text = 'YES'::text AS is_updatable,
    relations.join_schema,
    relations.join_table,
    relations.join_column,
    CASE
        WHEN columns.udt_name::text = ANY (ARRAY['geography'::text, 'geometry'::text]) THEN substring(pg_type_info.formatted_type, '\(([A-Za-z]+)'::text)
        ELSE NULL::text
    END AS geography_type,
    COALESCE(validation_rules_agg.validation_rules, '[]'::jsonb) AS validation_rules,
    properties.status_entity_type,
    COALESCE(properties.is_recurring, false) AS is_recurring
FROM information_schema.columns
LEFT JOIN ( SELECT schema_relations_func.src_schema,
        schema_relations_func.src_table,
        schema_relations_func.src_column,
        schema_relations_func.constraint_schema,
        schema_relations_func.constraint_name,
        schema_relations_func.join_schema,
        schema_relations_func.join_table,
        schema_relations_func.join_column
       FROM schema_relations_func() schema_relations_func(src_schema, src_table, src_column, constraint_schema, constraint_name, join_schema, join_table, join_column)) relations ON columns.table_schema::name = relations.src_schema AND columns.table_name::name = relations.src_table AND columns.column_name::name = relations.src_column
LEFT JOIN metadata.properties ON properties.table_name = columns.table_name::name AND properties.column_name = columns.column_name::name
LEFT JOIN ( SELECT c.relname AS table_name,
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS formatted_type,
        CASE
            WHEN t.typtype = 'd'::"char" THEN t.typname
            ELSE NULL::name
        END AS domain_name
       FROM pg_attribute a
         JOIN pg_class c ON a.attrelid = c.oid
         JOIN pg_namespace n ON c.relnamespace = n.oid
         LEFT JOIN pg_type t ON a.atttypid = t.oid
      WHERE n.nspname = 'public'::name AND a.attnum > 0 AND NOT a.attisdropped) pg_type_info ON pg_type_info.table_name = columns.table_name::name AND pg_type_info.column_name = columns.column_name::name
LEFT JOIN ( SELECT validations.table_name,
        validations.column_name,
        jsonb_agg(jsonb_build_object('type', validations.validation_type, 'value', validations.validation_value, 'message', validations.error_message) ORDER BY validations.sort_order) AS validation_rules
       FROM metadata.validations
      GROUP BY validations.table_name, validations.column_name) validation_rules_agg ON validation_rules_agg.table_name = columns.table_name::name AND validation_rules_agg.column_name = columns.column_name::name
WHERE columns.table_schema::name = 'public'::name AND (columns.table_name::name IN ( SELECT schema_entities.table_name FROM schema_entities));

COMMENT ON VIEW public.schema_properties IS
    'Property metadata view with is_recurring column. Updated in v0.19.0.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 4. RESTORE upsert_property_metadata RPC (without FK override params)
-- ============================================================================

DROP FUNCTION IF EXISTS public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NAME, NAME);

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
  p_is_recurring BOOLEAN DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

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
    is_recurring
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
    COALESCE(p_is_recurring, FALSE)
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
    is_recurring = COALESCE(EXCLUDED.is_recurring, metadata.properties.is_recurring);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) IS
    'Upsert property metadata including is_recurring flag. Updated in v0.19.0.';

GRANT EXECUTE ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated;


-- ============================================================================
-- 5. DROP VIEW FK INHERITANCE FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.schema_view_relations_func();


-- ============================================================================
-- 6. DROP VIEW VALIDATION INHERITANCE FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.schema_view_validations_func();


-- ============================================================================
-- 7. DROP FK OVERRIDE COLUMNS FROM metadata.properties
-- ============================================================================

ALTER TABLE metadata.properties
  DROP COLUMN IF EXISTS join_table,
  DROP COLUMN IF EXISTS join_column;


COMMIT;
