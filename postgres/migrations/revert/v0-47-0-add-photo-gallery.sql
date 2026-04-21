-- Revert civic_os:v0-47-0-add-photo-gallery from pg

BEGIN;

-- ============================================================================
-- 1. DROP PUBLIC VIEWS (depend on base tables)
-- ============================================================================

-- Computed function depends on VIEW type, drop first
DROP FUNCTION IF EXISTS gallery_image_count(photo_galleries);

DROP VIEW IF EXISTS public.gallery_admin;
DROP VIEW IF EXISTS public.photo_gallery_config;
DROP VIEW IF EXISTS public.photo_gallery_files;
DROP VIEW IF EXISTS public.photo_galleries;

-- ============================================================================
-- 2. DROP RPCs
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_draft_gallery(NAME, NAME);
DROP FUNCTION IF EXISTS public.link_gallery_to_entity(UUID, NAME, TEXT, NAME);
DROP FUNCTION IF EXISTS public.add_gallery_image(NAME, TEXT, NAME, UUID, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.add_gallery_image_by_id(UUID, UUID, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.remove_gallery_image(UUID, UUID);
DROP FUNCTION IF EXISTS public.reorder_gallery_images(UUID, UUID[]);
DROP FUNCTION IF EXISTS public.update_gallery_image_meta(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_gallery_storage_stats();
DROP FUNCTION IF EXISTS metadata.cleanup_draft_galleries();

-- ============================================================================
-- 3. DROP TRIGGER + TRIGGER FUNCTION
-- ============================================================================

DROP TRIGGER IF EXISTS trg_touch_gallery_updated_at ON metadata.photo_gallery_files;
DROP FUNCTION IF EXISTS metadata.touch_gallery_updated_at();

-- ============================================================================
-- 4. DROP TABLES (reverse order: junction first, then config, then parent)
-- ============================================================================

DROP TABLE IF EXISTS metadata.photo_gallery_files;
DROP TABLE IF EXISTS metadata.photo_gallery_config;
DROP TABLE IF EXISTS metadata.photo_galleries;

-- ============================================================================
-- 5. RESTORE schema_entities VIEW (v0.31.0 version, without photo gallery exclusions)
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
    (tables.table_type::text = 'VIEW'::text) AS is_view
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN ('time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users')
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with Virtual Entities support.
     Tables are auto-discovered; VIEWs require explicit metadata.entities entry.
     System views (schema_*, time_slot_*, civic_os_users, managed_users) are excluded.
     Updated in v0.31.0.';

-- ============================================================================
-- 6. NOTIFY PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
