-- Deploy civic_os:v0-28-1-filter-system-views to pg
-- requires: v0-28-0-virtual-entities

BEGIN;

-- ============================================================================
-- FILTER SYSTEM VIEWS FROM schema_entities
-- ============================================================================
-- Version: v0.28.1
-- Purpose: Exclude framework helper views from the entity list.
--
-- Problem:
--   After enabling VIEWs for Virtual Entities (v0.28.0), some system views
--   like recurring schedule helpers (time_slot_series, time_slot_instances)
--   started appearing in the main menu.
--
-- Solution:
--   Add an explicit exclusion for views with known system prefixes:
--   - schema_*  (framework metadata views)
--   - time_slot_series, time_slot_instances (recurring schedule helpers)
--   - civic_os_* (framework user/profile views)
--
-- Note: The original v0.28.0 logic "VIEWs require metadata.entities entry"
--       should have prevented this, but some instances may have stale metadata
--       entries or the views might be getting matched incorrectly.
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_entities AS
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
    entities.recurring_property_name,
    -- v0.28.0: Column to identify Virtual Entities
    (tables.table_type::text = 'VIEW'::text) AS is_view
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  -- Include VIEWs alongside BASE TABLEs
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  -- HYBRID: Tables are auto-discovered, VIEWs require explicit metadata entry
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  -- v0.28.1: Exclude system/framework views from entity list
  -- These are helper views that shouldn't appear in the UI:
  --   - schema_* : Framework metadata views (schema_entities, schema_properties, etc.)
  --   - time_slot_series/instances : Recurring schedule helper views
  --   - civic_os_users : User profile view (handled specially, not a CRUD entity)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN ('time_slot_series', 'time_slot_instances', 'civic_os_users')
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with Virtual Entities support.
     Tables are auto-discovered; VIEWs require explicit metadata.entities entry.
     VIEWs with INSTEAD OF triggers can behave like tables for CRUD operations.
     System/framework views (schema_*, time_slot_*, civic_os_users) are excluded.
     Updated in v0.28.1.';

COMMIT;
