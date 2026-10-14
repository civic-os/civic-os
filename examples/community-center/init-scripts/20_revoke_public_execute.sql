-- 20_revoke_public_execute.sql
-- Community Center example: revoke PUBLIC EXECUTE and guard entity-action RPCs.
--
-- Findings addressed:
--   - approve/deny/cancel_reservation_request were SECURITY DEFINER with no authorization
--     check, so anyone (including anonymous) could approve or cancel any request. The entity
--     action roles (editor, admin) were only enforced by the UI.
--   - initiate_reservation_request_payment compared the owner with "!=", which is NULL for an
--     anonymous caller, so the ownership check was skipped.
--   - get_users_with_role returned the id and email of every user holding a role to any caller.
--
-- Companion to core migration v0-76-5-revoke-public-execute. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so a bare GRANT ... TO authenticated never removed anonymous
-- (web_anon) access. This script revokes PUBLIC from this example's non-anonymous functions,
-- and adds in-body authorization checks to SECURITY DEFINER RPCs that had none.
--
-- Safe to re-run: REVOKE/GRANT are idempotent and CREATE OR REPLACE keeps existing ACLs.

BEGIN;

-- ===========================================================================
-- 1. Authorization guards (CREATE OR REPLACE keeps the existing ACL)
-- ===========================================================================

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
  -- Authorization guard: reservation_requests:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to approve reservation requests';
  END IF;
  IF NOT has_permission('reservation_requests', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires reservation_requests:update permission';
  END IF;

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
  -- Authorization guard: reservation_requests:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to deny reservation requests';
  END IF;
  IF NOT has_permission('reservation_requests', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires reservation_requests:update permission';
  END IF;

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
  -- Authorization guard: reservation_requests:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to cancel reservation requests';
  END IF;
  IF NOT has_permission('reservation_requests', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires reservation_requests:update permission';
  END IF;

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

CREATE OR REPLACE FUNCTION public.initiate_reservation_request_payment(
  p_entity_id BIGINT  -- Standardized parameter name for metadata-driven payment RPCs
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request RECORD;
  v_cost NUMERIC(10,2);
  v_idempotency_status TEXT;
  v_description TEXT;
BEGIN
  -- Authorization guard: only the request owner can pay
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to pay for a reservation request';
  END IF;

  -- ============================================================================
  -- 1. Fetch and lock entity (domain-specific)
  -- ============================================================================
  SELECT rr.*, res.display_name AS resource_name, res.hourly_rate
  INTO v_request
  FROM public.reservation_requests rr
  JOIN public.resources res ON rr.resource_id = res.id
  WHERE rr.id = p_entity_id
  FOR UPDATE;  -- Lock row during payment creation

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation request not found: %', p_entity_id;
  END IF;

  -- ============================================================================
  -- 2. Authorization check (domain-specific)
  -- ============================================================================
  IF v_request.requested_by IS DISTINCT FROM current_user_id() THEN
    RAISE EXCEPTION 'You can only make payments for your own reservation requests';
  END IF;

  -- ============================================================================
  -- 3. Idempotency check (GENERALIZED HELPER)
  -- ============================================================================
  -- Replaces ~28 lines of boilerplate with 3-line helper call
  v_idempotency_status := payments.check_existing_payment(v_request.payment_transaction_id);

  -- If payment already in progress, return existing payment_id
  IF v_idempotency_status = 'reuse' THEN
    RETURN v_request.payment_transaction_id;
  END IF;

  -- If payment already succeeded, prevent duplicate charge
  IF v_idempotency_status = 'duplicate' THEN
    RAISE EXCEPTION 'Payment already succeeded for this request';
  END IF;

  -- v_idempotency_status = 'create_new', fall through to create new payment

  -- ============================================================================
  -- 4. Business state validation (domain-specific)
  -- ============================================================================
  -- Check request is still pending (can't pay for approved/denied requests)
  IF v_request.status_id != 1 THEN
    RAISE EXCEPTION 'Can only pay for pending requests (current status: %)', v_request.status_id;
  END IF;

  -- ============================================================================
  -- 5. Cost calculation and validation (domain-specific)
  -- ============================================================================
  v_cost := public.calculate_reservation_cost(v_request.resource_id, v_request.time_slot);

  IF v_cost <= 0 THEN
    RAISE EXCEPTION 'Request does not require payment (cost: $%)', v_cost;
  END IF;

  -- ============================================================================
  -- 6. Payment creation and linking (GENERALIZED HELPER)
  -- ============================================================================
  -- Replaces ~20 lines of INSERT + UPDATE with single helper call
  -- Helper ensures correct status, currency, provider, and atomic linking
  v_description := format('Reservation Request for %s - %s',
    v_request.resource_name,
    v_request.purpose
  );

  RETURN payments.create_and_link_payment(
    'reservation_requests',      -- Entity table name
    'id',                         -- Entity PK column name
    p_entity_id,                  -- Entity PK value
    'payment_transaction_id',     -- Payment FK column name
    v_cost,                       -- Payment amount
    v_description                 -- Payment description
    -- user_id defaults to current_user_id()
    -- currency defaults to 'USD'
  );
END;
$$;

-- ===========================================================================
-- 2. REVOKE EXECUTE FROM PUBLIC - authenticated-only functions
-- (the explicit GRANT ... TO authenticated in the earlier scripts stays in place)
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.approve_reservation_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_reservation_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_reservation_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.initiate_reservation_request_payment(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.calculate_reservation_cost(integer, time_slot) FROM PUBLIC;

-- ===========================================================================
-- 3. Internal helper - only called by SECURITY DEFINER trigger functions (run as owner)
-- ===========================================================================

-- Returns user ids + emails for a role: must not be callable through the API.
REVOKE EXECUTE ON FUNCTION public.get_users_with_role(text) FROM PUBLIC, authenticated;

-- ===========================================================================
-- 4. Internal trigger functions
-- Trigger functions: EXECUTE is only checked when a trigger is created, never when it fires,
-- so revoking PUBLIC here does not affect the triggers.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.sync_reservation_request_to_reservation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_reviewed_at_timestamp() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reservation_request_created() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reservation_request_submitted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reservation_request_approved() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reservation_request_denied() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_reservation_request_cancelled() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_reservation_request_approval() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_reservation_request_cancellation() FROM PUBLIC;

-- public_events_ical_feed(bigint, date, date) is the public iCal subscription feed and keeps
-- its explicit grants to web_anon and authenticated (18_ical_feed_example.sql).

COMMIT;
