-- Revert civic_os:v0-16-0-add-entity-notes from pg

BEGIN;

-- ============================================================================
-- 11. DROP PUBLIC VIEW
-- ============================================================================

DROP VIEW IF EXISTS public.entity_notes;


-- ============================================================================
-- 10. RESTORE schema_entities VIEW (remove enable_notes column)
-- ============================================================================

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
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
    AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Exposes entity metadata including payment configuration. Updated in v0.13.0 to add payment_initiation_rpc and payment_capture_mode columns.';


-- ============================================================================
-- 9. DROP STATUS CHANGE NOTE TRIGGER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.add_status_change_note();


-- ============================================================================
-- 8. RESTORE upsert_entity_metadata RPC (remove enable_notes parameter)
-- ============================================================================

-- Drop new function signature (11 parameters from v0.16.0)
DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN);

-- Restore old function signature (10 parameters from v0.9.0)
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
  p_calendar_color_property TEXT DEFAULT NULL
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
    calendar_color_property
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
    p_calendar_color_property
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
    calendar_color_property = EXCLUDED.calendar_color_property;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. v0.9.0 signature with calendar support.';

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT) TO authenticated;


-- ============================================================================
-- 7.5 DROP NOTES ENABLED TRIGGER
-- ============================================================================

DROP TRIGGER IF EXISTS entity_notes_enabled_trigger ON metadata.entities;
DROP FUNCTION IF EXISTS metadata.on_entity_notes_enabled();


-- ============================================================================
-- 7. DROP HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.enable_entity_notes(NAME);


-- ============================================================================
-- 6. DROP CREATE_ENTITY_NOTE RPC
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_entity_note(NAME, TEXT, TEXT, VARCHAR, BOOLEAN, UUID);


-- ============================================================================
-- 5. (Grants revoked automatically with table drop)
-- ============================================================================


-- ============================================================================
-- 4. (RLS policies dropped automatically with table drop)
-- ============================================================================


-- ============================================================================
-- 3. DROP enable_notes FROM metadata.entities
-- ============================================================================

ALTER TABLE metadata.entities
    DROP COLUMN IF EXISTS enable_notes;


-- ============================================================================
-- 2. (Indexes dropped automatically with table drop)
-- ============================================================================


-- ============================================================================
-- 1. DROP ENTITY_NOTES TABLE
-- ============================================================================

DROP TABLE IF EXISTS metadata.entity_notes CASCADE;


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
