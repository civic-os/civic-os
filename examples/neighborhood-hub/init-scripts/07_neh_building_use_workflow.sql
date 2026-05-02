-- Neighborhood Engagement Hub - Building Use GuidedForm (v0.51.0 restructured)
-- Collapsed from 2 data steps to 1: scheduling fields moved to parent entity.
-- Exercises: skip_if, require_if, validations, lock_on_submit, precondition_rpc,
-- on_submit_rpc (sets status), depends_on_columns + options_source_rpc,
-- calendar integration, overlap prevention, deny action button.
--
-- GuidedForm: Building Use Request
--   Step 0 (Parent): Group info, contact name, scheduling (time_slot, attendees, setup)
--   Step 1: Room preferences (room type, AV needs, accessibility)
--      can_skip = TRUE by default
--      skip_if: private_event → auto-submit → auto-deny
--      require_if: school group type REQUIRES this step

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

-- Building use requests: scheduling fields on parent (collapsed from child table)
-- contact_email/phone removed — notifications use user account email
CREATE TABLE IF NOT EXISTS public.building_use_requests (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    submitted_at TIMESTAMPTZ,
    group_name VARCHAR(200),
    group_type INTEGER REFERENCES metadata.categories(id),
    borrower_id BIGINT REFERENCES public.borrowers(id),
    contact_name VARCHAR(200),
    time_slot time_slot,
    estimated_attendees INTEGER,
    setup_needs TEXT,
    mission_description TEXT,
    decision_notes TEXT,
    status_id INT REFERENCES metadata.statuses(id),
    created_by UUID DEFAULT current_user_id(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Room preferences: same structure as before (step 1, was step 2)
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
-- INDEXES
-- ============================================================================

-- GIST index for overlap prevention on time_slot
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'building_use_requests'
    AND indexname = 'building_use_requests_time_slot_gist'
  ) THEN
    CREATE INDEX building_use_requests_time_slot_gist
      ON public.building_use_requests USING GIST (time_slot);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'building_use_requests'
    AND indexname = 'building_use_requests_borrower_id_idx'
  ) THEN
    CREATE INDEX building_use_requests_borrower_id_idx
      ON public.building_use_requests(borrower_id);
  END IF;
END $$;

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
END $$;

-- ============================================================================
-- GRANTS
-- ============================================================================

-- Grant to web_anon (read-only public access)
GRANT SELECT ON public.building_use_requests TO web_anon;
GRANT SELECT ON public.building_use_room_preferences TO web_anon;

-- Grant to authenticated (full CRUD)
GRANT ALL ON public.building_use_requests TO authenticated;
GRANT ALL ON public.building_use_room_preferences TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_requests_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_room_preferences_id_seq TO authenticated;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-generate display_name as "Group Name - YYYY-MM-DD"
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

-- ============================================================================
-- OVERLAP PREVENTION (enforced at approval time)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_building_use_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_status_key TEXT;
    v_conflict_count INT;
BEGIN
    -- Only check when transitioning TO approved
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.status_id;

    IF v_status_key != 'approved' THEN
        RETURN NEW;
    END IF;

    -- Check for overlapping approved requests
    SELECT COUNT(*) INTO v_conflict_count
    FROM public.building_use_requests bur
    JOIN metadata.statuses s ON bur.status_id = s.id
    WHERE bur.id != NEW.id
      AND bur.time_slot && NEW.time_slot
      AND s.entity_type = 'building_use_requests'
      AND s.status_key = 'approved';

    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION 'This time slot overlaps with % existing approved booking(s). Please choose a different time.',
            v_conflict_count;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_building_use_overlap
    BEFORE UPDATE OF status_id ON public.building_use_requests
    FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.check_building_use_overlap();

-- ============================================================================
-- RPCs
-- ============================================================================

-- Precondition: block new guided_form if there are already 5+ total requests
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
    -- Staff and admin bypass precondition
    IF 'neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin() THEN
        RETURN jsonb_build_object('success', true);
    END IF;

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

