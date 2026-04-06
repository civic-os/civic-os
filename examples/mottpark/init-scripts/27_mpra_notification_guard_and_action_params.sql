-- =============================================================================
-- Mott Park: Notification guard + parameterized Deny/Cancel entity actions
-- Requires: Civic OS v0.36.0+ (entity_action_params, get_status_id, send_notification_to_role)
--
-- 1. Guard new-request notification trigger to only fire for Pending status
-- 2. Add denial_reason parameter to deny_reservation_request RPC
-- 3. Add cancellation_reason parameter to cancel_reservation_request RPC
-- 4. Register Deny and Cancel as entity action buttons with reason params
-- 5. Record schema decision (ADR)
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: Guard the notification trigger
-- Originally: 01_mpra_reservations_schema.sql
-- Latest: 24_role_key_patch.sql (send_notification_to_role)
-- Change: Skip notification if status is not Pending
-- =============================================================================

CREATE OR REPLACE FUNCTION notify_new_reservation_request()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request_data JSONB;
BEGIN
  -- Only notify for requests in Pending status.
  -- Recurring/bulk-created requests may bypass Pending, and those
  -- don't need manager review notifications.
  IF NEW.status_id != get_status_id('reservation_request', 'pending') THEN
    RETURN NEW;
  END IF;

  -- Build request data (pass raw time_slot - Go service handles formatting/timezone)
  SELECT jsonb_build_object(
    'id', NEW.id,
    'requestor_name', NEW.requestor_name,
    'organization_name', NEW.organization_name,
    'event_type', NEW.event_type,
    'time_slot', NEW.time_slot::TEXT,
    'attendee_count', NEW.attendee_count
  ) INTO v_request_data;

  -- Notify all managers and admins
  PERFORM metadata.send_notification_to_role(
    p_role_keys     := ARRAY['manager', 'admin'],
    p_template_name := 'reservation_request_submitted',
    p_entity_type   := 'reservation_requests',
    p_entity_id     := NEW.id::text,
    p_entity_data   := v_request_data,
    p_channels      := ARRAY['email']::TEXT[]
  );

  RETURN NEW;
END;
$$;


-- =============================================================================
-- PART 2: Upgrade deny_reservation_request with reason parameter
-- Originally: 04_mpra_new_features.sql
-- Change: Add p_denial_reason TEXT, set denial_reason on UPDATE
-- =============================================================================

DROP FUNCTION IF EXISTS deny_reservation_request(bigint);

