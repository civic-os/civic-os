-- Neighborhood Engagement Hub - Building Use Workflow (v0.52.0 restructured)
-- Major changes from v0.51.0:
--   - Rooms are now a lookup table (building_use_rooms) instead of categories
--   - Room selection is M:M junction (building_use_request_rooms) replacing child table
--   - Overlap prevention is per-room instead of building-level
--   - New columns: contact_title, contact_phone, contact_email, website,
--     event_title, event_description, event_scope, charges_fee, equipment_needs,
--     frequency_of_use, hold_harmless_accepted, photo_release_accepted,
--     needs_av_equipment, accessibility_needs
--   - Updated categories: group_type updated, room_type dropped, event_scope + charges_fee added
--   - Guided form step now targets M:M junction table
--
-- GuidedForm: Building Use Request
--   Step 0 (Parent): Group info, contact, scheduling, event details, agreements
--   Step 1: Room selection (M:M junction to building_use_rooms)
--      can_skip = TRUE by default
--      skip_if: private_event → auto-submit → auto-deny

-- ============================================================================
-- 1. DROP OLD TABLE/FUNCTION/TRIGGER CLEANUP
-- ============================================================================

-- Drop old child table (replaced by M:M junction)
DROP TABLE IF EXISTS public.building_use_room_preferences CASCADE;
DROP SEQUENCE IF EXISTS public.building_use_room_preferences_id_seq CASCADE;

-- Drop old overlap function and trigger (replaced by per-room check)
DROP TRIGGER IF EXISTS trg_building_use_overlap ON public.building_use_requests;
DROP FUNCTION IF EXISTS public.check_building_use_overlap() CASCADE;

-- Drop old RPC (replaced by simpler get_room_options)
DROP FUNCTION IF EXISTS public.get_room_options_for_building_use(BIGINT, JSONB) CASCADE;

-- Remove stale entity metadata for dropped tables
DELETE FROM metadata.properties WHERE table_name = 'building_use_room_preferences';
DELETE FROM metadata.properties WHERE table_name = 'building_use_event_details';
DELETE FROM metadata.entities WHERE table_name = 'building_use_room_preferences';
DELETE FROM metadata.entities WHERE table_name = 'building_use_event_details';

-- Remove stale category group (rooms are now a lookup table)
DELETE FROM metadata.categories WHERE entity_type = 'building_use_room_type';
DELETE FROM metadata.category_groups WHERE entity_type = 'building_use_room_type';

-- ============================================================================
-- 2. CATEGORIES
-- ============================================================================

-- Group types (updated: removed Community Group + School, added Neighborhood Group + Business + Informal Group)
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('building_use_group_type', 'Building Use Group Type')
ON CONFLICT (entity_type) DO NOTHING;

-- Remove old categories that no longer exist
DELETE FROM metadata.categories
WHERE entity_type = 'building_use_group_type'
  AND category_key IN ('community_group', 'school');

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('building_use_group_type', 'Nonprofit',           'nonprofit',          '#22c55e', 1),
  ('building_use_group_type', 'Neighborhood Group',  'neighborhood_group', '#3b82f6', 2),
  ('building_use_group_type', 'Business',            'business',           '#f97316', 3),
  ('building_use_group_type', 'Informal Group',      'informal_group',     '#8b5cf6', 4),
  ('building_use_group_type', 'Private Event',       'private_event',      '#dc2626', 5)
ON CONFLICT (entity_type, display_name) DO UPDATE
  SET category_key = EXCLUDED.category_key,
      color = EXCLUDED.color,
      sort_order = EXCLUDED.sort_order;

-- Event scope categories
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('building_use_event_scope', 'Building Use Event Scope')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('building_use_event_scope', 'Internal', 'internal', '#3b82f6', 1),
  ('building_use_event_scope', 'External', 'external', '#22c55e', 2),
  ('building_use_event_scope', 'Other',    'other',    '#6b7280', 3)