-- On-submit hook: set status based on group type
-- Private events → denied with decision_notes
-- All other eligible groups → pending (triggers staff notification via status_change)
CREATE OR REPLACE FUNCTION public.notify_building_use_submitted(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_group_type_key TEXT;
    v_pending_status_id INT;
    v_denied_status_id INT;
BEGIN
    -- Look up the category_key for this request's group_type
    SELECT c.category_key INTO v_group_type_key
    FROM public.building_use_requests r
    JOIN metadata.categories c ON c.id = r.group_type
    WHERE r.id = p_parent_id;

    IF v_group_type_key = 'private_event' THEN
        -- Private events are auto-denied
        SELECT id INTO v_denied_status_id
        FROM metadata.statuses
        WHERE entity_type = 'building_use_requests' AND status_key = 'denied';

        UPDATE public.building_use_requests
           SET status_id = v_denied_status_id,
               decision_notes = 'Private events do not qualify for building use under NEH community facility policies. '
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

    -- Standard submission: set status to pending (triggers staff notification)
    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'building_use_requests' AND status_key = 'pending';

    UPDATE public.building_use_requests
       SET status_id = v_pending_status_id,
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Building Use Request') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your building use request has been submitted for review.',
        'navigate_to', '/view/building_use_requests/' || p_parent_id
    );
END;
$$;

COMMENT ON FUNCTION public.notify_building_use_submitted(BIGINT) IS
    'On-submit RPC for building_use_request guided_form. Private events get auto-denied; others set to pending.';

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
-- DENY ACTION BUTTON (Story 5)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.deny_building_use_request(p_entity_id BIGINT, p_decision_notes TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_current_status TEXT;
    v_denied_status_id INT;
BEGIN
    -- Verify current status is pending
    SELECT s.status_key INTO v_current_status
    FROM public.building_use_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_status IS DISTINCT FROM 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Only pending requests can be denied. Current status: ' || COALESCE(v_current_status, 'unknown')
        );
    END IF;

    -- Check permissions
    IF NOT (
        'neh_staff' = ANY(get_user_roles()) OR
        'neh_admin' = ANY(get_user_roles()) OR
        is_admin()
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You do not have permission to deny building use requests.'
        );
    END IF;

    SELECT id INTO v_denied_status_id
    FROM metadata.statuses
    WHERE entity_type = 'building_use_requests' AND status_key = 'denied';

    UPDATE public.building_use_requests
    SET status_id = v_denied_status_id,
        decision_notes = p_decision_notes
    WHERE id = p_entity_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Building use request has been denied.'
    );
END;
$$;

COMMENT ON FUNCTION public.deny_building_use_request(BIGINT, TEXT) IS
    'Deny a pending building use request with decision notes.';

GRANT EXECUTE ON FUNCTION public.deny_building_use_request(BIGINT, TEXT) TO authenticated;

-- Register deny action button
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description, rpc_function,
  icon, button_style, sort_order,
  requires_confirmation, confirmation_message,
  visibility_condition, enabled_condition, disabled_tooltip,
  refresh_after_action, show_on_detail
) VALUES (
  'building_use_requests',
  'deny_request',
  'Deny Request',
  'Deny this building use request',
  'deny_building_use_request',
  'block',
  'error',
  10,
  TRUE,
  'Are you sure you want to deny this building use request?',
  (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
   FROM metadata.statuses WHERE entity_type = 'building_use_requests' AND status_key = 'pending'),
  (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
   FROM metadata.statuses WHERE entity_type = 'building_use_requests' AND status_key = 'pending'),
  'Only pending requests can be denied',
  TRUE,
  TRUE
)
ON CONFLICT (table_name, action_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  rpc_function = EXCLUDED.rpc_function,
  icon = EXCLUDED.icon,
  button_style = EXCLUDED.button_style,
  sort_order = EXCLUDED.sort_order,
  requires_confirmation = EXCLUDED.requires_confirmation,
  confirmation_message = EXCLUDED.confirmation_message,
  visibility_condition = EXCLUDED.visibility_condition,
  enabled_condition = EXCLUDED.enabled_condition,
  disabled_tooltip = EXCLUDED.disabled_tooltip,
  refresh_after_action = EXCLUDED.refresh_after_action,
  show_on_detail = EXCLUDED.show_on_detail;

-- Register action parameter: decision_notes (required text field)
INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder
)
SELECT ea.id, 'p_decision_notes', 'Reason for Denial', 'text', TRUE, 10, 'Enter reason for denial...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'building_use_requests' AND ea.action_name = 'deny_request'
ON CONFLICT DO NOTHING;