CREATE FUNCTION deny_reservation_request(p_entity_id BIGINT, p_denial_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_denied_status_id INT;
BEGIN
  v_denied_status_id := get_status_id('reservation_request', 'denied');

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Pending
  IF v_request.status_id != get_status_id('reservation_request', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be denied');
  END IF;

  -- Check user has manager or admin role
  IF NOT (has_permission('reservation_requests', 'update') AND
          ('manager' = ANY(get_user_roles()) OR is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to deny requests');
  END IF;

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_denied_status_id,
    denial_reason = p_denial_reason,
    reviewed_by = current_user_id(),
    reviewed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Request has been denied. The requestor will be notified.',
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION deny_reservation_request(bigint, text) TO authenticated;


-- =============================================================================
-- PART 3: Upgrade cancel_reservation_request with reason parameter
-- Originally: 04_mpra_new_features.sql
-- Latest: 17_mpra_cancel_waives_pending.sql (auto-cancel pending payments)
-- Change: Add p_cancellation_reason TEXT, set cancellation_reason on UPDATE
-- =============================================================================

DROP FUNCTION IF EXISTS cancel_reservation_request(bigint);

CREATE FUNCTION cancel_reservation_request(p_entity_id BIGINT, p_cancellation_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_cancelled_request_status_id INT;
  v_cancelled_payment_status_id INT;
  v_pending_payment_status_id INT;
  v_paid_status_id INT;
  v_paid_payments INT;
  v_cancelled_payments INT;
BEGIN
  -- Get status IDs using stable status_key
  v_cancelled_request_status_id := get_status_id('reservation_request', 'cancelled');
  v_cancelled_payment_status_id := get_status_id('reservation_payment', 'cancelled');
  v_pending_payment_status_id := get_status_id('reservation_payment', 'pending');
  v_paid_status_id := get_status_id('reservation_payment', 'paid');

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Pending, Approved, or Secured
  IF v_request.status_id NOT IN (
    get_status_id('reservation_request', 'pending'),
    get_status_id('reservation_request', 'approved'),
    get_status_id('reservation_request', 'secured')
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending, approved, or secured requests can be cancelled');
  END IF;

  -- Check user has manager or admin role
  IF NOT (public.has_permission('reservation_requests', 'update') AND
          ('manager' = ANY(public.get_user_roles()) OR public.is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to cancel requests');
  END IF;

  -- Count paid payments that may need refund
  SELECT COUNT(*) INTO v_paid_payments
  FROM reservation_payments
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_paid_status_id;

  -- Update the request status
  UPDATE reservation_requests SET
    status_id = v_cancelled_request_status_id,
    cancellation_reason = p_cancellation_reason,
    cancelled_by = current_user_id(),
    cancelled_at = NOW()
  WHERE id = p_entity_id;

  -- AUTO-CANCEL all pending payments
  UPDATE reservation_payments SET
    status_id = v_cancelled_payment_status_id
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_pending_payment_status_id;

  GET DIAGNOSTICS v_cancelled_payments = ROW_COUNT;

  -- Build response message
  IF v_paid_payments > 0 AND v_cancelled_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. %s pending payment(s) cancelled. Note: %s paid payment(s) may require refund processing.', v_cancelled_payments, v_paid_payments),
      'refresh', true
    );
  ELSIF v_paid_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. Note: %s payment(s) may require refund processing.', v_paid_payments),
      'refresh', true
    );
  ELSIF v_cancelled_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. %s pending payment(s) cancelled. The requestor will be notified.', v_cancelled_payments),
      'refresh', true
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Request has been cancelled. The requestor will be notified.',
      'refresh', true
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_reservation_request(bigint, text) TO authenticated;


-- =============================================================================
-- PART 4: Register Deny and Cancel entity action buttons
-- =============================================================================

INSERT INTO metadata.entity_actions (
  table_name,
  action_name,
  display_name,
  description,
  rpc_function,
  icon,
  button_style,
  sort_order,
  requires_confirmation,
  confirmation_message,
  visibility_condition,
  enabled_condition,
  disabled_tooltip,
  refresh_after_action,
  show_on_detail
) VALUES
  -- DENY button (visible only on Pending requests)
  (
    'reservation_requests',
    'deny',
    'Deny',
    'Deny this reservation request',
    'deny_reservation_request',
    'block',
    'error',
    20,
    TRUE,
    'Are you sure you want to deny this reservation request?',
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND status_key = 'pending'),
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND status_key = 'pending'),
    'Only pending requests can be denied',
    TRUE,
    TRUE
  ),
  -- CANCEL button (visible on Pending, Approved, or Secured requests)
  (
    'reservation_requests',
    'cancel',
    'Cancel',
    'Cancel this reservation request',
    'cancel_reservation_request',
    'cancel',
    'warning',
    30,
    TRUE,
    'Are you sure you want to cancel this reservation?',
    (SELECT jsonb_build_object(
      'field', 'status_id',
      'operator', 'in',
      'value', jsonb_build_array(
        get_status_id('reservation_request', 'pending'),
        get_status_id('reservation_request', 'approved'),
        get_status_id('reservation_request', 'secured')
      )
    )),
    (SELECT jsonb_build_object(
      'field', 'status_id',
      'operator', 'in',
      'value', jsonb_build_array(
        get_status_id('reservation_request', 'pending'),
        get_status_id('reservation_request', 'approved'),
        get_status_id('reservation_request', 'secured')
      )
    )),
    'Only pending, approved, or secured requests can be cancelled',
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


-- =============================================================================
-- PART 5: Register action parameters (reason fields)
-- =============================================================================

-- Denial Reason for Deny action
INSERT INTO metadata.entity_action_params (
  entity_action_id,
  param_name,
  display_name,
  param_type,
  required,
  sort_order,
  placeholder
)
SELECT
  ea.id,
  'p_denial_reason',
  'Denial Reason',
  'text',
  TRUE,
  10,
  'Enter reason for denial...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'reservation_requests'
  AND ea.action_name = 'deny'
ON CONFLICT DO NOTHING;

-- Cancellation Reason for Cancel action
INSERT INTO metadata.entity_action_params (
  entity_action_id,
  param_name,
  display_name,
  param_type,
  required,
  sort_order,
  placeholder
)
SELECT
  ea.id,
  'p_cancellation_reason',
  'Cancellation Reason',
  'text',
  TRUE,
  10,
  'Enter reason for cancellation...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'reservation_requests'
  AND ea.action_name = 'cancel'
ON CONFLICT DO NOTHING;


-- =============================================================================
-- PART 6: Grant action permissions to manager and admin roles
-- =============================================================================

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reservation_requests'
  AND r.role_key IN ('manager', 'admin')
ON CONFLICT DO NOTHING;


COMMIT;

-- =============================================================================
-- PART 7: Schema Decision (ADR)
-- Outside the main transaction so a failure here can't roll back functional changes.
-- Direct INSERT because create_schema_decision() requires JWT admin context.
-- =============================================================================

-- =============================================================================
-- PART 8: Hide generated display_name from create/edit forms
-- The display_name column is GENERATED ALWAYS, so it can't be written to.
-- schema_properties auto-infers show_on_create/edit=true from the column,
-- but validate_entity_template checks metadata.properties (which has no row).
-- This override prevents the recurring template wizard from including it.
-- =============================================================================

INSERT INTO metadata.properties (table_name, column_name, show_on_create, show_on_edit)
VALUES ('reservation_requests', 'display_name', FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_create = FALSE,
  show_on_edit = FALSE;


INSERT INTO metadata.schema_decisions (
  title,
  decision,
  entity_types,
  context,
  rationale,
  consequences,
  status
) VALUES (
  'Guard new-request notifications and add parameterized Deny/Cancel actions',
  'Only send new-request notification emails when status is Pending. Add Deny and Cancel entity action buttons with required reason text parameters.',
  ARRAY['reservation_requests']::name[],
  'Recurring/bulk-created reservations by managers triggered one notification per row. Deny and Cancel RPCs existed but lacked UI buttons because reason fields required modal form input (not available until entity_action_params in v0.32.0).',
  'Status guard prevents notification spam for non-Pending inserts while preserving notifications for manager-created Pending requests that need peer review. Parameterized actions collect denial_reason/cancellation_reason in a modal before calling the RPC, so notification emails include the reason text.',
  'Requests inserted with a non-Pending status (e.g., pre-approved bulk imports) will not trigger manager notification emails. Deny and Cancel RPCs now require a reason text parameter — direct API callers must provide it.',
  'accepted'
);
