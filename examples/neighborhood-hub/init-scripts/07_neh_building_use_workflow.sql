-- Neighborhood Engagement Hub - Building Use GuidedForm (v0.48.0 comprehensive dogfood)
-- Exercises EVERY guided_form feature: skip_if, require_if, validations, lock_on_submit,
-- precondition_rpc, on_submit_rpc, depends_on_columns + options_source_rpc.
--
-- GuidedForm: Building Use Request
--   Step 0 (Parent): Group information + contact details + group type (category)
--   Step 1: Event scheduling (time_slot, attendees, setup needs)
--      skip_if: private_event group type skips this step
--   Step 2: Room preferences (room type, AV needs, accessibility)
--      can_skip = TRUE by default
--      require_if: school group type REQUIRES this step
--
-- Features exercised:
--   - Category dropdown (group_type)
--   - Category dropdown with RPC-driven options (room_type depends on group_size_estimate)
--   - skip_if condition (private_event skips event scheduling)
--   - require_if condition (school requires room preferences)
--   - metadata.validations → conditional CHECK constraints
--   - lock_on_submit (submitted guided_forms are locked)
--   - precondition_rpc (blocks start if >= 5 total requests exist)
--   - on_submit_rpc (appends " - Submitted" to display_name)
--   - on_submit_rpc returns navigate_to for post-submit redirect
--   - Auto-save drafts, view/edit toggle, Review & Submit, step navigation

-- ============================================================================
-- CATEGORIES
-- ============================================================================