-- Grant deny action to staff and admin roles
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'building_use_requests'
  AND ea.action_name = 'deny_request'
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin')
ON CONFLICT (entity_action_id, role_id) DO NOTHING;

-- ============================================================================
-- ENTITY METADATA
-- ============================================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_calendar, calendar_property_name)
VALUES
  ('building_use_requests', 'Building Use Requests', 'Mission-aligned group requests to use the community building', 8, true, 'time_slot'),
  ('building_use_room_preferences', 'Room Preferences', 'Room selection and accessibility requirements', 10, false, NULL)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      show_calendar = COALESCE(EXCLUDED.show_calendar, (SELECT show_calendar FROM metadata.entities WHERE table_name = EXCLUDED.table_name)),
      calendar_property_name = COALESCE(EXCLUDED.calendar_property_name, (SELECT calendar_property_name FROM metadata.entities WHERE table_name = EXCLUDED.table_name));

-- Remove stale entity metadata for dropped table
DELETE FROM metadata.entities WHERE table_name = 'building_use_event_details';

-- Hide timestamps, internal fields, and framework-managed columns
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('building_use_requests', 'created_at', false, false, false, false),
  ('building_use_requests', 'updated_at', false, false, false, false),
  ('building_use_requests', 'submitted_at', false, false, false, false),
  ('building_use_requests', 'display_name', true, false, false, false),
  ('building_use_requests', 'decision_notes', false, false, false, true),
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

-- Register time_slot on parent with friendly name
INSERT INTO metadata.properties (table_name, column_name, display_name)
VALUES ('building_use_requests', 'time_slot', 'Event Time Slot')
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

-- Remove stale property metadata for dropped table
DELETE FROM metadata.properties WHERE table_name = 'building_use_event_details';

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
        'Mission-aligned groups request to use the community building. Eligibility is gated by group type - private events are auto-denied, schools require room selection.'::text,
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
UPDATE metadata.guided_forms
   SET auto_submit_on_all_skipped = TRUE
 WHERE guided_form_key = 'building_use_request';

-- ============================================================================
-- GUIDED_FORM STEPS (collapsed: 1 data step)
-- ============================================================================

-- Step 1: Room preferences (optional, required for schools, skipped for private events)
SELECT public.add_guided_form_step(
    'building_use_request'::name,
    'room_preferences'::name,
    'Room Preferences'::varchar,
    1,
    'building_use_room_preferences'::name,
    'building_use_request_id'::name,
    'Select your room, AV equipment, and accessibility needs.'::text,
    TRUE    -- can_skip = TRUE (optional unless required by condition)
);

-- ============================================================================
-- GUIDED_FORM CONDITIONS
-- ============================================================================

-- Room preferences conditions:
--   skip_if: Private Event (all steps skipped → auto-submit → auto-deny)
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

-- ============================================================================
-- PERMISSIONS
-- ============================================================================

-- Admin (role 4): blanket access to all operations
SELECT public.grant_guided_form_permissions('building_use_request', 4, ARRAY['read', 'create', 'update', 'delete']);
-- User (role 2): create = start guided forms; sees/edits own records via ownership RLS
SELECT public.grant_guided_form_permissions('building_use_request', 2, ARRAY['create']);

-- ============================================================================
-- VALIDATIONS
-- ============================================================================

-- Clear existing validations
DELETE FROM metadata.validations WHERE table_name IN (
    'building_use_requests', 'building_use_event_details', 'building_use_room_preferences'
);

-- Parent table validations (scheduling fields now on parent)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('building_use_requests', 'group_name',           'required',  NULL,        'Group name is required',                   1),
  ('building_use_requests', 'mission_description',  'required',  NULL,        'Mission description is required',          2),
  ('building_use_requests', 'time_slot',            'required',  NULL,        'Event time slot is required',              3),
  ('building_use_requests', 'estimated_attendees',  'required',  NULL,        'Estimated attendees is required',          4),
  ('building_use_requests', 'estimated_attendees',  'min',       '1',         'Must have at least 1 attendee',            5),
  ('building_use_requests', 'estimated_attendees',  'max',       '500',       'Cannot exceed 500 attendees',              6);

-- Room preferences validations
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('building_use_room_preferences', 'room_type', 'required', NULL, 'Room type is required', 1);

-- ============================================================================
-- REBUILD CHECK CONSTRAINTS
-- ============================================================================

