-- ============================================================================
-- Payment Integration for Community Center Reservation Requests
-- ============================================================================
-- This script adds payment functionality to reservation_requests using the
-- Payment property type pattern (similar to File, User, ForeignKeyName).
--
-- Architecture:
-- - Resources have hourly_rate (nullable money)
-- - Reservation requests link to payments.transactions via payment_transaction_id
-- - Payment amount calculated from hourly_rate × duration
-- - Payments created via initiate_reservation_request_payment() RPC
-- - Status updated via Stripe webhooks
-- - UI automatically renders payment status via DisplayPropertyComponent
--
-- Workflow:
-- 1. User creates reservation_request (unpaid)
-- 2. User clicks "Pay Now" on request detail page
-- 3. Payment succeeds → payment_transaction_id updated
-- 4. Admin approves paid request → creates finalized reservation
-- ============================================================================

\echo '============================================================================'
\echo 'Payment Integration Setup (Property Type Approach)'
\echo '============================================================================'

-- ============================================================================
-- NOTE: Core payment infrastructure (payments schema, transactions table,
-- payment_transactions view) is managed by Sqitch migration v0-13-0.
-- This script contains ONLY domain-specific payment integration for
-- the community-center example (reservation payment logic).
-- ============================================================================

-- ============================================================================
-- 1. Add payment_transaction_id column to reservation_requests
-- ============================================================================

\echo 'Adding payment_transaction_id column to reservation_requests...'

ALTER TABLE public.reservation_requests
  ADD COLUMN IF NOT EXISTS payment_transaction_id UUID
    REFERENCES payments.transactions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reservation_requests.payment_transaction_id IS
'Link to payment record in payments.transactions. Payment happens BEFORE approval.
Null if resource is free or payment not yet initiated.';

-- Create index for payment lookups
CREATE INDEX IF NOT EXISTS idx_reservation_requests_payment_id
  ON public.reservation_requests(payment_transaction_id)
  WHERE payment_transaction_id IS NOT NULL;

\echo 'Created payment_transaction_id column and index'

-- ============================================================================
-- 2. Helper function to calculate reservation cost
-- ============================================================================

\echo 'Creating calculate_reservation_cost() function...'

CREATE OR REPLACE FUNCTION public.calculate_reservation_cost(
  p_resource_id INT,
  p_time_slot time_slot
)
RETURNS NUMERIC(10,2)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_hourly_rate MONEY;
  v_duration_hours NUMERIC;
  v_cost NUMERIC(10,2);
BEGIN
  -- Get hourly rate from resource
  SELECT hourly_rate INTO v_hourly_rate
  FROM public.resources
  WHERE id = p_resource_id;

  -- If no hourly rate, reservation is free
  IF v_hourly_rate IS NULL OR v_hourly_rate::numeric <= 0 THEN
    RETURN 0.00;
  END IF;

  -- Calculate duration in hours (time_slot is tstzrange)
  v_duration_hours := EXTRACT(EPOCH FROM (
    upper(p_time_slot::tstzrange) - lower(p_time_slot::tstzrange)
  )) / 3600.0;

  -- Calculate cost (convert money to numeric for calculation)
  v_cost := v_hourly_rate::numeric * v_duration_hours;

  RETURN ROUND(v_cost, 2);
END;
$$;

COMMENT ON FUNCTION public.calculate_reservation_cost IS
'Calculate reservation cost based on resource hourly_rate and time_slot duration.
Returns 0.00 if resource has no hourly_rate (free reservation).
Formula: hourly_rate × (duration_in_hours)';

GRANT EXECUTE ON FUNCTION public.calculate_reservation_cost TO authenticated;

\echo 'Created calculate_reservation_cost() function'

-- ============================================================================
-- 3. View for reservation requests with payment information
-- ============================================================================

\echo 'Creating reservation_requests_with_payments view...'

DROP VIEW IF EXISTS public.reservation_requests_with_payments;

CREATE VIEW public.reservation_requests_with_payments AS
SELECT
  rr.id,
  rr.resource_id,
  rr.requested_by,
  rr.time_slot,
  rr.status_id,
  rr.purpose,
  rr.attendee_count,
  rr.notes,
  rr.reviewed_by,
  rr.reviewed_at,
  rr.denial_reason,
  rr.reservation_id,
  rr.payment_transaction_id,
  rr.created_at,
  rr.updated_at,
  rr.display_name,

  -- Resource info (embedded)
  res.display_name AS resource_name,
  res.hourly_rate AS resource_hourly_rate,

  -- Calculated cost
  public.calculate_reservation_cost(rr.resource_id, rr.time_slot) AS calculated_cost,

  -- Payment status (if payment exists)
  p.status AS payment_status,
  p.amount AS payment_amount,
  p.currency AS payment_currency,
  p.provider_payment_id,
  p.error_message AS payment_error_message,

  -- Payment required flag
  CASE
    WHEN res.hourly_rate IS NULL THEN FALSE
    WHEN res.hourly_rate::numeric <= 0 THEN FALSE
    ELSE TRUE
  END AS payment_required

