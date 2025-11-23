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
  p_request_id BIGINT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request RECORD;
  v_cost NUMERIC(10,2);
  v_payment_id UUID;
  v_description TEXT;
BEGIN
  -- Get reservation request details (with row lock to prevent race conditions)
  SELECT rr.*, res.display_name AS resource_name, res.hourly_rate
  INTO v_request
  FROM public.reservation_requests rr
  JOIN public.resources res ON rr.resource_id = res.id
  WHERE rr.id = p_request_id
  FOR UPDATE;  -- Lock row during payment creation

  -- Check request exists
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation request not found: %', p_request_id;
  END IF;

  -- Check user owns request
  IF v_request.requested_by != current_user_id() THEN
    RAISE EXCEPTION 'Permission denied: can only pay for own requests';
  END IF;

  -- If payment already exists, handle based on status
  IF v_request.payment_transaction_id IS NOT NULL THEN
    DECLARE
      v_payment_status TEXT;
    BEGIN
      -- Get current payment status
      SELECT status INTO v_payment_status
      FROM payments.transactions
      WHERE id = v_request.payment_transaction_id;

      -- For pending_intent/pending: return existing payment (reuse PaymentIntent)
      IF v_payment_status IN ('pending_intent', 'pending') THEN
        RETURN v_request.payment_transaction_id;
      END IF;

      -- For failed/canceled: CREATE NEW TRANSACTION (don't modify old one)
      -- Old transaction stays in DB as audit trail with failed/canceled status
      -- Fall through to create new transaction below
      IF v_payment_status IN ('failed', 'canceled') THEN
        -- Don't modify old transaction - just fall through to create new one
        NULL;  -- Explicit no-op, fall through to transaction creation
      END IF;

      -- For succeeded: payment already completed
      IF v_payment_status = 'succeeded' THEN
        RAISE EXCEPTION 'Payment already succeeded for this request';
      END IF;
    END;
  END IF;

  -- Check request is still pending (can't pay for approved/denied requests)
  -- Assuming status_id = 1 is 'Pending'
  IF v_request.status_id != 1 THEN
    RAISE EXCEPTION 'Can only pay for pending requests (current status: %)', v_request.status_id;
  END IF;

  -- Calculate cost
  v_cost := public.calculate_reservation_cost(v_request.resource_id, v_request.time_slot);

  -- Check payment is required
  IF v_cost <= 0 THEN
    RAISE EXCEPTION 'Request does not require payment (cost: $%)', v_cost;
  END IF;

  -- Build description
  v_description := format('Reservation Request for %s - %s',
    v_request.resource_name,
    v_request.purpose
  );

  -- Create payment record directly (POC schema - no entity_type/entity_id)
  INSERT INTO payments.transactions (
    user_id,
    amount,
    currency,
    status,
    description,
    provider
  ) VALUES (
    current_user_id(),
    v_cost,
    'USD',
    'pending_intent',  -- Trigger will enqueue CreateIntentJob
    v_description,
    'stripe'
  ) RETURNING id INTO v_payment_id;

  -- Link payment to reservation request
  UPDATE public.reservation_requests
  SET payment_transaction_id = v_payment_id
  WHERE id = p_request_id;

  RETURN v_payment_id;
END;
$$;

COMMENT ON FUNCTION public.initiate_reservation_request_payment IS
'Initiate payment for a reservation REQUEST (before approval). Creates payment record
in payments.transactions, which triggers River job to create Stripe payment intent.
Links payment to reservation_requests. Only request owner can initiate payment.
Returns payment_id (UUID) for tracking.';

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

\echo 'Configured metadata'

\echo '============================================================================'
\echo 'Payment integration setup complete (Property Type Approach)!'
\echo ''
\echo 'Summary:'
\echo '  - Core infrastructure (payments schema, transactions table, view) loaded from migration v0-13-0'
\echo '  - Added payment_transaction_id column to reservation_requests (domain-specific FK)'
\echo '  - Created calculate_reservation_cost() helper function (domain logic)'
\echo '  - Created reservation_requests_with_payments view (domain convenience)'
\echo '  - Created initiate_reservation_request_payment() RPC (domain payment flow)'
\echo '  - Updated resources with sample hourly rates ($10-$30)'
\echo '  - Configured Payment property type metadata'
\echo ''
\echo 'Workflow:'
\echo '  1. User creates reservation_request (unpaid)'
\echo '  2. User clicks "Pay Now" on request detail page'
\echo '  3. Payment succeeds → payment_transaction_id updated'
\echo '  4. Admin approves paid request → creates finalized reservation'
\echo '============================================================================'
