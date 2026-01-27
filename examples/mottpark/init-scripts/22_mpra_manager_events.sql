-- ============================================================================
-- MANAGER EVENTS - VIRTUAL ENTITY EXAMPLE (v0.28.0)
-- ============================================================================
-- Demonstrates: Virtual Entities pattern using VIEWs with INSTEAD OF triggers
--
-- Purpose:
--   Managers need a streamlined way to create events that skips the request/
--   approval friction. The form is simpler (fewer required fields, no policy
--   acknowledgment), and the event auto-transitions from Pending → Approved
--   to preserve existing trigger logic (payment creation, fee calculation).
--
-- Architecture:
--   - VIEW selects simplified columns from reservation_requests
--   - INSTEAD OF INSERT trigger fills defaults and auto-approves
--   - INSTEAD OF UPDATE/DELETE pass through to underlying table
--   - Metadata entries register view as an entity
--   - RBAC permissions restrict to manager role
--
-- Requirements:
--   - Civic OS v0.28.0+ (Virtual Entities support)
--   - Existing reservation_requests table and triggers
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. CREATE MANAGER_EVENTS VIEW
-- ============================================================================
-- Exposes only the manager-relevant fields from reservation_requests.
-- Simple column references inherit FK constraints automatically (v0.28.0).

CREATE OR REPLACE VIEW public.manager_events AS
SELECT
  -- Primary key (pass through)
  r.id,

  -- Simplified display name for managers
  COALESCE(r.organization_name, r.requestor_name) || ' - ' || r.event_type AS display_name,

  -- Core event fields (all required for manager form)
  r.event_type,
  r.time_slot,
  r.attendee_count,
  r.is_public_event,

  -- Contact info (simplified - manager provides this for public events)
  r.requestor_name AS contact_name,
  r.requestor_phone AS contact_phone,

  -- Optional fields (can be set by manager)
  r.organization_name,
  r.attendee_ages,
  r.is_food_served,

  -- Read-only status for list display
  r.status_id,

  -- Read-only timestamps
  r.created_at,
  r.updated_at

FROM reservation_requests r;

COMMENT ON VIEW public.manager_events IS
  'Virtual Entity for streamlined manager event creation.
   Simplified form bypasses policy agreement and auto-approves on insert.
   Uses INSTEAD OF triggers to insert into reservation_requests.
   Added in v0.28.0 as Virtual Entities example.';


-- ============================================================================
-- 2. INSTEAD OF INSERT TRIGGER
-- ============================================================================
-- Fills in defaults and creates an auto-approved reservation.

CREATE OR REPLACE FUNCTION public.manager_events_insert_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_id BIGINT;
  v_approved_status_id INT;
  v_current_user UUID;
BEGIN
  -- Get current user
  v_current_user := current_user_id();

  -- Get Approved status ID for auto-approval
  SELECT id INTO v_approved_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  -- Insert into reservation_requests with filled defaults
  INSERT INTO reservation_requests (
    -- From form (required)
    event_type,
    time_slot,
    attendee_count,
    is_public_event,
    requestor_name,
    requestor_phone,

    -- From form (optional)
    organization_name,
    attendee_ages,
    is_food_served,

    -- Auto-filled defaults (manager creates = skip approval flow)
    requestor_id,
    requestor_address,
    policy_agreed,
    reviewed_by,

    -- Start as Pending (triggers will still fire on status change)
    status_id
  ) VALUES (
    NEW.event_type,
    NEW.time_slot,
    NEW.attendee_count,
    COALESCE(NEW.is_public_event, FALSE),
    COALESCE(NEW.contact_name, 'Manager Event'),
    COALESCE(NEW.contact_phone, '(000) 000-0000'),

    NEW.organization_name,
    NEW.attendee_ages,
    COALESCE(NEW.is_food_served, FALSE),

    -- Manager is requestor
    v_current_user,
    -- Placeholder address (not relevant for manager-created events)
    'Internal - Manager Created',
    -- Skip policy agreement (manager-created)
    TRUE,
    -- Auto-reviewed by creating manager
    v_current_user,

    -- Insert as Pending first (required for status workflow)
    get_initial_status('reservation_request')
  )
  RETURNING id INTO v_new_id;

  -- Auto-approve: Update to Approved status
  -- This triggers on_reservation_approved() which:
  -- 1. Calculates facility fee (holiday/weekend pricing)
  -- 2. Sets is_holiday_or_weekend flag
  -- 3. Creates payment records via create_reservation_payments()
  UPDATE reservation_requests
  SET status_id = v_approved_status_id
  WHERE id = v_new_id;

  -- Set NEW.id so caller can retrieve the created record
  NEW.id := v_new_id;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.manager_events_insert_trigger() IS
  'INSTEAD OF INSERT trigger for manager_events view.
   Fills defaults (policy_agreed, requestor_id) and auto-approves.
   Preserves existing approval triggers for payment creation.
   Added in v0.28.0.';

