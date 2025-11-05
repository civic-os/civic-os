-- =============================================================================================================
-- CIVIC OS APPLICATION: COMMUNITY CENTER RESERVATIONS
-- =============================================================================================================

-- Generated: 2025-11-02
-- Example: community-center
--
-- This file contains application-specific tables, permissions, and configuration for the
-- Community Center Reservations example.
--
-- PREREQUISITES:
--   1. Civic OS core schema must be deployed first via Sqitch migrations (v0.9.0+)
--   2. PostgreSQL 17+ with PostGIS extension
--   3. Authenticator role must be created
--   4. time_slot domain must exist (from v0.9.0 migration)
--   5. btree_gist extension must be enabled (from v0.9.0 migration)
--
-- To deploy core Civic OS schema:
--   docker run --rm -e PGRST_DB_URI="your-connection-string" \
--     ghcr.io/civic-os/migrations:v0.9.0 deploy
--
-- After core deployment, run this SQL file to set up the Community Center application.

-- =============================================================================================================
-- SCHEMA: TABLES, TRIGGERS, CONSTRAINTS
-- =============================================================================================================

-- ============================================================================
-- COMMUNITY CENTER RESERVATIONS EXAMPLE
-- Demonstrates: TimeSlot property type, calendar views, approval workflows
-- ============================================================================

-- Request Statuses lookup table
CREATE TABLE request_statuses (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  color hex_color NOT NULL,
  emoji VARCHAR(10),
  sort_order INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert standard statuses
INSERT INTO request_statuses (display_name, description, color, emoji, sort_order) VALUES
  ('Pending', 'Awaiting review by staff', '#F59E0B', '⏳', 1),
  ('Approved', 'Approved and reservation created', '#22C55E', '✓', 2),
  ('Denied', 'Request denied by staff', '#EF4444', '✗', 3),
  ('Cancelled', 'Cancelled by requester', '#6B7280', '🚫', 4);

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
  requested_by UUID NOT NULL DEFAULT public.current_user_id() REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  time_slot time_slot NOT NULL,
  status_id INT NOT NULL DEFAULT 1 REFERENCES request_statuses(id),  -- Default to 'Pending' (id=1)
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
  BEFORE INSERT ON request_statuses
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON request_statuses
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

GRANT SELECT, INSERT, UPDATE, DELETE ON request_statuses TO web_anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE request_statuses_id_seq TO web_anon, authenticated;

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
  USING (requested_by = public.current_user_id() OR public.has_permission('reservation_requests', 'read'));

CREATE POLICY insert_own_requests ON reservation_requests
  FOR INSERT
  WITH CHECK (requested_by = public.current_user_id());

CREATE POLICY update_requests_editors_only ON reservation_requests
  FOR UPDATE
  USING (public.has_permission('reservation_requests', 'update'));

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
  -- Get the 'Approved' status ID (should be 2)
  SELECT id INTO v_approved_status_id FROM request_statuses WHERE display_name = 'Approved';

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
  -- Get status IDs
  SELECT id INTO v_pending_status_id FROM request_statuses WHERE display_name = 'Pending';
  SELECT id INTO v_approved_status_id FROM request_statuses WHERE display_name = 'Approved';
  SELECT id INTO v_denied_status_id FROM request_statuses WHERE display_name = 'Denied';

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

INSERT INTO resources (display_name, description, color, capacity, hourly_rate, active)
VALUES (
  'Club House',
  'Main community gathering space with kitchen, tables, and seating for 75. Perfect for parties, meetings, and events.',
  '#3B82F6',
  75,
  25.00,
  TRUE
);

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
  SELECT id INTO v_pending_id FROM request_statuses WHERE display_name = 'Pending';
  SELECT id INTO v_approved_id FROM request_statuses WHERE display_name = 'Approved';
  SELECT id INTO v_denied_id FROM request_statuses WHERE display_name = 'Denied';

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
-- =====================================================
-- Community Center Reservations - Permissions
-- =====================================================
-- This script creates RBAC permissions for the community center tables
-- Permission Model:
--   - anonymous: Read-only access to resources and reservations
--   - user: Can view resources/reservations, create own reservation requests
--   - editor: Can approve/deny reservation requests (update)
--   - admin: Full CRUD access to all tables

-- =====================================================
-- CREATE PERMISSIONS
-- =====================================================

-- Create permissions for all community center tables
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('request_statuses', 'read'),
  ('request_statuses', 'create'),
  ('request_statuses', 'update'),
  ('request_statuses', 'delete'),
  ('resources', 'read'),
  ('resources', 'create'),
  ('resources', 'update'),
  ('resources', 'delete'),
  ('reservation_requests', 'read'),
  ('reservation_requests', 'create'),
  ('reservation_requests', 'update'),
  ('reservation_requests', 'delete'),
  ('reservations', 'read'),
  ('reservations', 'create'),
  ('reservations', 'update'),
  ('reservations', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- =====================================================
-- MAP PERMISSIONS TO ROLES
-- =====================================================

-- Grant read permission to all roles for request_statuses, resources, and reservations
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('request_statuses', 'resources', 'reservations')
  AND p.permission = 'read'
  AND r.display_name IN ('anonymous', 'user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant CUD on request_statuses to admins only (lookup table)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'request_statuses'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Grant read permission to reservation_requests for authenticated users (they see own via RLS)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create permission to authenticated users for reservation_requests
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant update permission to editors and admins for reservation_requests (approve/deny)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'update'
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create/update/delete to editors and admins for resources
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'resources'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant delete to admins only for reservation_requests and reservations
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('reservation_requests', 'reservations')
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- TEXT SEARCH CONFIGURATION
-- Adds full-text search to community center tables
-- ============================================================================

-- Add text search to resources
ALTER TABLE resources
  ADD COLUMN civic_os_text_search TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED;

CREATE INDEX idx_resources_text_search ON resources USING GIN (civic_os_text_search);

UPDATE metadata.entities
SET search_fields = ARRAY['display_name', 'description']
WHERE table_name = 'resources';

-- Add text search to reservations
ALTER TABLE reservations
  ADD COLUMN civic_os_text_search TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(purpose, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(notes, '')), 'B')
    ) STORED;

CREATE INDEX idx_reservations_text_search ON reservations USING GIN (civic_os_text_search);

UPDATE metadata.entities
SET search_fields = ARRAY['purpose', 'notes']
WHERE table_name = 'reservations';

-- Add text search to reservation_requests
ALTER TABLE reservation_requests
  ADD COLUMN civic_os_text_search TSVECTOR
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(purpose, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(notes, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(denial_reason, '')), 'C')
    ) STORED;

