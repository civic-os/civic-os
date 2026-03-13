-- =============================================================================
-- MOTT PARK - ADD "SECURED" STATUS TO RESERVATION WORKFLOW
--
-- Inserts a new "Secured" status between "Approved" and "Completed" to separate
-- managerial approval from calendar locking. The public calendar slot is now
-- reserved only when the security deposit is paid (or fees are waived), not at
-- approval time. Two approved-but-not-secured reservations CAN overlap; first
-- to pay deposit wins the slot.
--
-- Workflow BEFORE:
--   Pending → Approved (locks calendar) → Completed → Closed
--
-- Workflow AFTER:
--   Pending → Approved → Secured (locks calendar) → Completed → Closed
--
-- LOGICAL DEPENDENCY: Run after all previous init scripts (01-25).
-- This script is idempotent and safe to re-run.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: ADD "SECURED" STATUS
-- =============================================================================

-- Insert the new Secured status
-- The status_key trigger will auto-generate status_key = 'secured'
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal)
VALUES (
  'reservation_request',
  'Secured',
  'Security deposit paid or fees waived - calendar slot locked',
  '#22C55E',  -- bright green (previously Approved's color)
  3,
  FALSE,
  FALSE
)
ON CONFLICT (entity_type, display_name) DO UPDATE SET
  description = EXCLUDED.description,
  color = EXCLUDED.color,
  sort_order = EXCLUDED.sort_order,
  is_initial = EXCLUDED.is_initial,
  is_terminal = EXCLUDED.is_terminal;

-- Update Approved color from green to cyan (no longer the "confirmed" state)
UPDATE metadata.statuses
SET color = '#06B6D4',
    description = 'Reservation approved - awaiting security deposit payment',
    sort_order = 2
WHERE entity_type = 'reservation_request'
  AND display_name = 'Approved';

-- Renumber remaining statuses to keep sort order clean
UPDATE metadata.statuses SET sort_order = 4
WHERE entity_type = 'reservation_request' AND display_name = 'Denied';

UPDATE metadata.statuses SET sort_order = 5
WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';

UPDATE metadata.statuses SET sort_order = 6
WHERE entity_type = 'reservation_request' AND display_name = 'Completed';

UPDATE metadata.statuses SET sort_order = 7
WHERE entity_type = 'reservation_request' AND display_name = 'Closed';


-- =============================================================================
-- PART 2: CHECK AND AUTO-SECURE FUNCTION
-- =============================================================================
-- Transitions Approved → Secured when security deposit is Paid or Waived.
-- Called from: sync_reservation_payment_status() and waive_all_reservation_payments()

CREATE OR REPLACE FUNCTION public.check_and_secure_reservation(p_reservation_request_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_approved_status_id INT;
  v_secured_status_id INT;
  v_cancelled_payment_status_id INT;
  v_pending_payment_status_id INT;
  v_deposit_ok BOOLEAN;
  v_competing RECORD;
  v_secured_display_name TEXT;
BEGIN
  v_approved_status_id := get_status_id('reservation_request', 'approved');
  v_secured_status_id := get_status_id('reservation_request', 'secured');
  v_cancelled_payment_status_id := get_status_id('reservation_payment', 'cancelled');
  v_pending_payment_status_id := get_status_id('reservation_payment', 'pending');

  -- Check reservation is in Approved status
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_reservation_request_id;

  IF NOT FOUND OR v_request.status_id != v_approved_status_id THEN
    RETURN;  -- Not in Approved status, nothing to do
  END IF;

  -- Check if security deposit is Paid or Waived
  SELECT EXISTS (
    SELECT 1
    FROM reservation_payments rp
    JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
    WHERE rp.reservation_request_id = p_reservation_request_id
      AND rpt.code = 'security_deposit'
      AND rp.status_id IN (
        get_status_id('reservation_payment', 'paid'),
        get_status_id('reservation_payment', 'waived')
      )
  ) INTO v_deposit_ok;

  IF v_deposit_ok THEN
    -- Transition to Secured (fires sync_public_calendar_event, notification, etc.)
    UPDATE reservation_requests
    SET status_id = v_secured_status_id
    WHERE id = p_reservation_request_id;

    -- Get the display name of the newly secured request for audit notes
    v_secured_display_name := COALESCE(v_request.display_name, 'Request #' || p_reservation_request_id);

    -- Cancel security deposit payments on competing Approved requests with
    -- overlapping time slots. This prevents Stripe payments from being initiated
    -- on requests that can no longer win the slot.
    FOR v_competing IN
      SELECT rr.id, rr.role_key, rp.id AS deposit_payment_id
      FROM reservation_requests rr
      JOIN reservation_payments rp ON rp.reservation_request_id = rr.id
      JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
      WHERE rr.status_id = v_approved_status_id
        AND rr.id != p_reservation_request_id
        AND rr.time_slot && v_request.time_slot  -- tstzrange overlap
        AND rpt.code = 'security_deposit'
        AND rp.status_id = v_pending_payment_status_id
    LOOP
      -- Cancel the competing deposit payment
      UPDATE reservation_payments
      SET status_id = v_cancelled_payment_status_id
      WHERE id = v_competing.deposit_payment_id;

      -- Audit note on the competing request explaining why
      PERFORM create_entity_note(
        p_entity_type := 'reservation_requests'::NAME,
        p_entity_id := v_competing.id::TEXT,
        p_content := format(
          '**Security deposit cancelled** — the time slot has been confirmed by another reservation (%s). '
          'This request remains Approved but cannot be secured for this time slot. '
          'Please contact the requestor to reschedule or cancel.',
          v_secured_display_name
        ),
        p_note_type := 'system',
        p_author_id := NULL
      );

      -- Send notification to the competing requestor
      PERFORM create_notification(
        p_user_id := (SELECT requestor_id FROM reservation_requests WHERE id = v_competing.id),
        p_template_name := 'reservation_slot_unavailable',
        p_entity_type := 'reservation_requests',
        p_entity_id := v_competing.id::TEXT,
        p_entity_data := jsonb_build_object(
          'competing_event', v_secured_display_name,
          'event_name', v_competing.display_name
        ),
        p_channels := ARRAY['email']::TEXT[]
      );
    END LOOP;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_and_secure_reservation(BIGINT) TO authenticated;

COMMENT ON FUNCTION public.check_and_secure_reservation IS
  'Auto-transitions a reservation from Approved to Secured when the security
   deposit is Paid or Waived. Called by payment status change trigger and fee
   waiver RPC. The Secured status locks the calendar slot via the sync trigger.
   Also cancels security deposit payments on competing Approved requests with
   overlapping time slots to prevent Stripe charges that would roll back.';


-- =============================================================================
-- PART 3: UPDATE sync_public_calendar_event() - CORE CHANGE
-- =============================================================================
-- Calendar entries now created at Secured (not Approved)

CREATE OR REPLACE FUNCTION sync_public_calendar_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_calendar_ids INT[];
BEGIN
  -- Get Secured/Completed status IDs (calendar is visible for these statuses)
  v_calendar_ids := ARRAY[
    get_status_id('reservation_request', 'secured'),
    get_status_id('reservation_request', 'completed')
  ];

  -- DELETE: Remove from public calendar
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public_calendar_events WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE: Sync if Secured/Completed, remove if not
  IF NEW.status_id = ANY(v_calendar_ids) THEN
    INSERT INTO public_calendar_events (
      id, time_slot, display_name, event_type, is_public_event,
      organization_name, contact_name, contact_phone, attendee_ages,
      is_admission_charged, synced_at
    ) VALUES (
      NEW.id,
      NEW.time_slot,
      -- Display name: show details for public, mask for private
      CASE WHEN NEW.is_public_event
        THEN COALESCE(NEW.organization_name, NEW.requestor_name) || ' - ' || NEW.event_type
        ELSE 'Private Event'
      END,
      -- Event type: show for public, mask for private
      CASE WHEN NEW.is_public_event THEN NEW.event_type ELSE 'Private Event' END,
      NEW.is_public_event,
      -- Contact info: only for public events
      CASE WHEN NEW.is_public_event THEN NEW.organization_name END,
      CASE WHEN NEW.is_public_event THEN NEW.requestor_name END,
      CASE WHEN NEW.is_public_event THEN NEW.requestor_phone END,
      CASE WHEN NEW.is_public_event THEN NEW.attendee_ages END,
      CASE WHEN NEW.is_public_event THEN NEW.is_admission_charged END,
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      time_slot = EXCLUDED.time_slot,
      display_name = EXCLUDED.display_name,
      event_type = EXCLUDED.event_type,
      is_public_event = EXCLUDED.is_public_event,
      organization_name = EXCLUDED.organization_name,
      contact_name = EXCLUDED.contact_name,
      contact_phone = EXCLUDED.contact_phone,
      attendee_ages = EXCLUDED.attendee_ages,
      is_admission_charged = EXCLUDED.is_admission_charged,
      synced_at = NOW();
  ELSE
    -- Not Secured/Completed: remove from public calendar
    DELETE FROM public_calendar_events WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;


-- =============================================================================
-- PART 4: UPDATE approve_reservation_request() - MESSAGE CHANGE
-- =============================================================================

CREATE OR REPLACE FUNCTION public.approve_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_approved_status_id INT;
  v_facility_fee MONEY;
BEGIN
  -- Get status IDs
  v_approved_status_id := get_status_id('reservation_request', 'approved');

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
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be approved');
  END IF;

  -- Check user has manager or admin role
  IF NOT (has_permission('reservation_requests', 'update') AND
          ('manager' = ANY(get_user_roles()) OR is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to approve requests');
  END IF;

  -- Calculate facility fee based on date
  v_facility_fee := calculate_facility_fee(lower(v_request.time_slot));

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_approved_status_id,
    reviewed_by = current_user_id(),
    reviewed_at = NOW(),
    facility_fee_amount = v_facility_fee
  WHERE id = p_entity_id;

  -- Payment records are created by the existing on_reservation_approved trigger

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Request approved! Facility fee: %s. Payment records created. The calendar slot will be locked once the security deposit is paid or waived.', v_facility_fee::TEXT),
    'refresh', true
  );
END;
$$;


-- =============================================================================
-- PART 5: UPDATE complete_reservation_request() - FROM SECURED
-- =============================================================================

CREATE OR REPLACE FUNCTION public.complete_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_completed_status_id INT;
BEGIN
  -- Get status IDs
  v_completed_status_id := get_status_id('reservation_request', 'completed');

  -- Fetch request
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Secured (was: Approved)
  IF v_request.status_id != get_status_id('reservation_request', 'secured') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only secured requests can be marked as completed');
  END IF;

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_completed_status_id
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Event marked as completed. Please complete the post-event assessment.',
    'refresh', true
  );
END;
$$;


-- =============================================================================
-- PART 6: UPDATE cancel_reservation_request() - ADD SECURED
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

  -- Check current status is Pending, Approved, or Secured (added Secured)
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


-- =============================================================================
-- PART 7: UPDATE update_can_waive_fees() - APPROVED OR SECURED
-- =============================================================================

CREATE OR REPLACE FUNCTION update_can_waive_fees()
RETURNS TRIGGER AS $$
DECLARE
  v_approved_status_id INT;
  v_secured_status_id INT;
  v_pending_status_id INT;
  v_has_pending BOOLEAN;
  v_target_request_id BIGINT;
BEGIN
  -- Get status IDs using stable status_key
  v_approved_status_id := get_status_id('reservation_request', 'approved');
  v_secured_status_id := get_status_id('reservation_request', 'secured');
  v_pending_status_id := get_status_id('reservation_payment', 'pending');

  -- Determine which request to check/update
  IF TG_TABLE_NAME = 'reservation_requests' THEN
    v_target_request_id := NEW.id;
  ELSE
    v_target_request_id := COALESCE(NEW.reservation_request_id, OLD.reservation_request_id);
  END IF;

  -- Check if there are pending payments for this request
  SELECT EXISTS (
    SELECT 1 FROM reservation_payments
    WHERE reservation_request_id = v_target_request_id
      AND status_id = v_pending_status_id
  ) INTO v_has_pending;

  -- Update the column based on trigger source
  -- Allow waiving from Approved OR Secured (added Secured)
  IF TG_TABLE_NAME = 'reservation_requests' THEN
    NEW.can_waive_fees := (NEW.status_id IN (v_approved_status_id, v_secured_status_id) AND v_has_pending);
    RETURN NEW;
  ELSE
    -- Called from reservation_payments trigger - update parent record
    UPDATE reservation_requests SET
      can_waive_fees = (status_id IN (v_approved_status_id, v_secured_status_id) AND v_has_pending)
    WHERE id = v_target_request_id;
    RETURN COALESCE(NEW, OLD);
  END IF;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- PART 8: UPDATE waive_all_reservation_payments() - APPROVED OR SECURED + AUTO-SECURE
-- =============================================================================

CREATE OR REPLACE FUNCTION public.waive_all_reservation_payments(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_waived_status_id INT;
  v_pending_status_id INT;
  v_approved_status_id INT;
  v_secured_status_id INT;
  v_request RECORD;
  v_waived_count INT;
BEGIN
  -- Get status IDs
  v_waived_status_id := get_status_id('reservation_payment', 'waived');
  v_pending_status_id := get_status_id('reservation_payment', 'pending');
  v_approved_status_id := get_status_id('reservation_request', 'approved');
  v_secured_status_id := get_status_id('reservation_request', 'secured');

  -- Verify request exists and is Approved or Secured
  SELECT * INTO v_request FROM reservation_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  IF v_request.status_id NOT IN (v_approved_status_id, v_secured_status_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Can only waive fees for approved or secured reservations');
  END IF;

  -- Check permission (manager or admin)
  IF NOT ('manager' = ANY(public.get_user_roles()) OR public.is_admin()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only managers can waive fees');
  END IF;

  -- Waive all pending payments
  UPDATE reservation_payments SET
    status_id = v_waived_status_id
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_pending_status_id;

  GET DIAGNOSTICS v_waived_count = ROW_COUNT;

  IF v_waived_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'No pending payments to waive');
  END IF;

  -- Auto-transition to Secured if currently Approved and deposit is now waived
  PERFORM check_and_secure_reservation(p_entity_id);

  RETURN jsonb_build_object(
    'success', true,
    'message', format('%s payment(s) waived successfully', v_waived_count),
    'refresh', true
  );
END;
$$;


-- =============================================================================
-- PART 9: UPDATE sync_reservation_payment_status() - ADD AUTO-SECURE CALL
-- =============================================================================
-- When a Stripe payment succeeds (particularly the security deposit), check
-- if the reservation should auto-transition to Secured.

CREATE OR REPLACE FUNCTION sync_reservation_payment_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_paid_status_id INT;
  v_pending_status_id INT;
  v_credit_card_method_id INT;
  v_reservation_request_id BIGINT;
BEGIN
  -- Only process if status actually changed
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Get status IDs using stable status_key
  v_paid_status_id := get_status_id('reservation_payment', 'paid');
  v_pending_status_id := get_status_id('reservation_payment', 'pending');
  v_credit_card_method_id := get_status_id('payment_method', 'credit_card');

  -- Update reservation_payments that reference this transaction
  IF NEW.status = 'succeeded' THEN
    -- Payment succeeded -> mark as Paid with Credit Card method
    UPDATE reservation_payments
    SET
      status_id = v_paid_status_id,
      payment_date = (NOW() AT TIME ZONE 'America/Detroit')::DATE,
      paid_amount = NEW.amount::MONEY,
      payment_method_id = v_credit_card_method_id
    WHERE payment_transaction_id = NEW.id
      AND status_id != v_paid_status_id;

    IF FOUND THEN
      RAISE NOTICE 'Payment succeeded: updated reservation_payment to Paid (Credit Card) for transaction %', NEW.id;

      -- Get the parent reservation_request_id and check if it should auto-secure
      SELECT rp.reservation_request_id INTO v_reservation_request_id
      FROM reservation_payments rp
      WHERE rp.payment_transaction_id = NEW.id
      LIMIT 1;

      IF v_reservation_request_id IS NOT NULL THEN
        PERFORM check_and_secure_reservation(v_reservation_request_id);
      END IF;
    END IF;

  ELSIF NEW.status IN ('failed', 'canceled') THEN
    -- Payment failed/canceled -> keep as Pending, clear transaction link
    UPDATE reservation_payments
    SET payment_transaction_id = NULL
    WHERE payment_transaction_id = NEW.id
      AND status_id = v_pending_status_id;

    IF FOUND THEN
      RAISE NOTICE 'Payment %: cleared transaction link for retry (transaction %)', NEW.status, NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- =============================================================================
-- PART 10: UPDATE record_manual_payment() - ADD AUTO-SECURE CALL
-- =============================================================================
-- When a manual payment is recorded (cash, check, etc.), also check for auto-secure.

CREATE OR REPLACE FUNCTION public.record_manual_payment(
  p_entity_id BIGINT,
  p_payment_method TEXT,
  p_payment_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_payment RECORD;
  v_paid_status_id INT;
  v_pending_status_id INT;
  v_method_status_id INT;
  v_actual_date DATE;
BEGIN
  -- Default to current date in system timezone
  v_actual_date := COALESCE(p_payment_date, (NOW() AT TIME ZONE 'America/Detroit')::DATE);

  -- Get status IDs using stable status_key
  v_paid_status_id := get_status_id('reservation_payment', 'paid');
  v_pending_status_id := get_status_id('reservation_payment', 'pending');

  -- Payment method lookup by display_name (caller passes user-facing name like 'Cash', 'Check')
  SELECT id INTO v_method_status_id
  FROM metadata.statuses
  WHERE entity_type = 'payment_method' AND display_name = p_payment_method;

  IF v_method_status_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message',
      format('Invalid payment method: %s', p_payment_method));
  END IF;

  -- Fetch payment with lock
  SELECT * INTO v_payment
  FROM reservation_payments
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Payment record not found');
  END IF;

  -- Check payment is still pending
  IF v_payment.status_id != v_pending_status_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending payments can be marked as paid');
  END IF;

  -- Check permission (manager or admin)
  IF NOT ('manager' = ANY(public.get_user_roles()) OR public.is_admin()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only managers can record manual payments');
  END IF;

  -- Update the payment record
  UPDATE reservation_payments SET
    status_id = v_paid_status_id,
    payment_method_id = v_method_status_id,
    payment_date = v_actual_date,
    paid_amount = amount  -- Manual payments assumed paid in full
  WHERE id = p_entity_id;

  -- Check if reservation should auto-transition to Secured
  PERFORM check_and_secure_reservation(v_payment.reservation_request_id);

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Payment recorded as %s on %s', p_payment_method, v_actual_date::TEXT),
    'refresh', true
  );
END;
$$;


-- =============================================================================
-- PART 11: UPDATE auto_complete_past_events() - FROM SECURED (NOT APPROVED)
-- =============================================================================

CREATE OR REPLACE FUNCTION auto_complete_past_events()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request RECORD;
  v_request_data JSONB;
  v_manager_id UUID;
  v_count INT := 0;
  v_secured_status_id INT;
  v_completed_status_id INT;
BEGIN
  -- Now auto-complete from Secured (not Approved)
  v_secured_status_id := get_status_id('reservation_request', 'secured');
  v_completed_status_id := get_status_id('reservation_request', 'completed');

  FOR v_request IN
    SELECT
      rr.id,
      rr.requestor_name,
      rr.event_type,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_requests rr
    WHERE rr.status_id = v_secured_status_id
      AND upper(rr.time_slot) < NOW()  -- Event has ended
  LOOP
    -- Update status to Completed
    UPDATE reservation_requests
    SET status_id = v_completed_status_id
    WHERE id = v_request.id;

    v_request_data := jsonb_build_object(
      'id', v_request.id,
      'requestor_name', v_request.requestor_name,
      'event_type', v_request.event_type,
      'time_slot', v_request.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    -- Send post-event assessment reminder to managers
    FOR v_manager_id IN
      SELECT DISTINCT u.id
      FROM metadata.civic_os_users u
      JOIN metadata.user_roles ur ON u.id = ur.user_id
      JOIN metadata.roles r ON ur.role_id = r.id
      WHERE r.role_key IN ('manager', 'admin')
    LOOP
      PERFORM create_notification(
        p_user_id := v_manager_id,
        p_template_name := 'manager_post_event_reminder',
        p_entity_type := 'reservation_requests',
        p_entity_id := v_request.id::text,
        p_entity_data := v_request_data,
        p_channels := ARRAY['email']::TEXT[]
      );
    END LOOP;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;


-- =============================================================================
-- PART 12: UPDATE send_pre_event_reminders() - CHECK SECURED TOO
-- =============================================================================
-- Pre-event reminders should go to managers for Secured events (calendar-locked),
-- not just Approved (which now means "awaiting deposit").

CREATE OR REPLACE FUNCTION send_pre_event_reminders()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request RECORD;
  v_request_data JSONB;
  v_manager_id UUID;
  v_count INT := 0;
  v_secured_status_id INT;
BEGIN
  -- Send reminders for Secured events (deposit paid, calendar locked)
  v_secured_status_id := get_status_id('reservation_request', 'secured');

  FOR v_request IN
    SELECT
      rr.id,
      rr.requestor_name,
      rr.organization_name,
      rr.event_type,
      rr.attendee_count,
      rr.is_food_served,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_requests rr
    WHERE rr.status_id = v_secured_status_id
      AND lower(rr.time_slot)::DATE = CURRENT_DATE + INTERVAL '1 day'
  LOOP
    v_request_data := jsonb_build_object(
      'id', v_request.id,
      'requestor_name', v_request.requestor_name,
      'organization_name', v_request.organization_name,
      'event_type', v_request.event_type,
      'attendee_count', v_request.attendee_count,
      'is_food_served', v_request.is_food_served,
      'time_slot', v_request.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    -- Send to all managers
    FOR v_manager_id IN
      SELECT DISTINCT u.id
      FROM metadata.civic_os_users u
      JOIN metadata.user_roles ur ON u.id = ur.user_id
      JOIN metadata.roles r ON ur.role_id = r.id
      WHERE r.role_key IN ('manager', 'admin')
    LOOP
      PERFORM create_notification(
        p_user_id := v_manager_id,
        p_template_name := 'manager_pre_event_reminder',
        p_entity_type := 'reservation_requests',
        p_entity_id := v_request.id::text,
        p_entity_data := v_request_data,
        p_channels := ARRAY['email']::TEXT[]
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END;
$$;


-- =============================================================================
-- PART 13: UPDATE notify_reservation_status_change() - ADD SECURED TEMPLATE
-- =============================================================================

CREATE OR REPLACE FUNCTION notify_reservation_status_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request_data JSONB;
  v_new_status_name TEXT;
  v_template_name TEXT;
BEGIN
  -- Only proceed if status changed
  IF NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN
    RETURN NEW;
  END IF;

  -- Get the new status name
  SELECT display_name INTO v_new_status_name
  FROM metadata.statuses
  WHERE id = NEW.status_id AND entity_type = 'reservation_request';

  -- Determine which template to use (added Secured)
  v_template_name := CASE v_new_status_name
    WHEN 'Approved' THEN 'reservation_request_approved'
    WHEN 'Secured' THEN 'reservation_request_secured'
    WHEN 'Denied' THEN 'reservation_request_denied'
    WHEN 'Cancelled' THEN 'reservation_request_cancelled'
    ELSE NULL
  END;

  -- Exit if no template for this status
  IF v_template_name IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build request data (pass raw time_slot - Go service handles formatting/timezone)
  SELECT jsonb_build_object(
    'id', NEW.id,
    'requestor_name', NEW.requestor_name,
    'organization_name', NEW.organization_name,
    'event_type', NEW.event_type,
    'time_slot', NEW.time_slot::TEXT,
    'attendee_count', NEW.attendee_count,
    'facility_fee_amount', NEW.facility_fee_amount::TEXT,
    'denial_reason', NEW.denial_reason,
    'cancellation_reason', NEW.cancellation_reason,
    'status', jsonb_build_object(
      'display_name', v_new_status_name
    )
  ) INTO v_request_data;

  -- Send notification to requestor
  PERFORM create_notification(
    p_user_id := NEW.requestor_id,
    p_template_name := v_template_name,
    p_entity_type := 'reservation_requests',
    p_entity_id := NEW.id::text,
    p_entity_data := v_request_data,
    p_channels := ARRAY['email']::TEXT[]
  );

  RETURN NEW;
END;
$$;


-- =============================================================================
-- PART 14: UPDATE add_reservation_status_change_note() - ADD SECURED CASE
-- =============================================================================

CREATE OR REPLACE FUNCTION add_reservation_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_old_status TEXT;
  v_new_status TEXT;
  v_note_content TEXT;
  v_actor_name TEXT;
BEGIN
  -- Get status display names
  SELECT display_name INTO v_old_status FROM metadata.statuses WHERE id = OLD.status_id;
  SELECT display_name INTO v_new_status FROM metadata.statuses WHERE id = NEW.status_id;

  -- Get actor name
  SELECT display_name INTO v_actor_name
  FROM metadata.civic_os_users
  WHERE id = current_user_id();

  -- Build note content based on the transition (added Secured)
  CASE v_new_status
    WHEN 'Approved' THEN
      v_note_content := format('**Status changed to Approved** by %s. Facility fee: %s',
        COALESCE(v_actor_name, 'System'),
        NEW.facility_fee_amount::TEXT);
    WHEN 'Secured' THEN
      v_note_content := format('**Status changed to Secured.** Security deposit paid or fees waived. Calendar slot is now locked.');
    WHEN 'Denied' THEN
      v_note_content := format('**Status changed to Denied** by %s.%s',
        COALESCE(v_actor_name, 'System'),
        CASE WHEN NEW.denial_reason IS NOT NULL
          THEN E'\n\n**Reason:** ' || NEW.denial_reason
          ELSE ''
        END);
    WHEN 'Cancelled' THEN
      v_note_content := format('**Status changed to Cancelled** by %s.%s',
        COALESCE(v_actor_name, 'System'),
        CASE WHEN NEW.cancellation_reason IS NOT NULL
          THEN E'\n\n**Reason:** ' || NEW.cancellation_reason
          ELSE ''
        END);
    WHEN 'Completed' THEN
      v_note_content := format('**Event completed.** Marked by %s. Post-event assessment pending.',
        COALESCE(v_actor_name, 'System'));
    WHEN 'Closed' THEN
      v_note_content := format('**Reservation closed** by %s. All processing complete.',
        COALESCE(v_actor_name, 'System'));
    ELSE
      v_note_content := format('**Status changed** from %s to %s by %s',
        v_old_status, v_new_status, COALESCE(v_actor_name, 'System'));
  END CASE;

  -- Create system note
  PERFORM create_entity_note(
    p_entity_type := 'reservation_requests'::NAME,
    p_entity_id := NEW.id::TEXT,
    p_content := v_note_content,
    p_note_type := 'system',
    p_author_id := current_user_id()
  );

  RETURN NEW;
END;
$$;


-- =============================================================================
-- PART 15: UPDATE ENTITY ACTION BUTTONS
-- =============================================================================

-- "Mark Completed" button: change visibility/enabled from Approved to Secured
UPDATE metadata.entity_actions
SET
  visibility_condition = jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', get_status_id('reservation_request', 'secured')),
  enabled_condition = jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', get_status_id('reservation_request', 'secured')),
  disabled_tooltip = 'Only secured requests can be marked completed'
WHERE table_name = 'reservation_requests'
  AND action_name = 'complete';


-- =============================================================================
-- PART 16: NOTIFICATION TEMPLATES
-- =============================================================================

-- New template: Reservation Secured
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'reservation_request_secured',
  'Notify requestor when their reservation is secured (deposit paid/fees waived)',
  'reservation_requests',
  'Your Reservation Has Been Confirmed!',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #22C55E;">✓ Reservation Confirmed</h2>
    <p>Great news! Your security deposit has been received (or fees have been waived) and your reservation is now <strong>confirmed</strong>.</p>
    <p>Your time slot on the public calendar has been locked and no other events can be booked during your reservation.</p>
    <h3>Event Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date/Time:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p><strong>Location:</strong> Mott Park Recreation Area Clubhouse</p>
    <h3>What''s Next?</h3>
    <ul>
      <li>Ensure remaining fees (facility fee, cleaning fee) are paid before their due dates</li>
      <li>Review the facility rules before your event</li>
      <li>Contact MPRA if you need to make any changes</li>
    </ul>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #22C55E; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Reservation Details
      </a>
    </p>
  </div>',
  'RESERVATION CONFIRMED

Your security deposit has been received (or fees have been waived) and your reservation is now confirmed.

Your time slot on the public calendar has been locked.

Event Details:
- Event: {{.Entity.event_type}}
- Date/Time: {{formatTimeSlot .Entity.time_slot}}
- Location: Mott Park Recreation Area Clubhouse

What''s Next?
- Ensure remaining fees are paid before their due dates
- Review the facility rules before your event
- Contact MPRA if you need to make any changes

View details: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Update Approved template: mention deposit is due and calendar locks on payment
UPDATE metadata.notification_templates
SET
  subject_template = 'Your Reservation Request Has Been Approved - Deposit Due',
  html_template = '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #06B6D4;">✓ Reservation Approved</h2>
    <p>Great news! Your reservation request for <strong>{{.Entity.event_type}}</strong> has been approved.</p>
    <h3>Event Details</h3>
    <p><strong>Date/Time:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p><strong>Location:</strong> Mott Park Recreation Area Clubhouse</p>
    <h3 style="color: #F59E0B;">⚠️ Security Deposit Due Immediately</h3>
    <p>Your <strong>security deposit of $150</strong> is due immediately to confirm your reservation. Your calendar slot will be locked once the deposit is received or fees are waived.</p>
    <p style="color: #DC2626; font-weight: bold;">Until the deposit is paid, another event could be booked for the same time slot.</p>
    <h3>Full Payment Schedule</h3>
    <ul>
      <li><strong>Security Deposit ($150):</strong> Due immediately</li>
      <li><strong>Facility Fee ({{formatMoney .Entity.facility_fee_amount}}):</strong> Due 30 days before event</li>
      <li><strong>Cleaning Fee ($75):</strong> Due before event</li>
    </ul>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #06B6D4; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Reservation & Pay Deposit
      </a>
    </p>
  </div>',
  text_template = 'RESERVATION APPROVED - DEPOSIT DUE

Your reservation request for {{.Entity.event_type}} has been approved!

Event Details:
- Date/Time: {{formatTimeSlot .Entity.time_slot}}
- Location: Mott Park Recreation Area Clubhouse

SECURITY DEPOSIT DUE IMMEDIATELY
Your security deposit of $150 is due immediately to confirm your reservation.
Your calendar slot will be locked once the deposit is received or fees are waived.
Until the deposit is paid, another event could be booked for the same time slot.

Full Payment Schedule:
- Security Deposit ($150): Due immediately
- Facility Fee ({{formatMoney .Entity.facility_fee_amount}}): Due 30 days before event
- Cleaning Fee ($75): Due before event

View and pay at: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
WHERE name = 'reservation_request_approved';

-- New template: Slot Unavailable (sent to competing requestors when another
-- reservation secures the same time slot)
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'reservation_slot_unavailable',
  'Notify requestor when their approved time slot has been secured by another reservation',
  'reservation_requests',
  'Your Requested Time Slot Is No Longer Available',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #F59E0B;">Time Slot No Longer Available</h2>
    <p>Unfortunately, your requested time slot for <strong>{{.Entity.event_name}}</strong> is no longer available. Another event has been confirmed for that time.</p>
    <p>Please contact us at <a href="mailto:mottpark@gmail.com">mottpark@gmail.com</a> to make other arrangements.</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #F59E0B; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Your Reservation
      </a>
    </p>
  </div>',
  'Your requested time slot for {{.Entity.event_name}} is no longer available. Another event has been confirmed for that time.

Please contact us at mottpark@gmail.com to make other arrangements.

View your reservation: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;


-- =============================================================================
-- PART 17: UPDATE CONSTRAINT MESSAGE
-- =============================================================================

UPDATE metadata.constraint_messages
SET error_message = 'Cannot secure this reservation: the requested time slot conflicts with an existing confirmed event. Please check the calendar for availability or contact the requestor to reschedule.'
WHERE constraint_name = 'no_overlapping_approved_events';


-- =============================================================================
-- PART 18: INITIALIZE can_waive_fees FOR EXISTING RECORDS (with Secured)
-- =============================================================================

UPDATE reservation_requests rr SET
  can_waive_fees = (
    rr.status_id IN (
      get_status_id('reservation_request', 'approved'),
      get_status_id('reservation_request', 'secured')
    )
    AND EXISTS (
      SELECT 1 FROM reservation_payments rp
      WHERE rp.reservation_request_id = rr.id
        AND rp.status_id = get_status_id('reservation_payment', 'pending')
    )
  );


-- =============================================================================
-- PART 19: DATA MIGRATION
-- =============================================================================
-- Migrate existing Approved reservations with paid/waived security deposits to Secured.
-- Disable the notification trigger to avoid sending ~46 "Confirmed!" emails
-- for reservations that were already effectively confirmed. Audit notes still
-- fire to document when the migration happened.

ALTER TABLE reservation_requests DISABLE TRIGGER reservation_status_change_notification;

UPDATE reservation_requests rr
SET status_id = get_status_id('reservation_request', 'secured')
WHERE rr.status_id = get_status_id('reservation_request', 'approved')
AND EXISTS (
  SELECT 1 FROM reservation_payments rp
  JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
  WHERE rp.reservation_request_id = rr.id
    AND rpt.code = 'security_deposit'
    AND rp.status_id IN (
      get_status_id('reservation_payment', 'paid'),
      get_status_id('reservation_payment', 'waived')
    )
);

ALTER TABLE reservation_requests ENABLE TRIGGER reservation_status_change_notification;


-- =============================================================================
-- PART 20: SCHEMA DECISION (ADR)
-- =============================================================================
-- Note: Uses direct INSERT (not create_schema_decision RPC) because init
-- scripts run without JWT context.

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_request']::NAME[], NULL, 'mottpark-26-secured-status',
    'Add Secured status to separate approval from calendar locking',
    'accepted',
    'The Approved status was doing double duty: (1) managerial approval and (2) calendar locking via the sync trigger. This meant once a request was approved, the time slot was immediately locked on the public calendar even if the requestor never paid the security deposit. Unpaid approved reservations would hold slots indefinitely, blocking other events.',
    'Insert a Secured status between Approved and Completed in the reservation workflow. The public calendar slot is now locked only when a reservation reaches Secured (security deposit paid or fees waived), not at Approved. Two approved-but-not-secured reservations can have overlapping time slots; the first to pay the deposit wins the slot via the GIST exclusion constraint on public_calendar_events.',
    'The Secured status approach preserves the existing approval workflow while adding a clear payment gate. Alternatives considered: (a) adding a payment deadline with auto-cancel for unpaid approved requests — adds complexity with timers and still blocks the slot temporarily; (b) requiring deposit payment before approval — changes the manager workflow and makes approval dependent on payment.',
    'Calendar sync trigger now checks for Secured/Completed instead of Approved/Completed. Auto-complete daily job transitions from Secured. Cancel RPC accepts Pending/Approved/Secured. Pre-event reminders sent only for Secured events.',
    NOW()::DATE
) ON CONFLICT DO NOTHING;


-- =============================================================================
-- PART 21: STATUS TRANSITIONS (Causal Bindings) — REQUIRES v0.33.0+
-- =============================================================================
-- Update transitions to include the new Secured status.
-- Uncomment when deploying on Civic OS v0.33.0+ which adds metadata.status_transitions.
--
-- DELETE FROM metadata.status_transitions
-- WHERE entity_type = 'reservation_request';
--
-- INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
--     -- Pending → Approved
--     ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'approved'),
--      'approve_reservation_request', 'Approve', 'Approve reservation. Triggers pricing calculation and payment creation.'),
--     -- Pending → Denied
--     ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'denied'),
--      'deny_reservation_request', 'Deny', 'Deny reservation request. Requires denial_reason.'),
--     -- Pending → Cancelled
--     ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'cancelled'),
--      'cancel_reservation_request', 'Cancel', 'Cancel pending request. Requires cancellation_reason.'),
--     -- Approved → Secured (auto, via payment or waiver)
--     ('reservation_request', get_status_id('reservation_request', 'approved'), get_status_id('reservation_request', 'secured'),
--      'check_and_secure_reservation', 'Secure', 'Auto-transition when security deposit is paid or fees are waived. Locks calendar slot.'),
--     -- Approved → Cancelled
--     ('reservation_request', get_status_id('reservation_request', 'approved'), get_status_id('reservation_request', 'cancelled'),
--      'cancel_reservation_request', 'Cancel', 'Cancel approved reservation. Auto-cancels all pending payments.'),
--     -- Secured → Cancelled
--     ('reservation_request', get_status_id('reservation_request', 'secured'), get_status_id('reservation_request', 'cancelled'),
--      'cancel_reservation_request', 'Cancel', 'Cancel secured reservation. Removes calendar entry and auto-cancels pending payments.'),
--     -- Secured → Completed
--     ('reservation_request', get_status_id('reservation_request', 'secured'), get_status_id('reservation_request', 'completed'),
--      'complete_reservation_request', 'Mark Completed', 'Mark reservation as completed after the event ends. Also triggered automatically by auto_complete_past_events() scheduled job.'),
--     -- Completed → Closed
--     ('reservation_request', get_status_id('reservation_request', 'completed'), get_status_id('reservation_request', 'closed'),
--      'close_reservation_request', 'Close', 'Close reservation after all processing is complete. Requires security deposit to be refunded or waived first.');


-- =============================================================================
-- PART 22: REACTIVE TRIGGER - AUTO-SECURE ON PAYMENT STATUS CHANGE
-- =============================================================================
-- Instead of relying solely on RPCs to call check_and_secure_reservation(),
-- this trigger fires whenever a reservation_payment.status_id changes to
-- Paid or Waived — regardless of how the change happened (RPC, direct edit,
-- webhook, etc.). This is the single reactive effect that covers all paths.

CREATE OR REPLACE FUNCTION trg_check_secure_on_payment_status_change()
RETURNS TRIGGER AS $$
DECLARE
    v_paid_status_id INT;
    v_waived_status_id INT;
BEGIN
    v_paid_status_id := get_status_id('reservation_payment', 'paid');
    v_waived_status_id := get_status_id('reservation_payment', 'waived');

    IF NEW.status_id IN (v_paid_status_id, v_waived_status_id) THEN
        PERFORM check_and_secure_reservation(NEW.reservation_request_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS trg_payment_status_check_secure ON reservation_payments;

CREATE TRIGGER trg_payment_status_check_secure
    AFTER UPDATE OF status_id ON reservation_payments
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION trg_check_secure_on_payment_status_change();

-- Register as causal binding for introspection — REQUIRES v0.33.0+
-- Uncomment when deploying on Civic OS v0.33.0+ which adds metadata.property_change_triggers.
--
-- INSERT INTO metadata.property_change_triggers
--     (table_name, property_name, change_type, change_value, function_name, display_name, description)
-- VALUES
--     ('reservation_payments', 'status_id', 'changed_to',
--      get_status_id('reservation_payment', 'paid')::TEXT,
--      'trg_check_secure_on_payment_status_change', 'Auto-secure reservation on deposit paid',
--      'AFTER trigger: when security deposit status changes to Paid, calls check_and_secure_reservation() to auto-transition parent request from Approved to Secured.'),
--     ('reservation_payments', 'status_id', 'changed_to',
--      get_status_id('reservation_payment', 'waived')::TEXT,
--      'trg_check_secure_on_payment_status_change', 'Auto-secure reservation on fees waived',
--      'AFTER trigger: when payment status changes to Waived, calls check_and_secure_reservation() to auto-transition parent request from Approved to Secured.')
-- ON CONFLICT DO NOTHING;


-- =============================================================================
-- PART 23: FIX MANAGER DASHBOARD WIDGETS
-- =============================================================================
-- Fix two issues:
-- 1. "display_name_full" column doesn't exist — should be "display_name"
-- 2. Status ID filters need to include Secured for upcoming/calendar widgets

-- Fix "Pending Requests" widget: display_name_full → display_name
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
  config,
  '{showColumns}',
  '["display_name", "time_slot", "attendee_count", "created_at"]'::jsonb
)
WHERE title = '⏳ Pending Requests'
  AND widget_type = 'filtered_list';

-- Fix "Upcoming Approved Events" widget: display_name_full → display_name,
-- and include both Approved and Secured status
UPDATE metadata.dashboard_widgets
SET
  title = '✅ Upcoming Confirmed Events',
  config = jsonb_set(
    jsonb_set(
      config,
      '{showColumns}',
      '["display_name", "time_slot", "facility_fee_amount", "is_public_event"]'::jsonb
    ),
    '{filters}',
    jsonb_build_array(
      jsonb_build_object(
        'column', 'status_id',
        'operator', 'in',
        'value', jsonb_build_array(
          get_status_id('reservation_request', 'approved'),
          get_status_id('reservation_request', 'secured')
        )
      )
    )
  )
WHERE title = '✅ Upcoming Approved Events'
  AND widget_type = 'filtered_list';

-- Fix "Events This Week" widget: display_name_full → display_name,
-- and filter on Secured (calendar-locked events)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
  jsonb_set(
    config,
    '{showColumns}',
    '["display_name", "time_slot", "days_until_event", "attendee_count"]'::jsonb
  ),
  '{filters}',
  (SELECT jsonb_build_array(
    jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', get_status_id('reservation_request', 'secured')),
    jsonb_build_object('column', 'days_until_event', 'operator', 'lte', 'value', 7),
    jsonb_build_object('column', 'days_until_event', 'operator', 'gte', 'value', 0)
  ))
)
WHERE title = '📅 Events This Week'
  AND widget_type = 'filtered_list';

