-- 30_revoke_public_execute.sql
-- Mott Park example: revoke PUBLIC EXECUTE, guard manager actions, fix helper grants.
--
-- Findings addressed:
--   - complete_reservation_request / close_reservation_request were SECURITY DEFINER with no
--     authorization check (only the UI restricted them to manager/admin).
--   - initiate_reservation_payment compared the owner with "!= ... AND NOT is_admin()", which is
--     NULL for an anonymous caller, so the ownership check was skipped.
--   - The scheduled-job functions (payment reminders, auto-complete, daily task runner) and
--     check_and_secure_reservation were granted to authenticated, letting any logged-in user
--     re-send reminder emails on demand. The worker runs them as postgres and needs no grant.
--   - The fee/holiday helpers are called from INVOKER trigger functions, so authenticated needs
--     an explicit grant once the default PUBLIC EXECUTE is gone.
--
-- Companion to core migration v0-76-5-revoke-public-execute. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so a bare GRANT ... TO authenticated never removed anonymous
-- (web_anon) access. This script revokes PUBLIC from this example's non-anonymous functions,
-- restores grants that the new default privileges would otherwise remove, and adds in-body
-- authorization checks to SECURITY DEFINER RPCs that had none.
--
-- Safe to re-run: REVOKE/GRANT are idempotent and CREATE OR REPLACE keeps existing ACLs.

BEGIN;

-- ===========================================================================
-- 1. Authorization guards (CREATE OR REPLACE keeps the existing ACL)
-- ===========================================================================

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
  -- Authorization guard: reservation_requests:update AND (manager OR admin)
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to complete reservation requests';
  END IF;
  IF NOT (has_permission('reservation_requests', 'update') AND
          ('manager' = ANY(get_user_roles()) OR is_admin())) THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires the manager or admin role';
  END IF;

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

CREATE OR REPLACE FUNCTION public.close_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_closed_status_id INT;
  v_deposit_status TEXT;
