-- Revert civic-os:v0-13-0-add-payment-metadata from pg

BEGIN;

-- Drop payment metadata columns from metadata.entities
ALTER TABLE metadata.entities
  DROP COLUMN IF EXISTS payment_initiation_rpc,
  DROP COLUMN IF EXISTS payment_capture_mode;

-- Restore previous schema_cache_versions view
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

-- Restore grants
GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;

-- Restore schema_entities view to pre-v0.13.0 state (without payment columns)
CREATE OR REPLACE VIEW public.schema_entities AS
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

COMMENT ON VIEW public.schema_entities IS
  'Exposes entity metadata including calendar view configuration. Updated in v0.9.0 to add show_calendar, calendar_property_name, and calendar_color_property columns.';

COMMIT;