CREATE INDEX idx_reservation_requests_text_search ON reservation_requests USING GIN (civic_os_text_search);

UPDATE metadata.entities
SET search_fields = ARRAY['purpose', 'notes', 'denial_reason']
WHERE table_name = 'reservation_requests';
-- =====================================================
-- Community Center - Metadata Enhancements
-- =====================================================
-- Improves display names, descriptions, and creates custom dashboard
-- This script makes the UI more user-friendly and example-specific

-- =====================================================
-- ENTITY METADATA (Display Names, Descriptions, Sort Order)
-- =====================================================

-- Request Statuses entity (lookup table)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('request_statuses', 'Request Statuses', 'Status values for reservation requests (pending, approved, denied, cancelled)', 0)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Resources entity
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('resources', 'Resources', 'Community center facilities available for reservation (meeting rooms, event spaces, etc.)', 1)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Reservation Requests entity
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('reservation_requests', 'Reservation Requests', 'Member booking requests pending approval, denial, or already processed', 2)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Reservations entity (with calendar configuration)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_calendar, calendar_property_name, calendar_color_property)
VALUES ('reservations', 'Reservations', 'Approved facility bookings shown in calendar view', 3, TRUE, 'time_slot', NULL)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_calendar = EXCLUDED.show_calendar,
  calendar_property_name = EXCLUDED.calendar_property_name,
  calendar_color_property = EXCLUDED.calendar_color_property;

-- =====================================================
-- PROPERTY METADATA (Resources Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order)
VALUES
  ('resources', 'display_name', 'Facility Name', 'Name of the community center facility', 1),
  ('resources', 'description', 'Description', 'Details about the facility and amenities', 2),
  ('resources', 'color', 'Display Color', 'Color used for this resource in calendars and maps', 3),
  ('resources', 'capacity', 'Capacity', 'Maximum number of people allowed', 4),
  ('resources', 'hourly_rate', 'Hourly Rate', 'Cost per hour to reserve this facility', 5),
  ('resources', 'active', 'Active', 'Whether this facility is currently available for booking', 6),
  ('resources', 'created_at', 'Created', 'When this facility was added to the system', 7),
  ('resources', 'updated_at', 'Last Updated', 'When this facility information was last modified', 8)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- =====================================================
