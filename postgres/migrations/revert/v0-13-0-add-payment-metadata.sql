-- Revert civic-os:v0-13-0-add-payment-metadata from pg

BEGIN;

-- ============================================================================
-- 1. DROP VIEWS FIRST (must drop before altering columns they depend on)
-- ============================================================================
-- schema_properties depends on schema_entities, so drop it first
DROP VIEW IF EXISTS public.schema_properties;
DROP VIEW IF EXISTS public.schema_entities;

-- ============================================================================
-- 2. DROP PAYMENT METADATA COLUMNS
-- ============================================================================
ALTER TABLE metadata.entities
  DROP COLUMN IF EXISTS payment_initiation_rpc,
  DROP COLUMN IF EXISTS payment_capture_mode;

-- ============================================================================
-- 3. RESTORE schema_cache_versions VIEW
-- ============================================================================
DROP VIEW IF EXISTS public.schema_cache_versions CASCADE;

CREATE VIEW public.schema_cache_versions AS
SELECT
  'entities' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
  ) as last_updated
UNION ALL
SELECT
  'constraint_messages' as cache_name,
  (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) as last_updated;

GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;

-- ============================================================================
-- 4. RESTORE schema_entities VIEW (pre-v0.13.0 state, without payment columns)
-- ============================================================================
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
  entities.calendar_color_property
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

ALTER VIEW public.schema_entities SET (security_invoker = true);

COMMENT ON VIEW public.schema_entities IS
  'Exposes entity metadata including calendar view configuration. Updated in v0.9.0 to add show_calendar, calendar_property_name, and calendar_color_property columns.';

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;

-- ============================================================================
-- 5. RESTORE schema_properties VIEW (v0.12.0 version - after calendar but before payments)
-- ============================================================================
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
  ) AS validation_rules
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
  'Exposes property metadata with validation rules. Pre-v0.13.0 version.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