FROM public.reservation_requests rr
JOIN public.resources res ON rr.resource_id = res.id
LEFT JOIN payments.transactions p ON rr.payment_transaction_id = p.id;

COMMENT ON VIEW public.reservation_requests_with_payments IS
'Reservation requests with embedded resource and payment information.
Includes calculated_cost and payment_required flags for UI display.
Payment happens BEFORE approval (on requests, not reservations).';

GRANT SELECT ON public.reservation_requests_with_payments TO authenticated;

\echo 'Created reservation_requests_with_payments view'

-- ============================================================================
-- 4. RPC to initiate payment for reservation request
-- ============================================================================

\echo 'Creating initiate_reservation_request_payment() RPC...'

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
  IF v_request.requested_by != current_user_id() THEN
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

COMMENT ON FUNCTION public.initiate_reservation_request_payment IS
'Initiate payment for a reservation REQUEST (before approval). Uses generalized helper
functions (payments.check_existing_payment, payments.create_and_link_payment) to reduce
boilerplate and prevent common errors. Domain-specific logic includes authorization checks,
cost calculation, and business state validation. Only request owner can initiate payment.
Returns payment_id (UUID) for tracking. Follows standardized payment RPC pattern: accepts
p_entity_id parameter.';

GRANT EXECUTE ON FUNCTION public.initiate_reservation_request_payment TO authenticated;

\echo 'Created initiate_reservation_request_payment() RPC'

-- ============================================================================
-- 5. Update mock data with hourly rates
-- ============================================================================

\echo 'Updating resources with hourly rates (for any missing rates)...'

-- Update resources that don't have hourly rates set
-- (Mock data generator creates rates for some but not all resources)
UPDATE public.resources SET hourly_rate = 50.00 WHERE display_name = 'Main Hall' AND hourly_rate IS NULL;
UPDATE public.resources SET hourly_rate = 35.00 WHERE display_name = 'Oak Studio' AND hourly_rate IS NULL;
UPDATE public.resources SET hourly_rate = 40.00 WHERE display_name = 'Garden Meeting Space' AND hourly_rate IS NULL;
UPDATE public.resources SET hourly_rate = 25.00 WHERE display_name = 'Community Room A' AND hourly_rate IS NULL;
UPDATE public.resources SET hourly_rate = 30.00 WHERE display_name = 'Community Room B' AND hourly_rate IS NULL;

\echo 'Updated resource hourly rates'

-- ============================================================================
-- 6. Metadata configuration for Payment property type
-- ============================================================================

\echo 'Configuring metadata for Payment property type...'

-- Configure payment_transaction_id property on reservation_requests
-- This will be detected as Payment property type by SchemaService
INSERT INTO metadata.properties (
  table_name, column_name,
  display_name, description,
  sort_order,
  show_on_list, show_on_create, show_on_edit, show_on_detail
) VALUES (
  'reservation_requests', 'payment_transaction_id',
  'Payment', 'Payment transaction for this reservation request',
  100,  -- Show at bottom
  TRUE, FALSE, FALSE, TRUE  -- Show on list (as badge) and detail pages
) ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- Configure payment_transactions entity for system pages
INSERT INTO metadata.entities (
  table_name, display_name, description
) VALUES (
  'payment_transactions',
  'Payment Transactions',
  'Payment processing history for all users'
) ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;

-- Configure payment initiation metadata for reservation_requests
-- This enables metadata-driven payment flow (v0.13.0+)
-- NOTE: The v0-13-0-add-payment-metadata migration adds the columns to metadata.entities
-- and updates the schema_entities view. This init script sets the domain-specific values.
UPDATE metadata.entities
SET
  payment_initiation_rpc = 'initiate_reservation_request_payment',
  payment_capture_mode = 'immediate'
WHERE table_name = 'reservation_requests';

\echo 'Configured metadata (including payment initiation RPC)'

\echo '============================================================================'
\echo 'Payment integration setup complete (Property Type Approach)!'
\echo ''
\echo 'Summary:'
\echo '  - Core infrastructure (payments schema, transactions table, view) loaded from migration v0-13-0'
\echo '  - Added payment_transaction_id column to reservation_requests (domain-specific FK)'
\echo '  - Created calculate_reservation_cost() helper function (domain logic)'
\echo '  - Created reservation_requests_with_payments view (domain convenience)'
\echo '  - Created initiate_reservation_request_payment(p_entity_id) RPC (domain payment flow)'
\echo '  - Configured metadata-driven payment initiation (payment_initiation_rpc, capture mode)'
\echo '  - Updated resources with sample hourly rates ($25-$50)'
\echo '  - Configured Payment property type metadata'
\echo ''
\echo 'Workflow:'
\echo '  1. User creates reservation_request (unpaid)'
\echo '  2. User clicks "Pay Now" on request detail page (framework calls configured RPC)'
\echo '  3. Payment succeeds → payment_transaction_id updated'
\echo '  4. Admin approves paid request → creates finalized reservation'
\echo '============================================================================'