-- PROPERTY METADATA (Reservation Requests Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_create)
VALUES
  ('reservation_requests', 'display_name', 'Request', 'Auto-generated request summary', 1, 1, FALSE),
  ('reservation_requests', 'status_id', 'Status', 'Current state: pending, approved, denied, or cancelled', 2, 1, FALSE),
  ('reservation_requests', 'resource_id', 'Facility', 'Which facility is being requested', 3, 1, TRUE),
  ('reservation_requests', 'time_slot', 'Requested Time', 'Start and end date/time for the reservation', 4, 2, TRUE),
  ('reservation_requests', 'purpose', 'Purpose', 'What the facility will be used for', 5, 2, TRUE),
  ('reservation_requests', 'attendee_count', 'Expected Attendees', 'How many people will attend the event', 6, 1, TRUE),
  ('reservation_requests', 'notes', 'Special Requests', 'Additional details or setup requirements', 7, 2, TRUE),
  ('reservation_requests', 'requested_by', 'Requested By', 'Community member who submitted this request', 8, 1, FALSE),
  ('reservation_requests', 'reviewed_by', 'Reviewed By', 'Staff member who approved or denied this request', 9, 1, FALSE),
  ('reservation_requests', 'reviewed_at', 'Review Date', 'When this request was approved or denied', 10, 1, FALSE),
  ('reservation_requests', 'denial_reason', 'Denial Reason', 'Explanation for why this request was denied', 11, 2, FALSE),
  ('reservation_requests', 'reservation_id', 'Reservation', 'Link to approved reservation (if approved)', 12, 1, FALSE),
  ('reservation_requests', 'created_at', 'Created At', 'When this request was first created', 13, 1, FALSE),
  ('reservation_requests', 'updated_at', 'Updated At', 'When this request was last modified', 14, 1, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_create = EXCLUDED.show_on_create;

-- =====================================================
-- PROPERTY METADATA (Reservations Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_create)
VALUES
  ('reservations', 'display_name', 'Reservation', 'Auto-generated reservation summary', 1, 1, FALSE),
  ('reservations', 'resource_id', 'Facility', 'Which facility is reserved', 2, 1, TRUE),
  ('reservations', 'time_slot', 'Reserved Time', 'Start and end date/time for this booking', 3, 2, TRUE),
  ('reservations', 'purpose', 'Event Purpose', 'What the facility will be used for', 4, 2, TRUE),
  ('reservations', 'attendee_count', 'Expected Attendees', 'How many people will attend', 5, 1, TRUE),
  ('reservations', 'notes', 'Setup Notes', 'Special setup or equipment requirements', 6, 2, TRUE),
  ('reservations', 'reserved_by', 'Reserved By', 'Community member who booked this facility', 7, 1, FALSE),
  ('reservations', 'created_at', 'Created At', 'When this reservation was first created', 8, 1, FALSE),
  ('reservations', 'updated_at', 'Updated At', 'When this reservation was last modified', 9, 1, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_create = EXCLUDED.show_on_create;

-- =====================================================
-- CUSTOM DASHBOARD
-- =====================================================

DO $$
DECLARE
  v_dashboard_id INT;
  v_user_id UUID;
BEGIN
  -- Get first user (or could use a specific admin user)
  SELECT id INTO v_user_id FROM metadata.civic_os_users LIMIT 1;

  -- Only create dashboard if we have a user
  IF v_user_id IS NOT NULL THEN
    -- Create dashboard
    INSERT INTO metadata.dashboards (
      display_name,
      description,
      is_public,
      created_by,
      sort_order
    ) VALUES (
      'Community Center Overview',
      'Facility reservations, pending requests, and resource availability',
      TRUE,  -- Public dashboard (visible to all users)
      v_user_id,
      1
    )
    ON CONFLICT (display_name) DO UPDATE SET
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order
    RETURNING id INTO v_dashboard_id;

    -- Delete existing panels for this dashboard (in case we're re-running)
    DELETE FROM metadata.dashboard_panels WHERE dashboard_id = v_dashboard_id;

    -- Panel 1: Pending Requests (Top Priority)
    INSERT INTO metadata.dashboard_panels (
      dashboard_id,
      panel_type,
      entity_name,
      title,
      description,
      filters,
      sort_order,
      width_columns,
      height_rows
    ) VALUES (
      v_dashboard_id,
      'list',
      'reservation_requests',
      'Pending Approval',
      'Reservation requests awaiting review',
      '[{"column": "status_id", "operator": "eq", "value": "1"}]'::JSONB,
      1,
      2,  -- Full width
      1   -- Standard height
    );

    -- Panel 2: Upcoming Reservations
    INSERT INTO metadata.dashboard_panels (
      dashboard_id,
      panel_type,
      entity_name,
      title,
      description,
      filters,
      sort_order,
      width_columns,
      height_rows
    ) VALUES (
      v_dashboard_id,
      'calendar',
      'reservations',
      'Upcoming Reservations',
      'Calendar view of all approved bookings',
      NULL,  -- No filters, show all
      2,
      2,  -- Full width
      2   -- Taller for calendar
    );

    -- Panel 3: Available Facilities
    INSERT INTO metadata.dashboard_panels (
      dashboard_id,
      panel_type,
      entity_name,
      title,
      description,
      filters,
      sort_order,
      width_columns,
      height_rows
    ) VALUES (
      v_dashboard_id,
      'list',
      'resources',
      'Available Facilities',
      'Community center spaces available for reservation',
      '[{"column": "active", "operator": "eq", "value": "true"}]'::JSONB,
      3,
      1,  -- Half width
      1
    );

    -- Panel 4: Recent Requests
    INSERT INTO metadata.dashboard_panels (
      dashboard_id,
      panel_type,
      entity_name,
      title,
      description,
      filters,
      sort_order,
      width_columns,
      height_rows
    ) VALUES (
      v_dashboard_id,
      'list',
      'reservation_requests',
      'Recent Requests',
      'Latest reservation requests (all statuses)',
      NULL,  -- No filters, show recent
      4,
      1,  -- Half width
      1
    );

    RAISE NOTICE 'Dashboard "Community Center Overview" created successfully with ID %', v_dashboard_id;
  ELSE
    RAISE NOTICE 'No users found - skipping dashboard creation';
  END IF;
END $$;

-- =====================================================
-- UPDATE WELCOME DASHBOARD
-- =====================================================

-- Update the default Welcome dashboard with Community Center-specific content
UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
  'content', E'# Welcome to Community Center Reservations

This demo showcases Civic OS\'s **calendar integration** features with a facility reservation and approval workflow.

## Quick Start

1. **Browse Facilities** - Visit `/view/resources` to see available spaces (Club House, etc.)
2. **View Calendar** - Go to `/view/reservations` and click the **Calendar** tab to see approved bookings
3. **Request a Reservation** - Click "Create" on Reservation Requests to submit a booking request
4. **Approval Workflow** - Editors can review pending requests and approve/deny them

## Key Features Demonstrated

### 📅 Calendar Integration
- **List Page Calendar View**: Toggle between table and calendar views
- **TimeSlot Property Type**: Start/end time picker with timezone support
- **Detail Page Calendars**: See related bookings on resource detail pages
- **Click to Create**: Click/drag on calendar to pre-fill time slots

### ✅ Approval Workflow
- **Status Tracking**: Requests flow from Pending → Approved/Denied
- **Database Triggers**: Approved requests automatically create reservations
- **Row-Level Security**: Users see only their own requests
- **Conflict Prevention**: Exclusion constraints prevent double-booking

### 🎨 Metadata Polish
- **Custom Dashboard**: "Community Center Overview" shows pending requests and upcoming events
- **Smart Defaults**: Status and requested_by fields auto-filled on create
- **Field Visibility**: System fields hidden from create forms

## Try These Tasks

- **Submit a Request**: Create a reservation request for the Club House
- **Approve a Request** (requires editor role): Change status from "Pending" to "Approved" and watch the reservation appear in the calendar
- **Check for Conflicts**: Try creating overlapping reservations (database will reject them)
- **Explore the Schema**: Visit `/schema-editor` to see the ERD and trigger logic

## Technical Details

- **Database**: PostgreSQL 17 + PostGIS + btree_gist extension
- **Core Domain**: `time_slot` (tstzrange) for appointment scheduling
- **Constraint**: `EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&)` prevents overlaps
- **Triggers**: Auto-sync between reservation_requests ↔ reservations tables

---

📖 **Documentation**: See `examples/community-center/README.md` for complete setup guide and technical reference.',
  'enableHtml', false
)
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome' LIMIT 1)
  AND widget_type = 'markdown';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
