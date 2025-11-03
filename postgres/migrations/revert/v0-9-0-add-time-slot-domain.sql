-- Revert civic_os:v0-9-0-add-time-slot-domain from pg

BEGIN;

-- Restore original upsert_entity_metadata function (remove calendar parameters)
REVOKE ALL ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT) FROM authenticated;
DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT);

-- Recreate original function signature (7 parameters)
CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the entity metadata
  INSERT INTO metadata.entities (table_name, display_name, description, sort_order, search_fields, show_map, map_property_name)
  VALUES (p_table_name, p_display_name, p_description, p_sort_order, p_search_fields, p_show_map, p_map_property_name)
  ON CONFLICT (table_name) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        sort_order = EXCLUDED.sort_order,
        search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
        show_map = EXCLUDED.show_map,
        map_property_name = EXCLUDED.map_property_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT) TO authenticated;

-- Restore original schema_entities view (remove calendar columns from end)
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
  public.has_permission(tables.table_name::text, 'delete') AS delete
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

-- Drop calendar metadata
ALTER TABLE metadata.entities
  DROP CONSTRAINT IF EXISTS calendar_or_map_not_both;

ALTER TABLE metadata.entities
  DROP COLUMN IF EXISTS calendar_color_property,
  DROP COLUMN IF EXISTS calendar_property_name,
  DROP COLUMN IF EXISTS show_calendar;

-- Drop time_slot domain
DROP DOMAIN IF EXISTS time_slot CASCADE;

-- Drop btree_gist extension
DROP EXTENSION IF EXISTS btree_gist;

COMMIT;
