-- ============================================================================
-- ENTITY ACTION BUTTONS FOR RESERVATION REQUESTS
-- ============================================================================
-- Demonstrates: Approve/Deny/Cancel workflow using Entity Actions (v0.18.0)
--
-- Features:
--   - Status workflow transitions via RPC buttons
--   - Conditional visibility (hide buttons based on current status)
--   - Conditional enablement (disable with tooltip when not applicable)
--   - Confirmation modals before destructive actions
--   - Side effects via triggers (Approve creates reservation)
--
-- Test Scenarios:
--   | Status      | Approve    | Deny       | Cancel     |
--   |-------------|------------|------------|------------|
--   | Pending     | Enabled    | Enabled    | Enabled    |
--   | Approved    | Hidden     | Disabled   | Enabled    |
--   | Denied      | Disabled   | Hidden     | Disabled   |
--   | Cancelled   | Disabled   | Disabled   | Hidden     |
-- ============================================================================

-- ============================================================================
-- 1. RPC FUNCTIONS FOR WORKFLOW ACTIONS
-- ============================================================================

-- APPROVE: Changes status to Approved
-- Trigger will automatically create the reservation
CREATE OR REPLACE FUNCTION public.approve_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_pending_id INT;
  v_request RECORD;
BEGIN
  -- Get status IDs
  SELECT id INTO v_approved_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Pending';

  -- Get current request
  SELECT * INTO v_request FROM reservation_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Request not found');
  END IF;

  -- Validate state
  IF v_request.status_id != v_pending_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be approved');
  END IF;

  -- Update status (trigger creates reservation)
  UPDATE reservation_requests SET
    status_id = v_approved_id,
    reviewed_by = current_user_id(),
    reviewed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Request approved! Reservation has been created.',
    'refresh', true
  );
END;
$$;

-- DENY: Changes status to Denied
CREATE OR REPLACE FUNCTION public.deny_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_denied_id INT;
  v_pending_id INT;
  v_request RECORD;
BEGIN
  SELECT id INTO v_denied_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Denied';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Pending';

  SELECT * INTO v_request FROM reservation_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Request not found');
  END IF;

  IF v_request.status_id != v_pending_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be denied');
  END IF;

  UPDATE reservation_requests SET
    status_id = v_denied_id,
    reviewed_by = current_user_id(),
    reviewed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Request has been denied.',
    'refresh', true
  );
END;
$$;

-- CANCEL: Changes status to Cancelled
-- If request was approved, trigger will delete the reservation
CREATE OR REPLACE FUNCTION public.cancel_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cancelled_id INT;
  v_pending_id INT;
  v_approved_id INT;
  v_request RECORD;