-- Group types for the parent form
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('building_use_group_type', 'Building Use Group Type')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('building_use_group_type', 'Nonprofit',       'nonprofit',       '#22c55e', 1),
  ('building_use_group_type', 'Community Group', 'community_group', '#3b82f6', 2),
  ('building_use_group_type', 'School',          'school',          '#f59e0b', 3),
  ('building_use_group_type', 'Private Event',   'private_event',   '#ef4444', 4)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- Room types for the room preferences form
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('building_use_room_type', 'Building Use Room Type')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('building_use_room_type', 'Main Hall',       'main_hall',       '#8b5cf6', 1),
  ('building_use_room_type', 'Conference Room', 'conference_room', '#06b6d4', 2),
  ('building_use_room_type', 'Outdoor Patio',   'outdoor_patio',   '#10b981', 3)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.building_use_requests (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    submitted_at TIMESTAMPTZ,
    group_name VARCHAR(200),
    group_type INTEGER REFERENCES metadata.categories(id),
    borrower_id BIGINT REFERENCES public.borrowers(id),
    contact_name VARCHAR(200),
    contact_email email_address,
    contact_phone phone_number,
    mission_description TEXT,
    decision_notes TEXT,
    status_id INT REFERENCES metadata.statuses(id),
    created_by UUID DEFAULT current_user_id(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.building_use_event_details (
    id BIGSERIAL PRIMARY KEY,
    building_use_request_id BIGINT NOT NULL REFERENCES public.building_use_requests(id),
    time_slot time_slot,
    estimated_attendees INTEGER,
    setup_needs TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.building_use_room_preferences (
    id BIGSERIAL PRIMARY KEY,
    building_use_request_id BIGINT NOT NULL REFERENCES public.building_use_requests(id),
    group_size_estimate INTEGER,
    room_type INTEGER REFERENCES metadata.categories(id),
    needs_av_equipment BOOLEAN DEFAULT FALSE,
    accessibility_needs TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- GRANTS
-- ============================================================================

-- Grant to web_anon (read-only public access)
GRANT SELECT ON public.building_use_requests TO web_anon;
GRANT SELECT ON public.building_use_event_details TO web_anon;
GRANT SELECT ON public.building_use_room_preferences TO web_anon;

-- Grant to authenticated (full CRUD)
GRANT ALL ON public.building_use_requests TO authenticated;
GRANT ALL ON public.building_use_event_details TO authenticated;
GRANT ALL ON public.building_use_room_preferences TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_requests_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_event_details_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_room_preferences_id_seq TO authenticated;

-- NOTE: RLS policies and created_by metadata.properties hiding are auto-created by
-- register_guided_form() when ownership_column is set (default: 'created_by').
-- No manual RLS setup needed here.

-- Add FK constraint if table already existed without it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'building_use_requests_group_type_fkey'
      AND table_name = 'building_use_requests'
  ) THEN
    ALTER TABLE public.building_use_requests
      ADD CONSTRAINT building_use_requests_group_type_fkey
      FOREIGN KEY (group_type) REFERENCES metadata.categories(id);
  END IF;
  
  -- Add index on borrower_id if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'building_use_requests' 
    AND indexname = 'building_use_requests_borrower_id_idx'
  ) THEN
    CREATE INDEX building_use_requests_borrower_id_idx ON public.building_use_requests(borrower_id);
  END IF;
END $$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-generate display_name as "Group Name - YYYY-MM-DD"
-- Only on INSERT or when group_name changes - preserves on_submit_rpc modifications.
CREATE OR REPLACE FUNCTION public.building_use_request_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.group_name IS DISTINCT FROM NEW.group_name THEN
        NEW.display_name := COALESCE(NEW.group_name, 'Building Use Request')
            || ' - ' || TO_CHAR(COALESCE(NEW.created_at, NOW()), 'YYYY-MM-DD');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_building_use_display_name
    BEFORE INSERT OR UPDATE ON public.building_use_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.building_use_request_display_name();

-- NOTE: Child step tables (building_use_event_details, building_use_room_preferences)
-- do NOT need display_name columns or triggers. Users never see child display_name -
-- the guided form UI navigates by step, and page headers fall back to '#' + id.

-- ============================================================================
-- RPCs
-- ============================================================================

-- Precondition: block new guided_form if there are already 5+ total requests
-- (tests the precondition_rpc feature - with 5 mock records it will block,
--  delete one record to test the success path)
CREATE OR REPLACE FUNCTION public.check_no_pending_building_use_request(p_guided_form_key NAME)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM public.building_use_requests;
    IF v_count >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Capacity limit reached: maximum of 5 building use requests allowed. Delete an existing request to start a new one.'
        );
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.check_no_pending_building_use_request(NAME) IS
    'Precondition RPC for building_use_request guided_form. Blocks start if >= 5 total requests exist.';

GRANT EXECUTE ON FUNCTION public.check_no_pending_building_use_request(NAME) TO authenticated;

-- On-submit hook: append " - Submitted" to display_name
CREATE OR REPLACE FUNCTION public.notify_building_use_submitted(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_group_type_key TEXT;
BEGIN
    -- Look up the category_key for this request's group_type
    SELECT c.category_key INTO v_group_type_key
    FROM public.building_use_requests r
    JOIN metadata.categories c ON c.id = r.group_type
    WHERE r.id = p_parent_id;

    IF v_group_type_key = 'private_event' THEN
        -- Private events are not eligible for building use
        UPDATE public.building_use_requests
           SET decision_notes = 'Private events do not qualify for building use under NEH community facility policies. '
                             || 'Only mission-aligned nonprofit, community, and school groups are eligible.',
               display_name = CASE
                   WHEN display_name LIKE '% - Ineligible' THEN display_name
                   ELSE COALESCE(display_name, 'Building Use Request') || ' - Ineligible'
               END
         WHERE id = p_parent_id;

        RETURN jsonb_build_object(
            'success', true,
            'message', 'This request has been marked as ineligible for building use.',
            'navigate_to', '/view/building_use_requests/' || p_parent_id
        );
    END IF;

    -- Standard submission: mark as submitted
    UPDATE public.building_use_requests
       SET display_name = CASE
           WHEN display_name LIKE '% - Submitted' THEN display_name
           ELSE COALESCE(display_name, 'Building Use Request') || ' - Submitted'
       END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Submission notification processed',
        'navigate_to', '/view/building_use_requests'
    );
END;
$$;

COMMENT ON FUNCTION public.notify_building_use_submitted(BIGINT) IS
    'On-submit RPC for building_use_request guided_form. Private events get ineligibility decision; others are marked submitted.';

GRANT EXECUTE ON FUNCTION public.notify_building_use_submitted(BIGINT) TO authenticated;

-- RPC-driven room options: filters rooms based on group_size_estimate
CREATE OR REPLACE FUNCTION public.get_room_options_for_building_use(
    p_id BIGINT DEFAULT NULL,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE(id BIGINT, display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_group_size INTEGER;
BEGIN
    v_group_size := (p_depends_on->>'group_size_estimate')::INTEGER;

    IF v_group_size IS NULL OR v_group_size < 50 THEN
        RETURN QUERY
            SELECT c.id::bigint, c.display_name::text
            FROM metadata.categories c
            WHERE c.entity_type = 'building_use_room_type'
            ORDER BY c.sort_order;
    ELSIF v_group_size BETWEEN 50 AND 100 THEN
        RETURN QUERY
            SELECT c.id::bigint, c.display_name::text
            FROM metadata.categories c
            WHERE c.entity_type = 'building_use_room_type'
              AND c.category_key != 'outdoor_patio'
            ORDER BY c.sort_order;
    ELSE
        RETURN QUERY
            SELECT c.id::bigint, c.display_name::text
            FROM metadata.categories c
            WHERE c.entity_type = 'building_use_room_type'
              AND c.category_key = 'main_hall'
            ORDER BY c.sort_order;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.get_room_options_for_building_use(BIGINT, JSONB) IS
    'RPC-driven room options for building_use_room_preferences. Filters by group_size_estimate from p_depends_on.';

GRANT EXECUTE ON FUNCTION public.get_room_options_for_building_use(BIGINT, JSONB) TO authenticated;

-- ============================================================================
-- ENTITY METADATA
-- ============================================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES
  ('building_use_requests',       'Building Use Requests',       'Mission-aligned group requests to use the community building', 8),
  ('building_use_event_details',  'Building Use Event Details',  'Scheduling details for approved building use requests', 9),
  ('building_use_room_preferences', 'Room Preferences',          'Room selection and accessibility requirements', 10)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Hide timestamps, internal fields, and framework-managed columns
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('building_use_requests', 'created_at', false, false, false, false),
  ('building_use_requests', 'updated_at', false, false, false, false),
  ('building_use_requests', 'submitted_at', false, false, false, false),
  ('building_use_requests', 'display_name', true, false, false, false),
  ('building_use_requests', 'decision_notes', false, false, false, true),
  ('building_use_event_details', 'created_at', false, false, false, false),
  ('building_use_event_details', 'updated_at', false, false, false, false),
  ('building_use_event_details', 'building_use_request_id', false, false, false, false),
  ('building_use_room_preferences', 'created_at', false, false, false, false),
  ('building_use_room_preferences', 'updated_at', false, false, false, false),
  ('building_use_room_preferences', 'building_use_request_id', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- Decision notes: full width, first on detail page, system-managed
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width)
VALUES ('building_use_requests', 'decision_notes', 'Decision Notes', -10, 2)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width;

-- Register time_slot with a friendly display name
INSERT INTO metadata.properties (table_name, column_name, display_name)
VALUES ('building_use_event_details', 'time_slot', 'Event Time Slot')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name;

-- Register group_type as Category property
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type, join_table, join_column)
VALUES ('building_use_requests', 'group_type', 'Group Type', 'building_use_group_type', 'categories', 'id')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type,
      join_table = EXCLUDED.join_table,
      join_column = EXCLUDED.join_column;

-- Register room_type as Category property with RPC-driven options
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type, join_table, join_column, options_source_rpc, depends_on_columns)
VALUES ('building_use_room_preferences', 'room_type', 'Room Type', 'building_use_room_type', 'categories', 'id', 'get_room_options_for_building_use', ARRAY['group_size_estimate'])
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type,
      join_table = EXCLUDED.join_table,
      join_column = EXCLUDED.join_column,
      options_source_rpc = EXCLUDED.options_source_rpc,
      depends_on_columns = EXCLUDED.depends_on_columns;

-- ============================================================================
-- GUIDED_FORM REGISTRATION
-- ============================================================================

-- Unregister existing guided_form first to allow parameter changes on re-runs
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'building_use_request';
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key = 'building_use_request'
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key = 'building_use_request';
-- Clear guided_form_key from entities first (FK constraint)
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key = 'building_use_request';
DELETE FROM metadata.guided_forms WHERE guided_form_key = 'building_use_request';

-- Remove stale triggers (will be recreated by register_guided_form)
DROP TRIGGER IF EXISTS trg_block_submitted_update ON public.building_use_requests;
DROP TRIGGER IF EXISTS trg_guided_form_lock ON public.building_use_requests;

DO $$DECLARE v_result JSONB; BEGIN
    v_result := public.register_guided_form(
        'building_use_request'::name,
        'building_use_requests'::name,
        'Mission-aligned groups request to use the community building. Eligibility is gated by group type - private events skip event scheduling, schools require room selection.'::text,
        'notify_building_use_submitted'::name,           -- on_submit_rpc
        'Group Information'::varchar,
        'Please review your request details before submitting. Only mission-aligned groups are eligible for building use.'::text,
        TRUE,                                            -- lock_on_submit
        'check_no_pending_building_use_request'::name    -- precondition_rpc
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END $$;

-- Enable auto-submit: when Private Event skips ALL data steps, submit immediately
-- (the on_submit_rpc handles ineligibility decisions - no review needed)
UPDATE metadata.guided_forms
   SET auto_submit_on_all_skipped = TRUE
 WHERE guided_form_key = 'building_use_request';

-- ============================================================================
-- GUIDED_FORM STEPS
-- ============================================================================

SELECT public.add_guided_form_step(
    'building_use_request'::name,
    'event_details'::name,
    'Event Scheduling'::varchar,
    1,
    'building_use_event_details'::name,
    'building_use_request_id'::name,
    'Select your event date, time, and estimated attendance.'::text,
    FALSE   -- can_skip = FALSE (required unless skipped by condition)
);

SELECT public.add_guided_form_step(
    'building_use_request'::name,
    'room_preferences'::name,
    'Room Preferences'::varchar,
    2,
    'building_use_room_preferences'::name,
    'building_use_request_id'::name,
    'Select your room, AV equipment, and accessibility needs.'::text,
    TRUE    -- can_skip = TRUE (optional unless required by condition)
);

-- ============================================================================
-- GUIDED_FORM CONDITIONS
-- ============================================================================

-- Skip event scheduling for Private Event (looked up by category_key, not hardcoded ID)
DELETE FROM metadata.guided_form_step_conditions
WHERE guided_form_step_id IN (
  SELECT id FROM metadata.guided_form_steps
  WHERE guided_form_key = 'building_use_request' AND step_key = 'event_details'
);

INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT ws.id, 'skip_if', 'group_type', 'eq',
  (SELECT id::text FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'private_event'),
  0
FROM metadata.guided_form_steps ws
WHERE ws.guided_form_key = 'building_use_request' AND ws.step_key = 'event_details';

-- Room preferences conditions:
--   skip_if: Private Event (all steps skipped → ineligible, handled by on_submit_rpc)
--   require_if: School (must complete room preferences)
DELETE FROM metadata.guided_form_step_conditions
WHERE guided_form_step_id IN (
  SELECT id FROM metadata.guided_form_steps
  WHERE guided_form_key = 'building_use_request' AND step_key = 'room_preferences'
);

INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT ws.id, 'skip_if', 'group_type', 'eq',
  (SELECT id::text FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'private_event'),
  0
FROM metadata.guided_form_steps ws
WHERE ws.guided_form_key = 'building_use_request' AND ws.step_key = 'room_preferences';

INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT ws.id, 'require_if', 'group_type', 'eq',
  (SELECT id::text FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'school'),
  1
FROM metadata.guided_form_steps ws
WHERE ws.guided_form_key = 'building_use_request' AND step_key = 'room_preferences';

-- Step tables are auto-hidden from sidebar by add_guided_form_step().
-- No override needed - child steps are accessed through the guided form UI.

-- ============================================================================
-- PERMISSIONS
-- ============================================================================
-- Guided form child tables inherit RBAC from the parent table.
-- register_guided_form() auto-creates parent-table permission entries.
-- We assign them to role 4 (admin in this example; integrators should use
-- their own role structure via the Permissions UI or grant_guided_form_permissions).

-- Admin (role 4): blanket access to all operations
SELECT public.grant_guided_form_permissions('building_use_request', 4, ARRAY['read', 'create', 'update', 'delete']);
-- User (role 2): create = start guided forms; sees/edits own records via ownership RLS (no blanket read)
SELECT public.grant_guided_form_permissions('building_use_request', 2, ARRAY['create']);

-- ============================================================================
-- VALIDATIONS (exercise conditional CHECK constraint system)
-- ============================================================================

-- Clear existing validations for these tables to avoid duplicates on re-runs
DELETE FROM metadata.validations WHERE table_name IN (
    'building_use_requests', 'building_use_event_details', 'building_use_room_preferences'
);

-- Parent table validations: enforced only when status_id = draft (via is_guided_form_draft())
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('building_use_requests', 'group_name',        'required',  NULL,        'Group name is required',                              1),
  ('building_use_requests', 'contact_email',     'required',  NULL,        'Contact email is required',                           2),
  ('building_use_requests', 'contact_email',     'pattern',   '^[^\s@]+@[^\s@]+\.[^\s@]+$', 'Must be a valid email address', 3),
  ('building_use_requests', 'contact_phone',     'required',  NULL,        'Contact phone is required',                           4),
  ('building_use_requests', 'mission_description', 'required', NULL,       'Mission description is required',                     5);

-- Event details validations
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('building_use_event_details', 'time_slot',           'required', NULL, 'Event time slot is required',      1),
  ('building_use_event_details', 'estimated_attendees', 'required', NULL, 'Estimated attendees is required',  2),
  ('building_use_event_details', 'estimated_attendees', 'min',      '1',  'Must have at least 1 attendee',    3),
  ('building_use_event_details', 'estimated_attendees', 'max',      '500', 'Cannot exceed 500 attendees',     4);

-- Room preferences validations
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('building_use_room_preferences', 'room_type', 'required', NULL, 'Room type is required', 1);

-- ============================================================================
-- REBUILD CHECK CONSTRAINTS (creates draft-safe CHECK constraints)
-- ============================================================================

SELECT metadata.rebuild_guided_form_constraints('building_use_requests');
SELECT metadata.rebuild_guided_form_constraints('building_use_event_details');
SELECT metadata.rebuild_guided_form_constraints('building_use_room_preferences');

-- ============================================================================
-- MOCK DATA CLEANUP
-- ============================================================================

DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'building_use_request' AND parent_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_room_preferences WHERE building_use_request_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_event_details WHERE building_use_request_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_requests WHERE id IN (10001, 10002, 10003, 10004, 10005);

-- ============================================================================
-- MOCK DATA
-- ============================================================================

-- Record 10001: Nonprofit, DRAFT
--   Parent: draft
--   Event details: draft (incomplete - missing estimated_attendees to test validation)
--   Room prefs: none
INSERT INTO public.building_use_requests (id, display_name, group_name, group_type, borrower_id, contact_name, contact_email, contact_phone, mission_description)
VALUES (10001, 'Oak Park Cleanup - Draft', 'Oak Park Neighbors', 4, NULL, 'Sarah Chen', 'sarah@oakpark.org', '5551112222', 'Monthly neighborhood cleanup and greening initiative.');

INSERT INTO public.building_use_event_details (id, building_use_request_id, time_slot, estimated_attendees, setup_needs)
VALUES (10001, 10001, tstzrange('2026-06-15 09:00:00'::timestamptz, '2026-06-15 12:00:00'::timestamptz), NULL, 'Trash bags, gloves, refreshments');

-- Record 10002: Private Event, DRAFT
--   Parent: draft
--   Event details: SKIPPED (private_event skips this step)
--   Room prefs: none
INSERT INTO public.building_use_requests (id, display_name, group_name, group_type, borrower_id, contact_name, contact_email, contact_phone, mission_description)
VALUES (10002, 'Smith Birthday Party - Draft', 'Smith Family', 7, NULL, 'John Smith', 'john@example.com', '5553334444', 'Private birthday celebration.');

-- Record 10003: Community Group, COMPLETE
--   Parent: complete
--   Event details: complete
--   Room prefs: skipped (optional for community group)
INSERT INTO public.building_use_requests (id, display_name, group_name, group_type, borrower_id, contact_name, contact_email, contact_phone, mission_description)
VALUES (10003, 'Youth Coding Workshop - Complete', 'Code for Good', 5, NULL, 'Maria Garcia', 'maria@codeforgood.org', '5555556666', 'Free coding classes for underserved youth.');

INSERT INTO public.building_use_event_details (id, status_id, building_use_request_id, time_slot, estimated_attendees, setup_needs)
SELECT 10003, s.id, 10003, tstzrange('2026-05-15 14:00:00'::timestamptz, '2026-05-15 17:00:00'::timestamptz), 25, 'Tables, chairs, projector, Wi-Fi'
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'complete';

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10003, '__parent__', NOW()),
       ('building_use_request', 10003, 'event_details', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Record 10004: School, DRAFT
--   Parent: draft
--   Event details: complete
--   Room prefs: draft (required for school - must complete to finish guided_form)
INSERT INTO public.building_use_requests (id, display_name, group_name, group_type, borrower_id, contact_name, contact_email, contact_phone, mission_description)
VALUES (10004, 'After-School STEM Program - Draft', 'Lincoln High Robotics', 6, NULL, 'David Park', 'david@lincolnhs.edu', '5557778888', 'Weekly robotics and coding workshops for students.');

INSERT INTO public.building_use_event_details (id, status_id, building_use_request_id, time_slot, estimated_attendees, setup_needs)
SELECT 10004, s.id, 10004, tstzrange('2026-05-20 15:30:00'::timestamptz, '2026-05-20 17:30:00'::timestamptz), 40, 'Power strips, laptops, projector'
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'complete';

INSERT INTO public.building_use_room_preferences (id, building_use_request_id, group_size_estimate, room_type, needs_av_equipment, accessibility_needs)
VALUES (10004, 10004, 40, NULL, TRUE, 'Wheelchair accessible entrance');

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10004, '__parent__', NOW()),
       ('building_use_request', 10004, 'event_details', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Record 10005: Nonprofit, COMPLETE + SUBMITTED
--   Parent: complete, submitted_at set
--   Event details: complete
--   Room prefs: complete
--   Tests: lock_on_submit (editing should fail)
INSERT INTO public.building_use_requests (id, display_name, submitted_at, group_name, group_type, borrower_id, contact_name, contact_email, contact_phone, mission_description)
VALUES (10005, 'Community Garden Planning - Submitted', NOW(), 'Green Thumb Collective', 4, NULL, 'Amara Okafor', 'amara@greenthumb.org', '5559990000', 'Planning meeting for the new community garden layout.');

INSERT INTO public.building_use_event_details (id, status_id, building_use_request_id, time_slot, estimated_attendees, setup_needs)
SELECT 10005, s.id, 10005, tstzrange('2026-04-30 10:00:00'::timestamptz, '2026-04-30 12:00:00'::timestamptz), 15, 'Whiteboard, markers, coffee'
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'complete';

INSERT INTO public.building_use_room_preferences (id, status_id, building_use_request_id, group_size_estimate, room_type, needs_av_equipment, accessibility_needs)
SELECT 10005, s.id, 10005, 15, c.id, FALSE, NULL
FROM metadata.statuses s, metadata.categories c
WHERE s.entity_type = 'guided_form' AND s.status_key = 'complete'
  AND c.entity_type = 'building_use_room_type' AND c.category_key = 'conference_room';

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10005, '__parent__', NOW()),
       ('building_use_request', 10005, 'event_details', NOW()),
       ('building_use_request', 10005, 'room_preferences', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

NOTIFY pgrst, 'reload schema';