ON CONFLICT (entity_type, display_name) DO UPDATE
  SET category_key = EXCLUDED.category_key,
      color = EXCLUDED.color,
      sort_order = EXCLUDED.sort_order;

-- Charges fee categories
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('building_use_charges_fee', 'Building Use Charges Fee')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('building_use_charges_fee', 'Yes',     'yes',     '#f59e0b', 1),
  ('building_use_charges_fee', 'No',      'no',      '#22c55e', 2),
  ('building_use_charges_fee', 'Unknown', 'unknown', '#6b7280', 3)
ON CONFLICT (entity_type, display_name) DO UPDATE
  SET category_key = EXCLUDED.category_key,
      color = EXCLUDED.color,
      sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- 3. TABLES
-- ============================================================================

-- Building use requests: expanded with contact, event, and agreement fields
CREATE TABLE IF NOT EXISTS public.building_use_requests (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(200),
    submitted_at TIMESTAMPTZ,
    group_name VARCHAR(200),
    group_type INTEGER REFERENCES metadata.categories(id),
    borrower_id BIGINT REFERENCES public.borrowers(id),
    contact_name VARCHAR(200),
    contact_title VARCHAR(255),
    contact_phone phone_number,
    contact_email email_address,
    website VARCHAR(500),
    time_slot time_slot,
    estimated_attendees INTEGER,
    event_title VARCHAR(255),
    event_description TEXT,
    event_scope INTEGER REFERENCES metadata.categories(id),
    charges_fee INTEGER REFERENCES metadata.categories(id),
    equipment_needs TEXT,
    setup_needs TEXT,
    frequency_of_use VARCHAR(255),
    mission_description TEXT,
    needs_av_equipment BOOLEAN DEFAULT FALSE,
    accessibility_needs TEXT,
    hold_harmless_accepted BOOLEAN DEFAULT FALSE,
    photo_release_accepted BOOLEAN DEFAULT FALSE,
    decision_notes TEXT,
    status_id INT REFERENCES metadata.statuses(id),
    created_by UUID DEFAULT current_user_id(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add new columns to existing table (idempotent for re-runs)
DO $$
BEGIN
    -- Contact fields
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'contact_title') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN contact_title VARCHAR(255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'contact_phone') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN contact_phone phone_number;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'contact_email') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN contact_email email_address;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'website') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN website VARCHAR(500);
    END IF;

    -- Event fields
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'event_title') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN event_title VARCHAR(255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'event_description') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN event_description TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'event_scope') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN event_scope INTEGER REFERENCES metadata.categories(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'charges_fee') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN charges_fee INTEGER REFERENCES metadata.categories(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'equipment_needs') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN equipment_needs TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'frequency_of_use') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN frequency_of_use VARCHAR(255);
    END IF;

    -- Fields moved from room_preferences
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'needs_av_equipment') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN needs_av_equipment BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'accessibility_needs') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN accessibility_needs TEXT;
    END IF;

    -- Agreement fields
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'hold_harmless_accepted') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN hold_harmless_accepted BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'building_use_requests' AND column_name = 'photo_release_accepted') THEN
        ALTER TABLE public.building_use_requests ADD COLUMN photo_release_accepted BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Rooms lookup table
