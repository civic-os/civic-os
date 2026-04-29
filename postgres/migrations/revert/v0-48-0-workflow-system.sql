-- Revert civic_os:v0-48-0-workflow-system from pg

BEGIN;

-- ============================================================================
-- 1. DROP RPCs (public schema)
-- ============================================================================

DROP FUNCTION IF EXISTS public.grant_guided_form_permissions(NAME, INTEGER, TEXT[]);
DROP FUNCTION IF EXISTS public.rebuild_guided_form_triggers();
DROP FUNCTION IF EXISTS public.get_guided_form_progress(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.cancel_guided_form(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.submit_guided_form(NAME, BIGINT);
DROP FUNCTION IF EXISTS public._check_guided_form_complete(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.complete_guided_form_step(NAME, BIGINT, NAME);
DROP FUNCTION IF EXISTS public.start_guided_form(NAME);
DROP FUNCTION IF EXISTS public.add_guided_form_step_condition(NAME, NAME, TEXT, NAME, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._all_steps_condition_skipped(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.ensure_guided_form_step_record(NAME, BIGINT, NAME);
DROP FUNCTION IF EXISTS public.get_guided_form_context(NAME, NAME, BIGINT);
DROP FUNCTION IF EXISTS public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME);


-- ============================================================================
-- 2. DROP TRIGGER FUNCTIONS (metadata schema)
-- ============================================================================

DROP TRIGGER IF EXISTS validation_change_rebuild_insert ON metadata.validations;
DROP TRIGGER IF EXISTS validation_change_rebuild_update ON metadata.validations;
DROP TRIGGER IF EXISTS validation_change_rebuild_delete ON metadata.validations;
DROP FUNCTION IF EXISTS metadata.on_validation_change_rebuild_insert();
DROP FUNCTION IF EXISTS metadata.on_validation_change_rebuild_update();
DROP FUNCTION IF EXISTS metadata.on_validation_change_rebuild_delete();

DROP FUNCTION IF EXISTS metadata.block_submitted_update();
DROP FUNCTION IF EXISTS metadata.enforce_guided_form_lock();

DROP FUNCTION IF EXISTS metadata.rebuild_guided_form_constraints(NAME);


-- ============================================================================
-- 3. DROP PUBLIC VIEWS
-- ============================================================================

DROP VIEW IF EXISTS public.guided_form_progress;
DROP VIEW IF EXISTS public.schema_guided_form_steps;
DROP VIEW IF EXISTS public.schema_guided_forms;


-- ============================================================================
-- 4. RESTORE schema_entities VIEW (without guided form columns)
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
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;


-- ============================================================================
-- 4b. RESTORE upsert_entity_metadata to pre-v0.48.0 signature (without show_in_sidebar)
-- ============================================================================

DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN);

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
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE,
  p_supports_recurring BOOLEAN DEFAULT FALSE,
  p_recurring_property_name TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  INSERT INTO metadata.entities (
    table_name, display_name, description, sort_order,
    search_fields, show_map, map_property_name,
    show_calendar, calendar_property_name, calendar_color_property,
    enable_notes, supports_recurring, recurring_property_name
  )
  VALUES (
    p_table_name, p_display_name, p_description, p_sort_order,
    p_search_fields, p_show_map, p_map_property_name,
    p_show_calendar, p_calendar_property_name, p_calendar_color_property,
    p_enable_notes, p_supports_recurring, p_recurring_property_name
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes,
    supports_recurring = EXCLUDED.supports_recurring,
    recurring_property_name = EXCLUDED.recurring_property_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) TO authenticated;


-- ============================================================================
-- 5. DELETE seeded status data and DROP metadata tables
-- ============================================================================

DELETE FROM metadata.statuses WHERE entity_type = 'guided_form';
DELETE FROM metadata.status_types WHERE entity_type = 'guided_form';

DROP TABLE IF EXISTS metadata.guided_form_step_conditions;
DROP TABLE IF EXISTS metadata.guided_form_steps;
DROP TABLE IF EXISTS metadata.guided_form_progress;
DROP TABLE IF EXISTS metadata.guided_forms;


-- ============================================================================
-- 6. DROP HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.is_guided_form_draft(INTEGER);

-- ============================================================================
-- 6b. RESTORE get_statuses_for_entity without status_key
-- ============================================================================
-- Must DROP first because return type is changing (removing status_key column).
-- CREATE OR REPLACE cannot change return type of an existing function.

DROP FUNCTION IF EXISTS public.get_statuses_for_entity(TEXT);

CREATE OR REPLACE FUNCTION public.get_statuses_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT,
  is_initial BOOLEAN,
  is_terminal BOOLEAN
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name, description, color, sort_order, is_initial, is_terminal
  FROM metadata.statuses
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;


-- ============================================================================
-- 7. REMOVE metadata.entities columns
-- ============================================================================

ALTER TABLE metadata.entities DROP COLUMN IF EXISTS guided_form_key;
ALTER TABLE metadata.entities DROP COLUMN IF EXISTS show_in_sidebar;


NOTIFY pgrst, 'reload schema';

COMMIT;