SELECT metadata.rebuild_guided_form_constraints('building_use_requests');
SELECT metadata.rebuild_guided_form_constraints('building_use_room_preferences');

-- ============================================================================
-- MOCK DATA
-- ============================================================================

-- Clean up any existing mock data
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'building_use_request' AND parent_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_room_preferences WHERE building_use_request_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_requests WHERE id IN (10001, 10002, 10003, 10004, 10005);

-- Record 10001: Nonprofit, DRAFT (time_slot on parent, no room prefs yet)
INSERT INTO public.building_use_requests (id, status_id, display_name, group_name, group_type, borrower_id, contact_name, time_slot, estimated_attendees, setup_needs, mission_description)
SELECT 10001, s.id, 'Oak Park Cleanup - Draft', 'Oak Park Neighbors', 4, NULL, 'Sarah Chen',
  tstzrange('2026-06-15 09:00:00'::timestamptz, '2026-06-15 12:00:00'::timestamptz),
  NULL, 'Trash bags, gloves, refreshments',
  'Monthly neighborhood cleanup and greening initiative.'
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'draft';

-- Record 10002: Private Event, DRAFT (will be auto-denied on submit)
INSERT INTO public.building_use_requests (id, status_id, display_name, group_name, group_type, borrower_id, contact_name, mission_description)
SELECT 10002, s.id, 'Smith Birthday Party - Draft', 'Smith Family', 7, NULL, 'John Smith', 'Private birthday celebration.'
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'draft';

-- Record 10003: Community Group, COMPLETE (parent complete, room prefs skipped)
INSERT INTO public.building_use_requests (id, display_name, group_name, group_type, borrower_id, contact_name, time_slot, estimated_attendees, setup_needs, mission_description)
VALUES (10003, 'Youth Coding Workshop - Complete', 'Code for Good', 5, NULL, 'Maria Garcia',
  tstzrange('2026-05-15 14:00:00'::timestamptz, '2026-05-15 17:00:00'::timestamptz),
  25, 'Tables, chairs, projector, Wi-Fi',
  'Free coding classes for underserved youth.');

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10003, '__parent__', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Record 10004: School, DRAFT (parent complete, room prefs required but incomplete)
INSERT INTO public.building_use_requests (id, status_id, display_name, group_name, group_type, borrower_id, contact_name, time_slot, estimated_attendees, setup_needs, mission_description)
SELECT 10004, s.id, 'After-School STEM Program - Draft', 'Lincoln High Robotics', 6, NULL, 'David Park',
  tstzrange('2026-05-20 15:30:00'::timestamptz, '2026-05-20 17:30:00'::timestamptz),
  40, 'Power strips, laptops, projector',
  'Weekly robotics and coding workshops for students.'
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'draft';

INSERT INTO public.building_use_room_preferences (id, building_use_request_id, group_size_estimate, room_type, needs_av_equipment, accessibility_needs)
VALUES (10004, 10004, 40, NULL, TRUE, 'Wheelchair accessible entrance');

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10004, '__parent__', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Record 10005: Nonprofit, COMPLETE + SUBMITTED (lock_on_submit test)
INSERT INTO public.building_use_requests (id, display_name, submitted_at, group_name, group_type, borrower_id, contact_name, time_slot, estimated_attendees, setup_needs, mission_description)
VALUES (10005, 'Community Garden Planning - Submitted', NOW(), 'Green Thumb Collective', 4, NULL, 'Amara Okafor',
  tstzrange('2026-04-30 10:00:00'::timestamptz, '2026-04-30 12:00:00'::timestamptz),
  15, 'Whiteboard, markers, coffee',
  'Planning meeting for the new community garden layout.');

INSERT INTO public.building_use_room_preferences (id, status_id, building_use_request_id, group_size_estimate, room_type, needs_av_equipment, accessibility_needs)
SELECT 10005, s.id, 10005, 15, c.id, FALSE, NULL
FROM metadata.statuses s, metadata.categories c
WHERE s.entity_type = 'guided_form' AND s.status_key = 'complete'
  AND c.entity_type = 'building_use_room_type' AND c.category_key = 'conference_room';

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10005, '__parent__', NOW()),
       ('building_use_request', 10005, 'room_preferences', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

NOTIFY pgrst, 'reload schema';