BEGIN
  -- Authorization guard: reservation_requests:update AND (manager OR admin)
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to close reservation requests';
  END IF;
  IF NOT (has_permission('reservation_requests', 'update') AND
          ('manager' = ANY(get_user_roles()) OR is_admin())) THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires the manager or admin role';
  END IF;

  -- Get closed status ID
  SELECT id INTO v_closed_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Closed';

  -- Fetch request
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Completed
  IF v_request.status_id != (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Completed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only completed requests can be closed');
  END IF;

  -- Check deposit status
  SELECT s.display_name INTO v_deposit_status
  FROM reservation_payments rp
  JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
  JOIN metadata.statuses s ON rp.status_id = s.id
  WHERE rp.reservation_request_id = p_entity_id
    AND rpt.code = 'security_deposit';

  IF v_deposit_status = 'Paid' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Security deposit must be refunded or waived before closing. Please process the deposit first.'
    );
  END IF;

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_closed_status_id
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Reservation closed successfully.',
    'refresh', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.initiate_reservation_payment(p_entity_id BIGINT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_payment RECORD;
  v_request RECORD;
  v_payment_type_name TEXT;
  v_idempotency_status TEXT;
  v_description TEXT;
BEGIN
  -- Authorization guard: only the requestor or an admin can pay
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to pay for a reservation';
  END IF;

  -- 1. Fetch payment record with lock
  SELECT rp.*, rpt.display_name as type_name, rpt.code as type_key, s.display_name as status_display
  INTO v_payment
  FROM public.reservation_payments rp
  JOIN public.reservation_payment_types rpt ON rp.payment_type_id = rpt.id
  JOIN metadata.statuses s ON rp.status_id = s.id
  WHERE rp.id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment record not found: %', p_entity_id;
  END IF;

  -- 2. Fetch parent reservation request for authorization and description
  SELECT rr.*
  INTO v_request
  FROM public.reservation_requests rr
  WHERE rr.id = v_payment.reservation_request_id;

  -- 3. Authorize: Only requestor can pay (match by user ID)
  IF v_request.requestor_id IS DISTINCT FROM current_user_id() AND NOT is_admin() THEN
    RAISE EXCEPTION 'You can only make payments for your own reservations';
  END IF;

  -- 4. Block credit card payment for Cleaning Fee - must pay Rosemary directly
  IF v_payment.type_key = 'cleaning_fee' THEN
    RAISE EXCEPTION 'Cleaning Payments: Must be made payment to Rosemary Morrow. Payments can be made by CashApp at $RoseMorrowTxLady or by Money Order or Check. Payable to Rosemary Morrow. They can be mailed to Mott Park Club House 2401 Nolen Drive Flint, Michigan 48504 or dropped off at the clubhouse in the mailbox on the front door. Questions? Contact Rose at 810-247-8681 or Stormprincess24@gmail.com. Thank you!';
  END IF;

  -- 5. Validate payment is payable (use status_display from joined statuses table)
  IF v_payment.status_display != 'Pending' THEN
    RAISE EXCEPTION 'This payment has already been processed (status: %)', v_payment.status_display;
  END IF;

  IF v_payment.status_display = 'Waived' THEN
    RAISE EXCEPTION 'This payment has been waived and does not require payment';
  END IF;

  -- 6. Check for existing payment (idempotency)
  v_idempotency_status := payments.check_existing_payment(v_payment.payment_transaction_id);

  IF v_idempotency_status = 'reuse' THEN
    RETURN v_payment.payment_transaction_id;  -- Payment in progress
  END IF;

  IF v_idempotency_status = 'duplicate' THEN
    RAISE EXCEPTION 'Payment already succeeded for this record';
  END IF;
  -- v_idempotency_status = 'create_new', proceed

  -- 7. Build description for Stripe
  v_description := format('%s - %s (%s)',
    v_payment.type_name,
    v_request.event_type,
    to_char(lower(v_request.time_slot), 'Mon DD, YYYY')
  );

  -- 8. Create and link payment using helper
  RETURN payments.create_and_link_payment(
    'reservation_payments',          -- Entity table
    'id',                             -- Entity PK column
    p_entity_id,                      -- Entity PK value
    'payment_transaction_id',         -- Payment FK column
    v_payment.amount::NUMERIC,        -- Amount (convert from MONEY)
    v_description                     -- Description for Stripe
  );
END;
$$;

-- ===========================================================================
-- 2. REVOKE EXECUTE FROM PUBLIC - authenticated-only functions
-- (explicit GRANT ... TO authenticated from the earlier scripts stays in place)
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.approve_reservation_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_reservation_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.close_reservation_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_reservation_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_reservation_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.initiate_reservation_payment(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.waive_all_reservation_payments(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_manual_payment(bigint, text, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_cash_payment(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_check_payment(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_money_order_payment(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_cashapp_payment(bigint) FROM PUBLIC;

-- ===========================================================================
-- 3. Fee and holiday helpers called by INVOKER trigger functions
-- Chain: on_reservation_approved (BEFORE UPDATE, runs as the updating role) ->
-- calculate_facility_fee -> is_holiday_or_weekend -> get_holidays_for_year ->
-- calculate_holiday_date -> get_nth_/get_last_weekday_of_month.
-- Without an explicit grant a manager approving through a direct UPDATE hits
-- "permission denied for function".
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.calculate_facility_fee(timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_nth_weekday_of_month(integer, integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_last_weekday_of_month(integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.calculate_holiday_date(holiday_rules, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_holidays_for_year(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_holiday_or_weekend(date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.calculate_facility_fee(timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_nth_weekday_of_month(integer, integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_last_weekday_of_month(integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_holiday_date(holiday_rules, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_holidays_for_year(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_holiday_or_weekend(date) TO authenticated;

-- ===========================================================================
-- 4. Scheduled-job and internal functions - run by the worker (postgres) or by SECURITY DEFINER
-- callers (run_daily_reservation_tasks, approve/record_* RPCs, payment triggers); no API role needs them
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.send_payment_reminders_7day() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_payment_due_today() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_payment_overdue_notifications() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_pre_event_reminders() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_complete_past_events() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_daily_reservation_tasks() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_and_secure_reservation(bigint) FROM PUBLIC, authenticated;

-- ===========================================================================
-- 5. Internal trigger functions
-- Trigger functions: EXECUTE is only checked when a trigger is created, never when it fires,
-- so revoking PUBLIC here does not affect the triggers.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.set_payment_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_policy_agreed_timestamp() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_status_reasons() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.on_reservation_approved() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_reservation_payments() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.on_reservation_cancelled() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_new_reservation_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reservation_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_request_age_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_payment_overdue_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_request_needs_attention() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_reservation_status_change_note() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_payment_status_change_note() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_public_calendar_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_reservation_payment_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_reservation_color_from_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_can_waive_fees() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_can_record_payment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manager_events_insert_trigger() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manager_events_update_trigger() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manager_events_delete_trigger() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trg_check_secure_on_payment_status_change() FROM PUBLIC;

-- public_events_ical_feed(date, date) is the public iCal subscription feed and keeps its
-- explicit grants to web_anon and authenticated (21_mpra_ical_feed.sql).

COMMIT;
