-- ============================================================================
-- COMMUNITY CENTER RESERVATIONS EXAMPLE
-- Demonstrates: TimeSlot property type, calendar views, approval workflows
-- ============================================================================
-- NOTE: Requires Civic OS v0.15.0+ (includes Status Type System, time_slot domain, btree_gist)
-- ============================================================================

-- ============================================================================
-- STATUS TYPE SYSTEM CONFIGURATION
-- Uses centralized metadata.statuses instead of per-entity lookup tables
-- ============================================================================

-- Register 'reservation_request' as a valid status entity type
INSERT INTO metadata.status_types (entity_type, description)
VALUES ('reservation_request', 'Status values for community center reservation requests')
ON CONFLICT (entity_type) DO NOTHING;

-- Insert statuses for reservation requests
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal)
VALUES
  ('reservation_request', 'Pending', 'Awaiting review by staff', '#F59E0B', 1, TRUE, FALSE),
  ('reservation_request', 'Approved', 'Approved and reservation created', '#22C55E', 2, FALSE, TRUE),
  ('reservation_request', 'Denied', 'Request denied by staff', '#EF4444', 3, FALSE, TRUE),
  ('reservation_request', 'Cancelled', 'Cancelled by requester', '#6B7280', 4, FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- Resources table (facilities available for reservation)
CREATE TABLE resources (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  color hex_color NOT NULL DEFAULT '#3B82F6',
  capacity INT,
  hourly_rate MONEY,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reservations table (official approved bookings - CALENDAR VIEW)
CREATE TABLE reservations (
  id BIGSERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  reserved_by UUID NOT NULL REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  time_slot time_slot NOT NULL,
  purpose TEXT NOT NULL,
  attendee_count INT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_name VARCHAR(255) GENERATED ALWAYS AS (
    'Reservation #' || id || ' - ' || purpose
  ) STORED
);

-- Reservation Requests table (SOURCE OF TRUTH for approval workflow)
CREATE TABLE reservation_requests (
  id BIGSERIAL PRIMARY KEY,
  resource_id INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  time_slot time_slot NOT NULL,
  status_id INT NOT NULL DEFAULT get_initial_status('reservation_request') REFERENCES metadata.statuses(id),  -- Default to initial status ('Pending')
  purpose TEXT NOT NULL,
  attendee_count INT NOT NULL,
  notes TEXT,
  reviewed_by UUID REFERENCES metadata.civic_os_users(id),
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,
  reservation_id BIGINT UNIQUE REFERENCES reservations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  display_name VARCHAR(255) GENERATED ALWAYS AS (
    'Request #' || id || ' - ' || purpose
  ) STORED
);

-- CRITICAL: Index foreign keys
CREATE INDEX idx_reservation_requests_resource_id ON reservation_requests(resource_id);
CREATE INDEX idx_reservation_requests_requested_by ON reservation_requests(requested_by);
CREATE INDEX idx_reservation_requests_reservation_id ON reservation_requests(reservation_id);
CREATE INDEX idx_reservation_requests_status_id ON reservation_requests(status_id);
CREATE INDEX idx_reservation_requests_time_slot ON reservation_requests USING GIST(time_slot);
CREATE INDEX idx_reservations_resource_id ON reservations(resource_id);
CREATE INDEX idx_reservations_reserved_by ON reservations(reserved_by);
CREATE INDEX idx_reservations_time_slot ON reservations USING GIST(time_slot);

-- Standard Civic OS timestamp triggers
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON resources
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON resources
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- POSTGRESQL PERMISSIONS (web_anon, authenticated only)
-- ============================================================================
-- NOTE: Fine-grained RBAC (admin, editor, user roles) is handled by
-- metadata.permissions system in 02_community_center_permissions.sql

GRANT SELECT, INSERT, UPDATE, DELETE ON resources TO web_anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE resources_id_seq TO web_anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON reservation_requests TO web_anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE reservation_requests_id_seq TO web_anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON reservations TO web_anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE reservations_id_seq TO web_anon, authenticated;

-- Enable RLS
ALTER TABLE reservation_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_own_requests ON reservation_requests
  FOR SELECT
  USING (requested_by = current_user_id() OR has_permission('reservation_requests', 'read'));

CREATE POLICY insert_own_requests ON reservation_requests
  FOR INSERT
  WITH CHECK (requested_by = current_user_id());

CREATE POLICY update_requests_editors_only ON reservation_requests
  FOR UPDATE
  USING (has_permission('reservation_requests', 'update'));

-- ============================================================================
-- CONSTRAINTS
-- ============================================================================

ALTER TABLE reservations
  ADD CONSTRAINT no_overlapping_reservations
  EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&);

ALTER TABLE reservations
  ADD CONSTRAINT valid_time_slot_bounds
  CHECK (NOT isempty(time_slot) AND lower(time_slot) < upper(time_slot));

ALTER TABLE reservation_requests
  ADD CONSTRAINT valid_time_slot_bounds
  CHECK (NOT isempty(time_slot) AND lower(time_slot) < upper(time_slot));

-- ============================================================================
-- CONSTRAINT ERROR MESSAGES
-- ============================================================================

-- User-friendly error messages for constraint violations
-- Note: constraint_messages has unique constraint on constraint_name only
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'no_overlapping_reservations',
  'reservations',
  'time_slot',
  'This time slot is already booked for this facility. Please select a different time or check the calendar for availability.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'valid_time_slot_bounds',
  'reservations',
  'time_slot',
  'Invalid time slot: end time must be after start time.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

-- ============================================================================
-- METADATA CONFIGURATION
-- ============================================================================

UPDATE metadata.entities SET
  description = 'Community center facilities available for reservation'
WHERE table_name = 'resources';

UPDATE metadata.entities SET
  description = 'Pending and historical reservation requests (approval workflow)'
WHERE table_name = 'reservation_requests';

UPDATE metadata.entities SET
  show_calendar = TRUE,
  calendar_property_name = 'time_slot',
  calendar_color_property = NULL,
  description = 'Approved facility reservations (availability calendar)'
WHERE table_name = 'reservations';

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_reservation_request_to_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_reservation_id BIGINT;
  v_approved_status_id INT;
BEGIN
  -- Get the 'Approved' status ID from metadata.statuses
  SELECT id INTO v_approved_status_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  -- CASE 1: Status changed TO approved (create reservation)
  IF NEW.status_id = v_approved_status_id AND (OLD IS NULL OR OLD.status_id != v_approved_status_id) THEN
    IF NEW.reservation_id IS NULL THEN
      INSERT INTO reservations (
        resource_id, reserved_by, time_slot, purpose, attendee_count, notes
      ) VALUES (
        NEW.resource_id, NEW.requested_by, NEW.time_slot, NEW.purpose, NEW.attendee_count, NEW.notes
      ) RETURNING id INTO v_reservation_id;
      NEW.reservation_id := v_reservation_id;
    END IF;

  -- CASE 2: Status changed FROM approved (delete reservation)
  ELSIF OLD IS NOT NULL AND OLD.status_id = v_approved_status_id AND NEW.status_id != v_approved_status_id THEN
    IF NEW.reservation_id IS NOT NULL THEN
      DELETE FROM reservations WHERE id = NEW.reservation_id;
      NEW.reservation_id := NULL;
    END IF;

  -- CASE 3: Status is approved AND data changed (update reservation)
  ELSIF NEW.status_id = v_approved_status_id AND NEW.reservation_id IS NOT NULL AND OLD IS NOT NULL THEN
    IF NEW.resource_id != OLD.resource_id OR NEW.requested_by != OLD.requested_by OR
       NEW.time_slot != OLD.time_slot OR NEW.purpose != OLD.purpose OR
       NEW.attendee_count != OLD.attendee_count OR (NEW.notes IS DISTINCT FROM OLD.notes) THEN
      UPDATE reservations SET
        resource_id = NEW.resource_id, reserved_by = NEW.requested_by,
        time_slot = NEW.time_slot, purpose = NEW.purpose,
        attendee_count = NEW.attendee_count, notes = NEW.notes
      WHERE id = NEW.reservation_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_reservation
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION sync_reservation_request_to_reservation();

CREATE OR REPLACE FUNCTION set_reviewed_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_pending_status_id INT;
  v_approved_status_id INT;
  v_denied_status_id INT;
BEGIN
  -- Get status IDs from metadata.statuses
  SELECT id INTO v_pending_status_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending';
  SELECT id INTO v_approved_status_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved';
  SELECT id INTO v_denied_status_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Denied';

  -- If status changed from pending to approved/denied, set reviewed_at
  IF (OLD IS NULL OR OLD.status_id = v_pending_status_id) AND
     NEW.status_id IN (v_approved_status_id, v_denied_status_id) AND
     NEW.reviewed_at IS NULL THEN
    NEW.reviewed_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_reviewed_at
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION set_reviewed_at_timestamp();

GRANT EXECUTE ON FUNCTION sync_reservation_request_to_reservation TO authenticated;
GRANT EXECUTE ON FUNCTION set_reviewed_at_timestamp TO authenticated;

-- ============================================================================
-- SAMPLE DATA
-- ============================================================================

-- INSERT INTO resources (display_name, description, color, capacity, hourly_rate, active)
-- VALUES (
--   'Club House',
--   'Main community gathering space with kitchen, tables, and seating for 75. Perfect for parties, meetings, and events.',
--   '#3B82F6',
--   75,
--   25.00,
--   TRUE
-- );

DO $$
DECLARE
  v_user_id UUID;
  v_resource_id INT;
  v_pending_id INT;
  v_approved_id INT;
  v_denied_id INT;
BEGIN
  SELECT id INTO v_user_id FROM metadata.civic_os_users LIMIT 1;
  SELECT id INTO v_resource_id FROM resources WHERE display_name = 'Club House';
  -- Get status IDs from metadata.statuses
  SELECT id INTO v_pending_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending';
  SELECT id INTO v_approved_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Denied';

  IF v_user_id IS NOT NULL AND v_resource_id IS NOT NULL THEN
    -- Approved request (auto-creates reservation via trigger)
    INSERT INTO reservation_requests (
      resource_id, requested_by, time_slot, purpose, attendee_count, status_id, reviewed_by, reviewed_at
    ) VALUES (
      v_resource_id, v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '6 days')::timestamp + TIME '14:00',
        (CURRENT_DATE + INTERVAL '6 days')::timestamp + TIME '18:00'
      ),
      'Birthday Party', 30, v_approved_id, v_user_id, NOW() - INTERVAL '2 days'
    );

    -- Pending request
    INSERT INTO reservation_requests (resource_id, requested_by, time_slot, purpose, attendee_count, notes, status_id)
    VALUES (
      v_resource_id, v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '7 days')::timestamp + TIME '10:00',
        (CURRENT_DATE + INTERVAL '7 days')::timestamp + TIME '13:00'
      ),
      'Community Meeting', 25, 'Need tables arranged in circle, please', v_pending_id
    );

    -- Pending request (default status)
    INSERT INTO reservation_requests (resource_id, requested_by, time_slot, purpose, attendee_count)
    VALUES (
      v_resource_id, v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '3 days')::timestamp + TIME '18:00',
        (CURRENT_DATE + INTERVAL '3 days')::timestamp + TIME '21:00'
      ),
      'Book Club', 15
    );

    -- Denied request
    INSERT INTO reservation_requests (
      resource_id, requested_by, time_slot, purpose, attendee_count,
      status_id, reviewed_by, reviewed_at, denial_reason
    ) VALUES (
      v_resource_id, v_user_id,
      tstzrange(
        (CURRENT_DATE + INTERVAL '10 days')::timestamp + TIME '22:00',
        (CURRENT_DATE + INTERVAL '11 days')::timestamp + TIME '02:00'
      ),
      'Late Night Event', 50, v_denied_id, v_user_id,
      NOW() - INTERVAL '1 day', 'Club House closes at 10 PM. Please select an earlier time.'
    );
  END IF;
END $$;