BEGIN
  SELECT id INTO v_cancelled_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Pending';
  SELECT id INTO v_approved_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  SELECT * INTO v_request FROM reservation_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Request not found');
  END IF;

  IF v_request.status_id NOT IN (v_pending_id, v_approved_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending or approved requests can be cancelled');
  END IF;

  UPDATE reservation_requests SET status_id = v_cancelled_id WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Request has been cancelled.',
    'refresh', true
  );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.approve_reservation_request(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deny_reservation_request(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_reservation_request(BIGINT) TO authenticated;


-- ============================================================================
-- 2. TRIGGERS TO CREATE/DELETE RESERVATIONS ON STATUS CHANGE
-- ============================================================================
-- Uses two triggers to avoid "tuple already modified" error:
-- 1. BEFORE trigger: Creates reservation on approval (modifies NEW.reservation_id)
-- 2. AFTER trigger: Deletes reservation on cancellation (no NEW record modification)

-- BEFORE trigger: Handle reservation CREATION when approved
CREATE OR REPLACE FUNCTION handle_reservation_request_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_new_reservation_id BIGINT;
BEGIN
  SELECT id INTO v_approved_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  -- When status changes TO Approved, create reservation
  IF NEW.status_id = v_approved_id AND (OLD.status_id IS NULL OR OLD.status_id != v_approved_id) THEN
    -- Only create if no reservation exists yet
    IF NEW.reservation_id IS NULL THEN
      INSERT INTO reservations (
        resource_id,
        reserved_by,
        time_slot,
        purpose,
        attendee_count,
        notes
      ) VALUES (
        NEW.resource_id,
        NEW.requested_by,
        NEW.time_slot,
        NEW.purpose,
        NEW.attendee_count,
        NEW.notes
      )
      RETURNING id INTO v_new_reservation_id;

      -- Link reservation to request (allowed in BEFORE trigger)
      NEW.reservation_id := v_new_reservation_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- AFTER trigger: Handle reservation DELETION when cancelled
CREATE OR REPLACE FUNCTION handle_reservation_request_cancellation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cancelled_id INT;
BEGIN
  SELECT id INTO v_cancelled_id FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';

  -- When status changes TO Cancelled and reservation exists, delete it
  IF NEW.status_id = v_cancelled_id AND OLD.reservation_id IS NOT NULL THEN
    DELETE FROM reservations WHERE id = OLD.reservation_id;
    -- Clear the foreign key reference (separate UPDATE in AFTER trigger)
    UPDATE reservation_requests SET reservation_id = NULL WHERE id = NEW.id;
  END IF;

  RETURN NULL;  -- AFTER triggers return NULL
END;
$$;

-- Create triggers (drop first to avoid duplicates)
DROP TRIGGER IF EXISTS reservation_request_approval_trigger ON reservation_requests;
CREATE TRIGGER reservation_request_approval_trigger
  BEFORE UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION handle_reservation_request_approval();

DROP TRIGGER IF EXISTS reservation_request_cancellation_trigger ON reservation_requests;
CREATE TRIGGER reservation_request_cancellation_trigger
  AFTER UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION handle_reservation_request_cancellation();


-- ============================================================================
-- 3. ENTITY ACTION PERMISSION CONFIGURATION (after actions are created in section 4)
-- ============================================================================
-- Permissions are granted via entity_action_roles table.
-- See section 5 below - must be done after entity_actions are inserted.


-- ============================================================================
-- 4. ENTITY ACTIONS CONFIGURATION
-- ============================================================================
-- Use DO block to dynamically reference status IDs

DO $$
DECLARE
  v_pending_id INT;
  v_approved_id INT;
  v_denied_id INT;
  v_cancelled_id INT;
BEGIN
  -- Get status IDs (order is deterministic via sort_order)
  SELECT id INTO v_pending_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending';
  SELECT id INTO v_approved_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Denied';
  SELECT id INTO v_cancelled_id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';

  -- APPROVE action
  -- Visible when: NOT already approved (hide on approved requests)
  -- Enabled when: status is Pending
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'reservation_requests',
    'approve',
    'Approve',
    'Approve this reservation request and create the reservation',
    'approve_reservation_request',
    'check_circle',
    'primary',
    10,
    TRUE,
    'Are you sure you want to approve this request? A reservation will be created for the requested time slot.',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_approved_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_pending_id),
    'Only pending requests can be approved',
    'Request approved! Reservation has been created.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- DENY action
  -- Visible when: NOT already denied (hide on denied requests)
  -- Enabled when: status is Pending
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'reservation_requests',
    'deny',
    'Deny',
    'Deny this reservation request',
    'deny_reservation_request',
    'cancel',
    'error',
    20,
    TRUE,
    'Are you sure you want to deny this request?',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_denied_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_pending_id),
    'Only pending requests can be denied',
    'Request has been denied.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- CANCEL action
  -- Visible when: NOT already cancelled (hide on cancelled requests)
  -- Enabled when: status is Pending OR Approved
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'reservation_requests',
    'cancel',
    'Cancel',
    'Cancel this reservation request',
    'cancel_reservation_request',
    'event_busy',
    'warning',
    30,
    TRUE,
    'Are you sure you want to cancel this request? If already approved, the reservation will be deleted.',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_cancelled_id),
    jsonb_build_object('field', 'status_id', 'operator', 'in', 'value', ARRAY[v_pending_id, v_approved_id]),
    'Only pending or approved requests can be cancelled',
    'Request has been cancelled.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

END $$;


-- ============================================================================
-- 5. GRANT ENTITY ACTION PERMISSIONS TO ROLES
-- ============================================================================
-- Grant permission to execute entity actions to editor and admin roles.
-- This must be done after entity_actions are inserted (section 4).

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reservation_requests'
  AND ea.action_name IN ('approve', 'deny', 'cancel')
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 6. NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';
