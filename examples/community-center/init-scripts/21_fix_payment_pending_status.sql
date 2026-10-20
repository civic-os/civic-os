-- 21_fix_payment_pending_status.sql
-- Community Center example: initiate_reservation_request_payment() compared status_id with a
-- literal 1. metadata.statuses ids are shared by every entity type, so "Pending" for
-- reservation_request is not 1 in a fresh stack (it is 5), and Pay Now always failed with
-- "Can only pay for pending requests". The check now resolves the status by status_key.
--
-- Supersedes the definition from 10_payment_integration.sql / 20_revoke_public_execute.sql
-- (migration-first: those scripts are left as shipped). The step 4 check changes, and the
-- function now pins search_path (SECURITY DEFINER must not resolve unqualified names such as
-- get_status_id() and current_user_id() through the caller's search_path).
-- CREATE OR REPLACE keeps the existing ACL (PUBLIC revoked in script 20, authenticated granted).
--
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.initiate_reservation_request_payment(
  p_entity_id BIGINT  -- Standardized parameter name for metadata-driven payment RPCs
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
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
  -- Check request is still pending (can't pay for approved/denied requests).
  -- Look the status up by status_key: ids are shared across entity types, so a
  -- literal id matches whatever status happened to be inserted first.
  IF v_request.status_id IS DISTINCT FROM get_status_id('reservation_request', 'pending') THEN
    RAISE EXCEPTION 'Can only pay for pending requests (current status: %)',
      (SELECT display_name FROM metadata.statuses WHERE id = v_request.status_id);
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

COMMIT;
