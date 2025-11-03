-- Deploy civic_os:v0-9-0-add-time-slot-domain to pg
-- requires: v0-8-2-fix-schema-relations-cross-schema-bug

BEGIN;

-- ============================================================================
-- BTREE_GIST EXTENSION FOR EXCLUSION CONSTRAINTS
-- ============================================================================
-- Purpose: Enable GiST operators for scalar types (integers, UUIDs, text, etc.)
-- Use case: Exclusion constraints mixing scalar and range types
-- Example: EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&)
--          Prevents overlapping time slots for the same resource
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

COMMENT ON EXTENSION btree_gist IS
  'Provides GiST index operator classes for B-tree data types, enabling exclusion constraints that mix scalar types (integer, UUID) with range types (time_slot). Essential for preventing overlapping bookings, reservations, and appointments.';

-- ============================================================================
-- TIME_SLOT DOMAIN FOR CALENDAR/APPOINTMENT SCHEDULING
-- ============================================================================
-- Version: v0.9.0
-- Purpose: Add core time_slot domain (tstzrange) for appointment/booking features
-- Context: This is a CORE Civic OS domain available to all applications, not
--          example-specific. Any application can use this for scheduling.
-- ============================================================================

-- Create time_slot domain as alias for tstzrange
CREATE DOMAIN time_slot AS TSTZRANGE;

COMMENT ON DOMAIN time_slot IS
  'Timestamp range (with timezone) for appointments, bookings, and scheduling.
   Stores UTC timestamps, displays in user timezone.
   Format: [start,end) with inclusive start, exclusive end.
   Example: [2025-03-15T14:00:00Z,2025-03-15T16:00:00Z) represents a 2-hour slot.';

-- ============================================================================
-- CALENDAR METADATA COLUMNS FOR LIST PAGE CALENDAR VIEW
-- ============================================================================
-- Purpose: Add calendar view support to List pages (show_calendar toggle)
-- Pattern: Similar to show_map for geography properties
-- ============================================================================

-- Add calendar view configuration to metadata.entities
ALTER TABLE metadata.entities
  ADD COLUMN show_calendar BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN calendar_property_name VARCHAR(63),
  ADD COLUMN calendar_color_property VARCHAR(63);

COMMENT ON COLUMN metadata.entities.show_calendar IS
  'Enable calendar view toggle on list page (like show_map for geography). Mutually exclusive with show_map.';

COMMENT ON COLUMN metadata.entities.calendar_property_name IS
  'Name of the time_slot column to use for calendar events. Required if show_calendar is TRUE.';

COMMENT ON COLUMN metadata.entities.calendar_color_property IS
  'Optional column name for event color (hex_color type). If null, uses default blue color.';

-- Add CHECK constraint to ensure calendar OR map, not both
ALTER TABLE metadata.entities
  ADD CONSTRAINT calendar_or_map_not_both
  CHECK (NOT (show_calendar = TRUE AND show_map = TRUE));

COMMENT ON CONSTRAINT calendar_or_map_not_both ON metadata.entities IS
  'Ensures an entity has either calendar OR map view enabled, not both. Use Detail page sections for entities needing both time and location views.';

-- ============================================================================
-- UPDATE SCHEMA_ENTITIES VIEW TO EXPOSE CALENDAR COLUMNS
-- ============================================================================
-- Purpose: Add calendar columns to the public API via schema_entities view
-- Note: Columns added at END to avoid changing existing column positions
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
  -- Calendar columns added at end (v0.9.0)
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

-- ============================================================================
-- UPDATE UPSERT_ENTITY_METADATA RPC TO SUPPORT CALENDAR PROPERTIES
-- ============================================================================
-- Purpose: Allow Entity Management page to configure calendar view
-- Pattern: Similar to show_map/map_property_name parameters
-- ============================================================================

-- Drop old function signature (7 parameters)
DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT);

-- Create new function signature (10 parameters)
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
  ON CONFLICT (table_name) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        sort_order = EXCLUDED.sort_order,
        search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
        show_map = EXCLUDED.show_map,
        map_property_name = EXCLUDED.map_property_name,
        show_calendar = EXCLUDED.show_calendar,
        calendar_property_name = EXCLUDED.calendar_property_name,
        calendar_color_property = EXCLUDED.calendar_color_property;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Admin function to configure entity metadata including calendar view settings. Updated in v0.9.0 to support show_calendar, calendar_property_name, and calendar_color_property.';

-- Grant execute on new function signature
GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT) TO authenticated;

COMMIT;
