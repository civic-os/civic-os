-- Deploy civic_os:v0-53-0-options-filter-column to pg
-- Adds options_filter_column to metadata.properties for server-side computed column filtering.
-- When set with fk_search_modal=true, the FK search modal appends ?{column}=is.true
-- instead of fetching all IDs via options_source_rpc (which fails on large result sets).

BEGIN;

-- ============================================================================
-- 1. ADD COLUMN to metadata.properties
-- ============================================================================

ALTER TABLE metadata.properties ADD COLUMN options_filter_column TEXT;

COMMENT ON COLUMN metadata.properties.options_filter_column IS
    'Name of a PostgREST computed boolean column function (e.g. is_eligible). '
    'When set with fk_search_modal=true, the FK search modal appends '
    '?{column}=is.true as a server-side filter instead of fetching all IDs via options_source_rpc.';


-- ============================================================================
-- 2. UPDATE schema_properties VIEW to include the new column
-- ============================================================================

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
  COALESCE(table_relations.join_schema, view_relations.join_schema) AS join_schema,
  COALESCE(
    properties.join_table,
    view_relations.join_table,
    table_relations.join_table
  ) AS join_table,
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
  COALESCE(
    direct_validations.validation_rules,
    inherited_validations.validation_rules,
    '[]'::jsonb
  ) AS validation_rules,
  properties.status_entity_type,
  COALESCE(properties.is_recurring, false) AS is_recurring,
  -- v0.34.0: Category system configuration
  properties.category_entity_type,
  -- v0.44.0: Options source RPC configuration
  properties.options_source_rpc,
  properties.depends_on_columns,
  -- v0.45.0: FK search modal flag
  COALESCE(properties.fk_search_modal, false) AS fk_search_modal,
  -- v0.46.0: Inline M:M positioning
  COALESCE(properties.show_inline, false) AS show_inline,
  -- v0.53.0: Computed column filter for FK search modal
  properties.options_filter_column
FROM information_schema.columns
-- Table FK detection (existing pattern)
LEFT JOIN (SELECT * FROM schema_relations_func()) table_relations
  ON columns.table_schema::name = table_relations.src_schema
  AND columns.table_name::name = table_relations.src_table
  AND columns.column_name::name = table_relations.src_column
-- VIEW FK inheritance (v0.28.0)
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
-- Direct validation rules
LEFT JOIN (
  SELECT table_name, column_name,
         jsonb_agg(jsonb_build_object('type', validation_type, 'value', validation_value, 'message', error_message) ORDER BY sort_order) AS validation_rules
  FROM metadata.validations GROUP BY table_name, column_name
) direct_validations
  ON direct_validations.table_name = columns.table_name::name
  AND direct_validations.column_name = columns.column_name::name
-- Inherited validation rules from base table (for VIEWs, v0.28.0)
LEFT JOIN (SELECT * FROM schema_view_validations_func()) inherited_validations
  ON columns.table_name::name = inherited_validations.view_name
  AND columns.column_name::name = inherited_validations.view_column
WHERE columns.table_schema::name = 'public'
  AND columns.table_name::name IN (SELECT table_name FROM schema_entities);

COMMENT ON VIEW public.schema_properties IS
    'Property metadata view with FK COALESCE, validation inheritance, category system,
     options_source_rpc, fk_search_modal, show_inline, and options_filter_column support.
     Updated in v0.53.0 to add options_filter_column for server-side computed column filtering.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- ============================================================================
-- 3. UPDATE schema_m2m_properties VIEW to include the new column
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_m2m_properties AS
SELECT
  p.table_name,
  p.column_name,
  p.options_source_rpc,
  p.depends_on_columns,
  COALESCE(p.fk_search_modal, false) AS fk_search_modal,
  COALESCE(p.show_inline, false) AS show_inline,
  p.display_name,
  p.sort_order,
  p.column_width,
  p.show_on_list,
  p.show_on_create,
  p.show_on_edit,
  p.show_on_detail,
  -- v0.53.0: Computed column filter for FK search modal
  p.options_filter_column
FROM metadata.properties p
WHERE p.column_name LIKE '%\_m2m';

COMMENT ON VIEW public.schema_m2m_properties IS
    'Metadata for synthetic M:M columns. Bridges metadata.properties flags '
    '(options_source_rpc, fk_search_modal, show_inline, options_filter_column) to virtual M:M columns '
    'that don''t exist in information_schema.columns. Updated in v0.53.0.';

GRANT SELECT ON public.schema_m2m_properties TO web_anon, authenticated;


-- ============================================================================
-- 4. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