CREATE TRIGGER manager_events_insert
  INSTEAD OF INSERT ON manager_events
  FOR EACH ROW
  EXECUTE FUNCTION manager_events_insert_trigger();


-- ============================================================================
-- 3. INSTEAD OF UPDATE TRIGGER
-- ============================================================================
-- Pass through updates to the underlying reservation_requests table.

CREATE OR REPLACE FUNCTION public.manager_events_update_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update only the fields exposed by the view
  UPDATE reservation_requests
  SET
    event_type = NEW.event_type,
    time_slot = NEW.time_slot,
    attendee_count = NEW.attendee_count,
    is_public_event = NEW.is_public_event,
    requestor_name = NEW.contact_name,
    requestor_phone = NEW.contact_phone,
    organization_name = NEW.organization_name,
    attendee_ages = NEW.attendee_ages,
    is_food_served = NEW.is_food_served
  WHERE id = OLD.id;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.manager_events_update_trigger() IS
  'INSTEAD OF UPDATE trigger for manager_events view.
   Updates corresponding reservation_requests record.
   Added in v0.28.0.';

CREATE TRIGGER manager_events_update
  INSTEAD OF UPDATE ON manager_events
  FOR EACH ROW
  EXECUTE FUNCTION manager_events_update_trigger();


-- ============================================================================
-- 4. INSTEAD OF DELETE TRIGGER
-- ============================================================================
-- Pass through deletes to the underlying reservation_requests table.

CREATE OR REPLACE FUNCTION public.manager_events_delete_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM reservation_requests WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.manager_events_delete_trigger() IS
  'INSTEAD OF DELETE trigger for manager_events view.
   Deletes corresponding reservation_requests record.
   Added in v0.28.0.';

CREATE TRIGGER manager_events_delete
  INSTEAD OF DELETE ON manager_events
  FOR EACH ROW
  EXECUTE FUNCTION manager_events_delete_trigger();


-- ============================================================================
-- 5. GRANTS
-- ============================================================================
-- View needs SELECT for list/detail and INSERT/UPDATE/DELETE for CRUD.

GRANT SELECT, INSERT, UPDATE, DELETE ON manager_events TO authenticated;


-- ============================================================================
-- 6. METADATA REGISTRATION (REQUIRED FOR VIRTUAL ENTITIES)
-- ============================================================================
-- VIEWs are NOT auto-discovered; they require explicit metadata.entities entry.

INSERT INTO metadata.entities (
  table_name,
  display_name,
  description,
  sort_order,
  show_calendar,
  calendar_property_name
) VALUES (
  'manager_events',
  'Manager Events',
  'Streamlined event creation for managers. Auto-approved with simplified form.',
  105,  -- After reservation_requests in menu
  TRUE,
  'time_slot'
)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_calendar = EXCLUDED.show_calendar,
  calendar_property_name = EXCLUDED.calendar_property_name;


-- ============================================================================
-- 7. PROPERTY METADATA (Customize form display)
-- ============================================================================

