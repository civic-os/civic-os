-- Deploy civic_os:v0-45-0-fk-search-modal to pg
-- requires: v0-44-0-options-source-rpc

BEGIN;

-- ============================================================================
-- FK SEARCH MODAL (v0.45.0)
-- ============================================================================
-- Purpose: Allow FK fields and M:M editors to render as a searchable modal
--          instead of a native <select> dropdown. Useful when the related
--          table has 50+ options and search/filter/pagination is needed.
--
-- Configuration:
--   fk_search_modal  — Boolean flag on metadata.properties. When true, the
--                      frontend renders a search button that opens a modal
--                      with a mini list view (search, sort, filter, paginate)
--                      instead of a <select> dropdown.
--
-- Compatibility:
--   Works alongside options_source_rpc (v0.44.0). When both are set, the
--   RPC filters the available options and the modal provides rich UI with
--   client-side search within the filtered set.
-- ============================================================================

-- 1. ADD COLUMN TO metadata.properties
ALTER TABLE metadata.properties ADD COLUMN fk_search_modal BOOLEAN DEFAULT FALSE;

-- Prevent misconfiguration: search modal only makes sense for FK or M:M fields.
-- FK fields have join_table set in metadata.properties (manual override);
-- M:M fields use the synthetic {junction}_m2m column name convention.
-- Auto-detected FKs (no metadata.properties row) won't have join_table here,
-- so the integrator must create a properties row with join_table to use search modal.
ALTER TABLE metadata.properties ADD CONSTRAINT fk_search_modal_requires_fk
  CHECK (fk_search_modal = false OR join_table IS NOT NULL OR column_name LIKE '%\_m2m');

COMMENT ON COLUMN metadata.properties.fk_search_modal IS
  'When true, FK fields render as a searchable modal instead of a <select> dropdown. '
  'Requires join_table to be set (or column_name ending in _m2m for M:M fields). '
  'Added in v0.45.0.';


-- 2. RECREATE schema_properties VIEW with new column
-- Use CREATE OR REPLACE (not DROP+CREATE) because dependent objects reference
-- this VIEW. Adding columns to a SELECT list is safe with CREATE OR REPLACE.
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
  COALESCE(properties.fk_search_modal, false) AS fk_search_modal
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
    'Property metadata view with FK COALESCE, validation inheritance, category system, options_source_rpc, and fk_search_modal support.
     Updated in v0.45.0 to add fk_search_modal flag for searchable FK modal rendering.';

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;


-- 3. NOTIFY PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
