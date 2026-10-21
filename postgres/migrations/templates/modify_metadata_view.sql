-- Template: Modify Metadata View
-- This template shows the pattern for updating core metadata views
-- (schema_entities, schema_properties, etc.)
--
-- Usage: Copy this template and customize for your view modification
-- Example: cp templates/modify_metadata_view.sql deploy/v0-4-0-update_schema_properties_view.sql

-- Deploy civic_os:vX-Y-Z-modify_your_view to pg
-- requires: previous_migration_name

BEGIN;

-- 1. Drop the existing view
DROP VIEW IF EXISTS public.your_view_name CASCADE;

-- 2. Recreate the view with modifications
-- IMPORTANT: keep WITH (security_invoker = true) on every view over an RLS-protected table.
-- CREATE OR REPLACE VIEW resets view options, so omitting it silently drops RLS enforcement.
CREATE OR REPLACE VIEW public.your_view_name
WITH (security_invoker = true) AS
SELECT
  -- Add/modify/remove columns here
  t.column1,
  t.column2,
  -- New computed column
  CASE
    WHEN t.column3 IS NOT NULL THEN 'value1'
    ELSE 'value2'
  END AS new_column
FROM metadata.source_table t
WHERE t.some_condition = true
ORDER BY t.sort_order;

-- 3. Add comment explaining the view
COMMENT ON VIEW public.your_view_name IS
'Description of what this view provides and how it is used';

-- 4. Grant permissions
GRANT SELECT ON public.your_view_name TO authenticated;
GRANT SELECT ON public.your_view_name TO web_anon;

-- Examples for core Civic OS views:

-- PATTERN 1: Modify schema_entities view
--
-- DROP VIEW IF EXISTS public.schema_entities CASCADE;
--
-- CREATE OR REPLACE VIEW public.schema_entities AS
-- SELECT
--   e.id,
--   e.table_name,
--   e.display_name,
--   e.description,
--   e.icon,
--   e.sort_order,
--   e.is_visible,
--   -- NEW: Add search fields configuration
--   e.search_fields,
--   -- NEW: Add pagination default
--   COALESCE(e.default_page_size, 25) AS default_page_size
-- FROM metadata.entities e
-- WHERE e.is_visible = true
-- ORDER BY e.sort_order, e.display_name;

-- PATTERN 2: Modify schema_properties view
--
-- DROP VIEW IF EXISTS public.schema_properties CASCADE;
--
-- CREATE OR REPLACE VIEW public.schema_properties AS
-- SELECT
--   p.id,
--   p.table_name,
--   p.column_name,
--   p.display_name,
--   p.description,
--   p.data_type,
--   p.is_nullable,
--   p.join_table,
--   p.join_column,
--   p.display_column,
--   p.sort_order,
--   p.show_in_list,
--   p.show_in_detail,
--   p.show_in_create,
--   p.show_in_edit,
--   p.column_width,
--   p.sortable,
--   -- NEW: Add validation rules as JSONB array
--   (
--     SELECT jsonb_agg(
--       jsonb_build_object(
--         'type', v.validation_type,
--         'value', v.validation_value,
--         'message', v.error_message
--       )
--       ORDER BY v.sort_order
--     )
--     FROM metadata.validations v
--     WHERE v.table_name = p.table_name
--       AND v.column_name = p.column_name
--   ) AS validations
-- FROM metadata.properties p
-- ORDER BY p.table_name, p.sort_order;

-- PATTERN 3: Create new aggregation view
--
-- CREATE OR REPLACE VIEW public.entity_statistics AS
-- SELECT
--   e.table_name,
--   e.display_name,
--   COUNT(p.id) AS property_count,
--   COUNT(v.id) AS validation_count,
--   SUM(CASE WHEN p.show_in_list THEN 1 ELSE 0 END) AS list_column_count
-- FROM metadata.entities e
-- LEFT JOIN metadata.properties p ON e.table_name = p.table_name
-- LEFT JOIN metadata.validations v ON e.table_name = v.table_name
-- GROUP BY e.table_name, e.display_name;

-- Important notes for view modifications:
-- - Use CASCADE when dropping views if other views depend on them
-- - Test views thoroughly - SchemaService depends on specific column names/types
-- - Frontend code may break if view structure changes significantly
-- - Consider adding columns rather than renaming to maintain compatibility
-- - Update TypeScript interfaces if view structure changes (src/app/models/)

COMMIT;