-- Hide id and timestamps from forms
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail, sort_order)
VALUES
  ('manager_events', 'id', FALSE, FALSE, FALSE, FALSE, 0),
  ('manager_events', 'created_at', FALSE, FALSE, FALSE, TRUE, 100),
  ('manager_events', 'updated_at', FALSE, FALSE, FALSE, TRUE, 101)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  sort_order = EXCLUDED.sort_order;

-- Configure visible properties
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, column_width, filterable)
VALUES
  ('manager_events', 'display_name', 'Event', 1, TRUE, FALSE, FALSE, TRUE, 2, FALSE),
  ('manager_events', 'event_type', 'Event Type', 2, TRUE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'time_slot', 'Date & Time', 3, TRUE, TRUE, TRUE, TRUE, 2, FALSE),
  ('manager_events', 'attendee_count', 'Attendees', 4, TRUE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'is_public_event', 'Public Event', 5, TRUE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'contact_name', 'Contact Name', 6, FALSE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'contact_phone', 'Contact Phone', 7, FALSE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'organization_name', 'Organization', 8, TRUE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'attendee_ages', 'Age Groups', 9, FALSE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'is_food_served', 'Food Served', 10, FALSE, TRUE, TRUE, TRUE, 1, FALSE),
  ('manager_events', 'status_id', 'Status', 11, TRUE, FALSE, FALSE, TRUE, 1, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  column_width = EXCLUDED.column_width,
  filterable = EXCLUDED.filterable;

-- Configure status_id FK (VIEW columns don't have FK constraints, need manual config)
-- NOTE: This uses the new v0.28.0 join_table/join_column override feature
UPDATE metadata.properties
SET
  status_entity_type = 'reservation_request'  -- Tells frontend which statuses to load
WHERE table_name = 'manager_events' AND column_name = 'status_id';


-- ============================================================================
-- 8. RBAC PERMISSIONS (Manager-only access)
-- ============================================================================
-- Create permission entries for the virtual entity and grant to manager role.

-- Ensure permissions exist
INSERT INTO metadata.permissions (table_name, permission)
SELECT 'manager_events'::name, p.permission::metadata.permission
FROM (VALUES ('create'), ('read'), ('update'), ('delete')) AS p(permission)
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant all permissions to manager role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'manager_events'
  AND r.display_name = 'manager'
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- Also grant to admin role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'manager_events'
  AND r.display_name = 'admin'
ON CONFLICT (permission_id, role_id) DO NOTHING;


-- ============================================================================
-- 9. VALIDATION RULES (Frontend validation with inheritance)
-- ============================================================================
-- v0.28.0 Validation Inheritance:
--   - Columns with MATCHING NAMES inherit validations from base table automatically
--   - Columns with ALIASES (e.g., requestor_name AS contact_name) need explicit rules
--
-- In this VIEW:
--   - event_type, time_slot, attendee_count → INHERIT from reservation_requests
--   - contact_name (alias for requestor_name) → EXPLICIT validation needed
--   - contact_phone (alias for requestor_phone) → EXPLICIT validation needed
--
-- Note: If base table validations change, inherited validations update automatically.
--       Explicit validations here override any inherited rules (all-or-nothing per column).

-- Explicit validations for aliased columns only
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('manager_events', 'contact_name', 'required', '', 'Contact name is required', 1),
  ('manager_events', 'contact_phone', 'required', '', 'Contact phone is required', 1)
ON CONFLICT DO NOTHING;


COMMIT;

-- ============================================================================
-- USAGE NOTES
-- ============================================================================
--
-- 1. Navigate to /view/manager_events to see the list of manager events
-- 2. Click "New" to create an event with the simplified form
-- 3. Events are auto-approved on creation (payment records created automatically)
-- 4. Events appear on the shared calendar alongside regular reservation requests
-- 5. Double-booking prevention works across both entry points (same underlying table)
--
-- To remove this feature:
--   DROP VIEW public.manager_events CASCADE;
--   DELETE FROM metadata.entities WHERE table_name = 'manager_events';
--   DELETE FROM metadata.properties WHERE table_name = 'manager_events';
--   DELETE FROM metadata.permissions WHERE table_name = 'manager_events';
-- ============================================================================