-- Fix "All Reservations" calendar: add Secured to status filter
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
  config,
  '{filters}',
  (SELECT jsonb_build_array(
    jsonb_build_object(
      'column', 'status_id',
      'operator', 'in',
      'value', jsonb_build_array(
        get_status_id('reservation_request', 'pending'),
        get_status_id('reservation_request', 'approved'),
        get_status_id('reservation_request', 'secured'),
        get_status_id('reservation_request', 'completed'),
        get_status_id('reservation_request', 'closed')
      )
    )
  ))
)
WHERE title = 'All Reservations'
  AND widget_type = 'calendar';


-- =============================================================================
-- RELOAD POSTGREST SCHEMA CACHE
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;

/*
VERIFICATION PLAN
=================

After running this script, verify the following:

1. STATUS FLOW:
   SELECT display_name, status_key, color, sort_order, is_terminal
   FROM metadata.statuses
   WHERE entity_type = 'reservation_request'
   ORDER BY sort_order;

   Expected: Pending(1) → Approved(2,cyan) → Secured(3,green) → Denied(4) → Cancelled(5) → Completed(6) → Closed(7)

2. OVERLAP PREVENTION:
   - Two same-timeslot reservations can both reach Approved
   - First to pay deposit → Secured → calendar entry created
   - Second tries to secure → exclusion constraint error

3. CANCEL FROM EACH STATE:
   - Approved: no calendar entry to remove
   - Secured: calendar entry removed by sync trigger

4. AUTO-SECURE VIA PAYMENT:
   Pay security deposit → auto-transition to Secured + calendar entry created

5. AUTO-SECURE VIA WAIVER:
   Waive all fees from Approved → auto-transition to Secured + calendar entry created

6. WAIVE FROM SECURED:
   Waive remaining fees from Secured → stays Secured (already secured)

7. AUTO-COMPLETE:
   Past event in Secured → auto-completes (not from Approved anymore)

8. NOTIFICATIONS:
   - Approved email mentions deposit due
   - Secured email confirms slot locked

9. DATA MIGRATION:
   Existing approved+paid reservations should now be Secured
*/
