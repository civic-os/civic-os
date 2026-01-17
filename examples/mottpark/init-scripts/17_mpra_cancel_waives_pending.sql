-- =============================================================================
-- RESERVATION SYSTEM UPDATES
--
-- 1. Auto-cancel pending payments when reservation is cancelled
-- 2. Reduce advance booking requirement from 10 days to 24 hours
--
-- LOGICAL DEPENDENCY: Should be run after 16_mpra_waive_fees.sql (not enforced)
--
-- This script is idempotent and safe to re-run.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: Add "Cancelled" status for reservation_payment
-- =============================================================================

INSERT INTO metadata.statuses (
  entity_type,
  display_name,
  description,
  color,
  sort_order,
  is_initial,
  is_terminal
) VALUES (
  'reservation_payment',
  'Cancelled',
  'Payment cancelled due to reservation cancellation',
  '#6B7280',  -- Gray color to indicate neutral/inactive state
  5,          -- After Waived in sort order
  FALSE,
  TRUE        -- Terminal state - no further transitions
) ON CONFLICT (entity_type, display_name) DO UPDATE SET
  description = EXCLUDED.description,
  color = EXCLUDED.color,
  is_terminal = EXCLUDED.is_terminal;

-- =============================================================================
-- PART 2: Update cancel_reservation_request to use Cancelled status
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cancel_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata'
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
  -- Get reservation request status IDs
  SELECT id INTO v_cancelled_request_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';

  -- Get payment status IDs
  SELECT id INTO v_cancelled_payment_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Cancelled';

  SELECT id INTO v_pending_payment_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Pending';

  SELECT id INTO v_paid_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Paid';

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Approved or Pending
  IF v_request.status_id NOT IN (
    SELECT id FROM metadata.statuses
    WHERE entity_type = 'reservation_request'
    AND display_name IN ('Pending', 'Approved')
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending or approved requests can be cancelled');
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
    cancelled_by = current_user_id(),
    cancelled_at = NOW()
  WHERE id = p_entity_id;

  -- AUTO-CANCEL all pending payments (the key new behavior)
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

GRANT EXECUTE ON FUNCTION public.cancel_reservation_request(BIGINT) TO authenticated;

-- =============================================================================
-- PART 3: Reduce advance booking requirement from 10 days to 24 hours
-- =============================================================================
-- This allows same-day or next-day reservations, which is more flexible for
-- community members who need the facility on short notice.

ALTER TABLE reservation_requests
  DROP CONSTRAINT IF EXISTS min_advance_booking;

ALTER TABLE reservation_requests
  ADD CONSTRAINT min_advance_booking
  CHECK (
    lower(time_slot) >= (created_at + INTERVAL '24 hours')
  );

COMMENT ON CONSTRAINT min_advance_booking ON reservation_requests IS
'Ensures reservations are requested at least 24 hours in advance. Uses created_at
(immutable after INSERT) instead of CURRENT_DATE to allow managers to approve,
deny, or cancel requests even after the 24-hour window has passed.';

-- Also update the friendly error message for this constraint
INSERT INTO metadata.constraint_messages (constraint_name, table_name, error_message)
VALUES ('min_advance_booking', 'reservation_requests', 'Reservations must be made at least 24 hours in advance.')
ON CONFLICT (constraint_name) DO UPDATE SET
  error_message = EXCLUDED.error_message;

-- =============================================================================
-- Reload PostgREST schema cache
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
