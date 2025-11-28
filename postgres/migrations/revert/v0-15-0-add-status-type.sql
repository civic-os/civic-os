-- Revert civic_os:v0-15-0-add-status-type from pg

BEGIN;

-- ============================================================================
-- 9. RESTORE schema_cache_versions VIEW (remove statuses cache entry)
-- ============================================================================

DROP VIEW IF EXISTS public.schema_cache_versions;

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

COMMENT ON VIEW public.schema_cache_versions IS
  'Cache versioning for frontend schema data. Returns max(updated_at) timestamp for each cache bucket. Frontend checks these timestamps to detect stale caches and trigger refresh.';

GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;


-- ============================================================================
-- 8. DROP PUBLIC VIEW
-- ============================================================================

DROP VIEW IF EXISTS public.statuses;


-- ============================================================================
-- 7. DROP VALIDATION TRIGGER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.validate_status_entity_type();


-- ============================================================================
-- 6. RESTORE schema_properties VIEW (remove status_entity_type column)
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_properties AS
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
  -- Smart defaults: system fields hidden by default, but can be overridden via metadata
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
  -- Extract geography/geometry subtype (e.g., 'Point' from 'geography(Point,4326)')
  CASE
    WHEN columns.udt_name::text IN ('geography', 'geometry') THEN
      SUBSTRING(
        pg_type_info.formatted_type
        FROM '\(([A-Za-z]+)'
      )
    ELSE NULL
  END AS geography_type,
  -- Validation rules as JSONB array
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
    src_schema,
    src_table,
    src_column,
    constraint_schema,
    constraint_name,
    join_schema,
    join_table,
    join_column
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


-- ============================================================================
-- 5. DROP status_entity_type FROM metadata.properties
-- ============================================================================

ALTER TABLE metadata.properties
  DROP COLUMN IF EXISTS status_entity_type;


-- ============================================================================
-- 4. DROP HELPER FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_status_entity_types();
DROP FUNCTION IF EXISTS public.get_statuses_for_entity(TEXT);
DROP FUNCTION IF EXISTS public.get_initial_status(TEXT);


-- ============================================================================
-- 3. (RLS policies dropped automatically with tables)
-- ============================================================================


-- ============================================================================
-- 2. DROP STATUSES TABLE (cascade drops trigger)
-- ============================================================================

DROP TABLE IF EXISTS metadata.statuses CASCADE;


-- ============================================================================
-- 1. DROP STATUS_TYPES TABLE
-- ============================================================================

DROP TABLE IF EXISTS metadata.status_types CASCADE;


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