CREATE TABLE IF NOT EXISTS public.building_use_rooms (
    id SERIAL PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    capacity INT,
    has_av BOOLEAN DEFAULT false,
    description TEXT,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed rooms (idempotent)
INSERT INTO public.building_use_rooms (display_name, capacity, has_av, description, sort_order)
VALUES
  ('Large Meeting Room', 40,   true,  '85" TV, camera, microphone', 1),
  ('Small Meeting Room', 12,   true,  '65" TV, camera, microphone', 2),
  ('Conference Room',    10,   true,  '65" TV, camera, microphone', 3),
  ('Outdoor Space',      NULL, false, 'Outdoor gathering area',     4)
ON CONFLICT DO NOTHING;

-- M:M junction: request ↔ rooms (composite PK, no surrogate ID)
CREATE TABLE IF NOT EXISTS public.building_use_request_rooms (
    building_use_request_id BIGINT REFERENCES public.building_use_requests(id) ON DELETE CASCADE,
    room_id INT REFERENCES public.building_use_rooms(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (building_use_request_id, room_id)
);

-- ============================================================================
-- 4. INDEXES
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

-- FK indexes on junction table
CREATE INDEX IF NOT EXISTS building_use_request_rooms_request_idx
  ON public.building_use_request_rooms(building_use_request_id);
CREATE INDEX IF NOT EXISTS building_use_request_rooms_room_idx
  ON public.building_use_request_rooms(room_id);

-- FK indexes on new category columns
CREATE INDEX IF NOT EXISTS building_use_requests_event_scope_idx
  ON public.building_use_requests(event_scope);
CREATE INDEX IF NOT EXISTS building_use_requests_charges_fee_idx
  ON public.building_use_requests(charges_fee);

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
-- 5. GRANTS
-- ============================================================================

-- Grant to web_anon (read-only public access)
GRANT SELECT ON public.building_use_requests TO web_anon;
GRANT SELECT ON public.building_use_rooms TO web_anon;
GRANT SELECT ON public.building_use_request_rooms TO web_anon;

-- Grant to authenticated (full CRUD where appropriate)
GRANT ALL ON public.building_use_requests TO authenticated;
GRANT SELECT ON public.building_use_rooms TO authenticated;
GRANT ALL ON public.building_use_request_rooms TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_requests_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.building_use_rooms_id_seq TO authenticated;

-- ============================================================================
-- 6. TRIGGERS
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

-- Per-room overlap check: prevents adding rooms to approved requests that conflict
CREATE OR REPLACE FUNCTION public.check_building_use_room_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_parent_status TEXT;
    v_parent_time_slot tstzrange;
    v_conflict_count INT;
BEGIN
    -- Only check rooms for approved requests
    SELECT s.status_key, r.time_slot
    INTO v_parent_status, v_parent_time_slot
    FROM public.building_use_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = NEW.building_use_request_id;

    -- Skip check if parent isn't approved yet (rooms can be added to drafts)
    IF v_parent_status IS NULL OR v_parent_status != 'approved' THEN
        RETURN NEW;
    END IF;

    -- Check for overlapping approved requests with the same room
    SELECT COUNT(*) INTO v_conflict_count
    FROM building_use_request_rooms burr
    JOIN building_use_requests bur ON bur.id = burr.building_use_request_id
    JOIN metadata.statuses s ON bur.status_id = s.id
    WHERE burr.room_id = NEW.room_id
      AND burr.building_use_request_id != NEW.building_use_request_id
      AND bur.time_slot && v_parent_time_slot
      AND s.entity_type = 'building_use_requests'
      AND s.status_key = 'approved';

    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION 'Room "%" is already booked for an overlapping time slot.',
            (SELECT display_name FROM building_use_rooms WHERE id = NEW.room_id);
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_building_use_room_overlap
    BEFORE INSERT ON public.building_use_request_rooms
    FOR EACH ROW EXECUTE FUNCTION public.check_building_use_room_overlap();

-- Status-change overlap check: when approving, check ALL rooms for conflicts
CREATE OR REPLACE FUNCTION public.check_building_use_approval_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_status_key TEXT;
    v_room RECORD;
    v_conflict_count INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.status_id;

    IF v_status_key != 'approved' THEN
        RETURN NEW;
    END IF;

    -- Check each room in this request for overlaps
    FOR v_room IN
        SELECT burr.room_id, br.display_name
        FROM building_use_request_rooms burr
        JOIN building_use_rooms br ON br.id = burr.room_id
        WHERE burr.building_use_request_id = NEW.id
    LOOP
        SELECT COUNT(*) INTO v_conflict_count
        FROM building_use_request_rooms burr2
        JOIN building_use_requests bur2 ON bur2.id = burr2.building_use_request_id
        JOIN metadata.statuses s ON bur2.status_id = s.id
        WHERE burr2.room_id = v_room.room_id
          AND burr2.building_use_request_id != NEW.id
          AND bur2.time_slot && NEW.time_slot
          AND s.entity_type = 'building_use_requests'
          AND s.status_key = 'approved';

        IF v_conflict_count > 0 THEN
            RAISE EXCEPTION 'Room "%" is already booked for an overlapping time slot.',
                v_room.display_name;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_building_use_overlap
    BEFORE UPDATE OF status_id ON public.building_use_requests
    FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.check_building_use_approval_overlap();

-- ============================================================================
-- 7. RPCs
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
                             || 'Only mission-aligned nonprofit, neighborhood, and community groups are eligible.',
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

-- Room options RPC: returns all rooms ordered by sort_order
CREATE OR REPLACE FUNCTION public.get_room_options(
    p_id TEXT DEFAULT NULL,
    p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE(id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT r.id, r.display_name::TEXT
    FROM building_use_rooms r
    ORDER BY r.sort_order;
$$;

GRANT EXECUTE ON FUNCTION public.get_room_options(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_options(TEXT, JSONB) TO web_anon;

-- ============================================================================
-- 8. DENY ACTION BUTTON
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
-- 9. ENTITY METADATA
-- ============================================================================

-- Entity: building_use_requests
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_calendar, calendar_property_name)
VALUES ('building_use_requests', 'Building Use Requests', 'Mission-aligned group requests to use the community building', 8, true, 'time_slot')
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      show_calendar = COALESCE(EXCLUDED.show_calendar, (SELECT show_calendar FROM metadata.entities WHERE table_name = EXCLUDED.table_name)),
      calendar_property_name = COALESCE(EXCLUDED.calendar_property_name, (SELECT calendar_property_name FROM metadata.entities WHERE table_name = EXCLUDED.table_name));

-- Entity: building_use_rooms (lookup table, visible in sidebar)
INSERT INTO metadata.entities (table_name, display_name, sort_order, show_in_sidebar)
VALUES ('building_use_rooms', 'Building Use Rooms', 10, true)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_in_sidebar = EXCLUDED.show_in_sidebar;

-- ── building_use_requests property metadata ──

-- Decision notes: full width, first on detail page, system-managed
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('building_use_requests', 'decision_notes', 'Decision Notes', -10, 2, false, false, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- Status
INSERT INTO metadata.properties (table_name, column_name, sort_order)
VALUES ('building_use_requests', 'status_id', 1)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order;

-- Group name
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'group_name', 5, 2, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Group type (Category property)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, category_entity_type, join_table, join_column)
VALUES ('building_use_requests', 'group_type', 'Group Type', 6, 1, true, 'building_use_group_type', 'categories', 'id')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list,
      category_entity_type = EXCLUDED.category_entity_type,
      join_table = EXCLUDED.join_table,
      join_column = EXCLUDED.join_column;

-- Borrower (FK search modal)
INSERT INTO metadata.properties (table_name, column_name, sort_order, show_on_list, fk_search_modal, join_table, options_source_rpc)
VALUES ('building_use_requests', 'borrower_id', 7, false, true, 'borrowers', 'get_borrowers_for_reservation')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      fk_search_modal = EXCLUDED.fk_search_modal,
      join_table = EXCLUDED.join_table,
      options_source_rpc = EXCLUDED.options_source_rpc;

-- Contact name
INSERT INTO metadata.properties (table_name, column_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'contact_name', 10, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Contact title
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'contact_title', 'Contact Title/Role', 11, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Contact phone
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'contact_phone', 'Contact Phone', 12, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Contact email
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'contact_email', 'Contact Email', 13, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Website/Social Media
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'website', 'Website/Social Media', 14, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Mission description
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'mission_description', 15, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Event Time Slot
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'time_slot', 'Event Time Slot', 20, 2, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Frequency of use
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'frequency_of_use', 'Frequency of Use', 21, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Estimated attendees
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'estimated_attendees', 'Est. Attendees', 22, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Event title
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'event_title', 25, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Event description
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'event_description', 26, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Event scope (Category property)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, category_entity_type, join_table, join_column)
VALUES ('building_use_requests', 'event_scope', 'Internal/External', 27, false, 'building_use_event_scope', 'categories', 'id')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      category_entity_type = EXCLUDED.category_entity_type,
      join_table = EXCLUDED.join_table,
      join_column = EXCLUDED.join_column;

-- Charges fee (Category property)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, category_entity_type, join_table, join_column)
VALUES ('building_use_requests', 'charges_fee', 'Charges a Fee?', 28, false, 'building_use_charges_fee', 'categories', 'id')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      category_entity_type = EXCLUDED.category_entity_type,
      join_table = EXCLUDED.join_table,
      join_column = EXCLUDED.join_column;

-- Equipment needs
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'equipment_needs', 30, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Setup needs
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'setup_needs', 31, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Needs AV equipment
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list)
VALUES ('building_use_requests', 'needs_av_equipment', 'Needs AV Equipment', 32, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list;

-- Accessibility needs
INSERT INTO metadata.properties (table_name, column_name, sort_order, column_width, show_on_list)
VALUES ('building_use_requests', 'accessibility_needs', 33, 2, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list;

-- Hold harmless agreement (show on create only)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES ('building_use_requests', 'hold_harmless_accepted', 'Hold Harmless Agreement', 40, false, true, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- Photo release agreement (show on create only)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES ('building_use_requests', 'photo_release_accepted', 'Photo Release Agreement', 41, false, true, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- display_name: show on list, hide from create/edit/detail
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('building_use_requests', 'display_name', true, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- Hide internal/framework fields
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('building_use_requests', 'submitted_at', false, false, false, false),
  ('building_use_requests', 'created_at',   false, false, false, false),
  ('building_use_requests', 'updated_at',   false, false, false, false),
  ('building_use_requests', 'created_by',   false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- M:M property: rooms junction (inline, no search modal)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline)
VALUES ('building_use_requests', 'building_use_request_rooms_m2m', false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = EXCLUDED.fk_search_modal,
      show_inline = EXCLUDED.show_inline;

-- ── building_use_rooms property metadata ──

-- Hide timestamps
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('building_use_rooms', 'created_at', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit,
      show_on_detail = EXCLUDED.show_on_detail;

-- ============================================================================
-- 10. GUIDED FORM REGISTRATION
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
        'Mission-aligned groups request to use the community building. Eligibility is gated by group type - private events are auto-denied.'::text,
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

-- Step 1: Room selection (M:M junction to building_use_rooms)
SELECT public.add_guided_form_step(
    'building_use_request'::name,
    'room_selection'::name,
    'Room Selection'::varchar,
    1,
    'building_use_request_rooms'::name,
    'building_use_request_id'::name,
    'Select which rooms you need for your event.'::text,
    TRUE    -- can_skip = TRUE (optional unless required by condition)
);

-- ============================================================================
-- 11. GUIDED FORM CONDITIONS
-- ============================================================================

-- Room selection conditions:
--   skip_if: Private Event (all steps skipped → auto-submit → auto-deny)
DELETE FROM metadata.guided_form_step_conditions
WHERE guided_form_step_id IN (
  SELECT id FROM metadata.guided_form_steps
  WHERE guided_form_key = 'building_use_request' AND step_key = 'room_selection'
);

INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
SELECT ws.id, 'skip_if', 'group_type', 'eq',
  (SELECT id::text FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'private_event'),
  0
FROM metadata.guided_form_steps ws
WHERE ws.guided_form_key = 'building_use_request' AND ws.step_key = 'room_selection';

-- ============================================================================
-- 12. GUIDED FORM PERMISSIONS
-- ============================================================================

SELECT public.grant_guided_form_permissions('building_use_request', (SELECT id FROM metadata.roles WHERE role_key = 'admin'), ARRAY['read', 'create', 'update', 'delete']);
SELECT public.grant_guided_form_permissions('building_use_request', (SELECT id FROM metadata.roles WHERE role_key = 'neh_admin'), ARRAY['read', 'create', 'update', 'delete']);
SELECT public.grant_guided_form_permissions('building_use_request', (SELECT id FROM metadata.roles WHERE role_key = 'neh_staff'), ARRAY['read', 'create', 'update', 'delete']);
SELECT public.grant_guided_form_permissions('building_use_request', (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower'), ARRAY['create']);

-- ============================================================================
-- 13. VALIDATIONS
-- ============================================================================

-- Clear existing validations
DELETE FROM metadata.validations WHERE table_name IN (
    'building_use_requests', 'building_use_event_details', 'building_use_room_preferences'
);

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('building_use_requests', 'group_name',              'required', NULL,   'Group name is required',                  1),
  ('building_use_requests', 'time_slot',               'required', NULL,   'Event time slot is required',             2),
  ('building_use_requests', 'estimated_attendees',     'required', NULL,   'Estimated attendees is required',         3),
  ('building_use_requests', 'estimated_attendees',     'min',      '1',    'Must have at least 1 attendee',           4),
  ('building_use_requests', 'estimated_attendees',     'max',      '500',  'Cannot exceed 500 attendees',             5),
  ('building_use_requests', 'event_title',             'required', NULL,   'Event title is required',                 6),
  ('building_use_requests', 'hold_harmless_accepted',  'required', NULL,   'Hold harmless agreement is required',     7),
  ('building_use_requests', 'photo_release_accepted',  'required', NULL,   'Photo release agreement is required',     8);

-- ============================================================================
-- 14. MOCK DATA
-- ============================================================================

-- Clean up any existing mock data
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'building_use_request' AND parent_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_request_rooms WHERE building_use_request_id IN (10001, 10002, 10003, 10004, 10005);
DELETE FROM public.building_use_requests WHERE id IN (10001, 10002, 10003, 10004, 10005);

-- Record 10001: Nonprofit, DRAFT
INSERT INTO public.building_use_requests (
    id, status_id, display_name, group_name, group_type, borrower_id, contact_name,
    contact_title, contact_phone, contact_email, website,
    time_slot, estimated_attendees, setup_needs, mission_description,
    event_title, event_description, needs_av_equipment, hold_harmless_accepted, photo_release_accepted
)
SELECT 10001, s.id, 'Oak Park Cleanup - Draft', 'Oak Park Neighbors',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'nonprofit'),
  NULL, 'Sarah Chen',
  'President', '3135550101', 'sarah.chen@oakpark.org', 'https://oakparkneighbors.org',
  tstzrange('2026-06-15 09:00:00'::timestamptz, '2026-06-15 12:00:00'::timestamptz),
  NULL, 'Trash bags, gloves, refreshments',
  'Monthly neighborhood cleanup and greening initiative.',
  'Summer Cleanup Kickoff', 'Annual kickoff for the summer cleanup season.', false, true, true
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'draft';

-- Record 10002: Private Event, DRAFT (will be auto-denied on submit)
INSERT INTO public.building_use_requests (
    id, status_id, display_name, group_name, group_type, borrower_id, contact_name,
    mission_description, event_title, hold_harmless_accepted, photo_release_accepted
)
SELECT 10002, s.id, 'Smith Birthday Party - Draft', 'Smith Family',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'private_event'),
  NULL, 'John Smith',
  'Private birthday celebration.', 'Birthday Party', true, true
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'draft';

-- Record 10003: Neighborhood Group, COMPLETE (with room junction entries)
INSERT INTO public.building_use_requests (
    id, display_name, group_name, group_type, borrower_id, contact_name,
    contact_title, contact_email,
    time_slot, estimated_attendees, setup_needs, mission_description,
    event_title, event_description,
    event_scope, charges_fee,
    needs_av_equipment, hold_harmless_accepted, photo_release_accepted
)
VALUES (10003, 'Youth Coding Workshop - Complete', 'Code for Good',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'neighborhood_group'),
  NULL, 'Maria Garcia',
  'Program Director', 'maria@codeforgood.org',
  tstzrange('2026-05-15 14:00:00'::timestamptz, '2026-05-15 17:00:00'::timestamptz),
  25, 'Tables, chairs, projector, Wi-Fi',
  'Free coding classes for underserved youth.',
  'Youth Coding Workshop', 'Hands-on coding workshop for teens ages 13-18.',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_event_scope' AND category_key = 'external'),
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_charges_fee' AND category_key = 'no'),
  true, true, true);

-- Add rooms to record 10003
INSERT INTO public.building_use_request_rooms (building_use_request_id, room_id)
SELECT 10003, r.id FROM public.building_use_rooms r WHERE r.display_name = 'Large Meeting Room';
INSERT INTO public.building_use_request_rooms (building_use_request_id, room_id)
SELECT 10003, r.id FROM public.building_use_rooms r WHERE r.display_name = 'Small Meeting Room';

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10003, '__parent__', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Record 10004: Informal Group, DRAFT (parent complete)
INSERT INTO public.building_use_requests (
    id, status_id, display_name, group_name, group_type, borrower_id, contact_name,
    contact_title,
    time_slot, estimated_attendees, setup_needs, mission_description,
    event_title, needs_av_equipment, hold_harmless_accepted, photo_release_accepted
)
SELECT 10004, s.id, 'Book Club Meetup - Draft', 'Eastside Book Club',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'informal_group'),
  NULL, 'David Park',
  'Organizer',
  tstzrange('2026-05-20 18:00:00'::timestamptz, '2026-05-20 20:00:00'::timestamptz),
  15, 'Coffee, chairs in circle',
  'Monthly book discussion group fostering community literacy.',
  'Monthly Book Discussion', false, true, true
FROM metadata.statuses s WHERE s.entity_type = 'guided_form' AND s.status_key = 'draft';

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10004, '__parent__', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- Record 10005: Nonprofit, COMPLETE + SUBMITTED (lock_on_submit test)
INSERT INTO public.building_use_requests (
    id, display_name, submitted_at, group_name, group_type, borrower_id, contact_name,
    contact_title, contact_phone, contact_email,
    time_slot, estimated_attendees, setup_needs, mission_description,
    event_title, event_description,
    event_scope, charges_fee,
    needs_av_equipment, accessibility_needs,
    hold_harmless_accepted, photo_release_accepted
)
VALUES (10005, 'Community Garden Planning - Submitted', NOW(), 'Green Thumb Collective',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_group_type' AND category_key = 'nonprofit'),
  NULL, 'Amara Okafor',
  'Treasurer', '3135550202', 'amara@greenthumb.org',
  tstzrange('2026-04-30 10:00:00'::timestamptz, '2026-04-30 12:00:00'::timestamptz),
  15, 'Whiteboard, markers, coffee',
  'Planning meeting for the new community garden layout.',
  'Garden Planning Session', 'Collaborative planning meeting with community stakeholders.',
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_event_scope' AND category_key = 'internal'),
  (SELECT id FROM metadata.categories WHERE entity_type = 'building_use_charges_fee' AND category_key = 'no'),
  false, 'Wheelchair accessible entrance',
  true, true);

-- Add rooms to record 10005
INSERT INTO public.building_use_request_rooms (building_use_request_id, room_id)
SELECT 10005, r.id FROM public.building_use_rooms r WHERE r.display_name = 'Conference Room';

INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_at)
VALUES ('building_use_request', 10005, '__parent__', NOW()),
       ('building_use_request', 10005, 'room_selection', NOW())
ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET completed_at = NOW();

-- ============================================================================
-- 15. REBUILD CONSTRAINTS + NOTIFY
-- ============================================================================

SELECT metadata.rebuild_guided_form_constraints('building_use_requests');

-- Human-readable error messages for constraints not covered by workflow validations
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('building_use_request_rooms_pkey', 'building_use_request_rooms', 'room_id',
   'This room has already been added to the request')
ON CONFLICT (constraint_name) DO UPDATE
  SET error_message = EXCLUDED.error_message;

NOTIFY pgrst, 'reload schema';
