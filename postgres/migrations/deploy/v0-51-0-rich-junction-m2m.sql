-- Deploy civic_os:v0-51-0-rich-junction-m2m to pg
-- requires: v0-50-2-fix-notification-preferences-rls

BEGIN;

-- ============================================================================
-- Rich Junction M:M Support
-- ============================================================================
-- Adds opt-in flag for junction tables with extra editable columns.
--
-- Standard M:M junctions (exactly 2 FKs, no extra columns) are auto-detected
-- by the frontend SchemaService. Tables with additional columns (e.g., quantity,
-- grade, notes) are normally rejected by this heuristic.
--
-- Setting is_rich_junction = TRUE tells the frontend to treat the table as a
-- junction despite having extra columns. The extra columns become editable
-- fields in the M:M search modal (two-page flow: select items → configure extras).
--
-- Why opt-in (not auto-detect): Relaxing the heuristic to "2 FKs + any extras"
-- would false-positive on tables like appointments(patient_id, doctor_id, notes).

ALTER TABLE metadata.entities
  ADD COLUMN is_rich_junction BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN metadata.entities.is_rich_junction IS
  'When TRUE, this junction table is treated as M:M with editable extra columns (v0.51.0)';

-- ============================================================================
-- Update schema_entities VIEW
-- ============================================================================
-- Expose is_rich_junction so the frontend SchemaService can read it.

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
    (tables.table_type::text = 'VIEW'::text) AS is_view,
    entities.guided_form_key,
    COALESCE(entities.show_in_sidebar, true) AS show_in_sidebar,
    entities.map_color_property,
    COALESCE(entities.is_rich_junction, false) AS is_rich_junction
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view. Exposes show_in_sidebar and is_rich_junction for frontend. '
    'Updated in v0.51.0 to add rich junction M:M support.';

NOTIFY pgrst, 'reload schema';

COMMIT;
