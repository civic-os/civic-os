-- ============================================================================
-- MANAGER EVENTS SECURITY FIX - SECURITY INVOKER + TRIGGER CHECKS
-- ============================================================================
-- Fixes the manager_events Virtual Entity to enforce proper access control.
--
-- Problem: The original view (22_mpra_manager_events.sql) grants CRUD to
-- authenticated, but without protection, ANY authenticated user could access
-- the view via direct API calls. RLS cannot be used on VIEWs in PostgreSQL.
--
-- Solution:
--   1. Recreate view with security_invoker=true (PG15+ feature)
--      - SELECT runs as calling user, respects underlying table's RLS
--   2. Grant SELECT on underlying reservation_requests table
--      - Existing RLS policies filter: own records OR has_permission('read')
--   3. Add explicit has_permission() checks in INSTEAD OF triggers
--      - Protects INSERT/UPDATE/DELETE since triggers are SECURITY DEFINER
--
-- Trade-off: SELECT permissions come from reservation_requests RLS (admin,
-- editor, manager) rather than manager_events metadata (admin, manager only).
-- This means editors can read through this view. Acceptable per design review.
--
-- Requirements:
--   - PostgreSQL 15+ (security_invoker views)
--   - Existing reservation_requests table with RLS policies
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. RECREATE VIEW WITH SECURITY_INVOKER
-- ============================================================================
-- DROP and recreate to add the security_invoker option.
-- This makes SELECT queries run as the calling user, not the view owner.

DROP VIEW IF EXISTS public.manager_events CASCADE;

CREATE VIEW public.manager_events
WITH (security_invoker = true)
AS
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
   Uses security_invoker=true so SELECT respects reservation_requests RLS.
   INSTEAD OF triggers include explicit permission checks for DML.
   Fixed in v0.28.1 to add proper access control.';


-- ============================================================================
-- 2. GRANT SELECT ON UNDERLYING TABLE
-- ============================================================================
-- Required for security_invoker view to work. RLS policies on
-- reservation_requests will filter results appropriately.

GRANT SELECT ON public.reservation_requests TO authenticated;


-- ============================================================================
-- 3. RECREATE INSTEAD OF INSERT TRIGGER WITH PERMISSION CHECK
-- ============================================================================

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
  -- ========== PERMISSION CHECK ==========
  -- Explicit check required because SECURITY DEFINER bypasses RLS
  IF NOT has_permission('manager_events', 'create') THEN
    RAISE EXCEPTION 'Permission denied: manager_events:create required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

CREATE TRIGGER manager_events_insert
  INSTEAD OF INSERT ON manager_events
  FOR EACH ROW
  EXECUTE FUNCTION manager_events_insert_trigger();


-- ============================================================================
-- 4. RECREATE INSTEAD OF UPDATE TRIGGER WITH PERMISSION CHECK
-- ============================================================================

CREATE OR REPLACE FUNCTION public.manager_events_update_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ========== PERMISSION CHECK ==========
  IF NOT has_permission('manager_events', 'update') THEN
    RAISE EXCEPTION 'Permission denied: manager_events:update required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

CREATE TRIGGER manager_events_update
  INSTEAD OF UPDATE ON manager_events
  FOR EACH ROW
  EXECUTE FUNCTION manager_events_update_trigger();


-- ============================================================================
-- 5. RECREATE INSTEAD OF DELETE TRIGGER WITH PERMISSION CHECK
-- ============================================================================

CREATE OR REPLACE FUNCTION public.manager_events_delete_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ========== PERMISSION CHECK ==========
  IF NOT has_permission('manager_events', 'delete') THEN
    RAISE EXCEPTION 'Permission denied: manager_events:delete required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM reservation_requests WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER manager_events_delete
  INSTEAD OF DELETE ON manager_events
  FOR EACH ROW
  EXECUTE FUNCTION manager_events_delete_trigger();


-- ============================================================================
-- 6. GRANTS ON VIEW
-- ============================================================================
-- View needs grants for PostgREST to expose it. security_invoker ensures
-- SELECT respects underlying RLS; trigger checks protect DML.

GRANT SELECT, INSERT, UPDATE, DELETE ON manager_events TO authenticated;


-- ============================================================================
-- 7. RESTORE METADATA (dropped with CASCADE)
-- ============================================================================
-- Re-insert metadata that was lost when view was dropped.

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
  105,
  TRUE,
  'time_slot'
)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_calendar = EXCLUDED.show_calendar,
  calendar_property_name = EXCLUDED.calendar_property_name;

-- Property metadata
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

-- Status FK configuration
UPDATE metadata.properties
SET status_entity_type = 'reservation_request'
WHERE table_name = 'manager_events' AND column_name = 'status_id';

-- Permissions (ensure they exist)
INSERT INTO metadata.permissions (table_name, permission)
SELECT 'manager_events'::name, p.permission::metadata.permission
FROM (VALUES ('create'), ('read'), ('update'), ('delete')) AS p(permission)
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant to manager role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'manager_events'
  AND r.display_name = 'manager'
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- Grant to admin role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'manager_events'
  AND r.display_name = 'admin'
ON CONFLICT (permission_id, role_id) DO NOTHING;

-- Validations for aliased columns
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('manager_events', 'contact_name', 'required', '', 'Contact name is required', 1),
  ('manager_events', 'contact_phone', 'required', '', 'Contact phone is required', 1)
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 8. VERIFY SETUP
-- ============================================================================
DO $$
DECLARE
  v_security_invoker BOOLEAN;
  v_trigger_count INT;
BEGIN
  -- Check security_invoker is set
  SELECT (reloptions @> ARRAY['security_invoker=true']) INTO v_security_invoker
  FROM pg_class WHERE relname = 'manager_events';

  IF NOT COALESCE(v_security_invoker, FALSE) THEN
    RAISE EXCEPTION 'security_invoker not enabled on manager_events view';
  END IF;

  -- Check triggers exist
  SELECT COUNT(*) INTO v_trigger_count
  FROM pg_trigger t
  JOIN pg_class c ON t.tgrelid = c.oid
  WHERE c.relname = 'manager_events' AND NOT t.tgisinternal;

  IF v_trigger_count != 3 THEN
    RAISE EXCEPTION 'Expected 3 triggers on manager_events, found %', v_trigger_count;
  END IF;

  RAISE NOTICE 'SUCCESS: manager_events configured with security_invoker and % triggers', v_trigger_count;
END $$;

COMMIT;

-- ============================================================================
-- SECURITY SUMMARY
-- ============================================================================
--
-- SELECT: Runs as calling user due to security_invoker=true
--         → Underlying reservation_requests RLS applies
--         → Users see: own records OR has_permission('reservation_requests','read')
--         → Effective access: admin, editor, manager (+ own records for others)
--
-- INSERT: SECURITY DEFINER trigger with explicit has_permission() check
--         → Only manager_events:create permission holders
--         → Effective access: admin, manager
--
-- UPDATE: SECURITY DEFINER trigger with explicit has_permission() check
--         → Only manager_events:update permission holders
--         → Effective access: admin, manager
--
-- DELETE: SECURITY DEFINER trigger with explicit has_permission() check
--         → Only manager_events:delete permission holders
--         → Effective access: admin, manager
--
-- ============================================================================
