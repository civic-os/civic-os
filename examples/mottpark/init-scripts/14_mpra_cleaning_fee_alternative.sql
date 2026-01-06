-- ============================================================================
-- MOTT PARK: CLEANING FEE ALTERNATIVE PAYMENT
-- ============================================================================
-- This script modifies the payment system to block credit card payments for
-- Cleaning Fees and direct users to pay Rosemary Morrow directly via CashApp,
-- Money Order, or Check.
--
-- Changes:
-- 1. Modify initiate_reservation_payment to block CC for cleaning fees
-- 2. Add static text explaining cleaning fee payment process
-- 3. Update dashboard widget with payment methods per fee type
-- 4. Update cleaning fee type description
-- ============================================================================

-- ============================================================================
-- SECTION 1: MODIFY PAYMENT INITIATION RPC
-- Block credit card payments for Cleaning Fee
-- ============================================================================

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
  IF v_request.requestor_id != current_user_id() AND NOT is_admin() THEN
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

COMMENT ON FUNCTION public.initiate_reservation_payment IS
'Initiate Stripe payment for a specific reservation payment record.
Each reservation has 3 payment records (deposit, facility, cleaning).
Users click "Pay Now" on each individual payment to process it.
NOTE: Cleaning Fee payments are blocked - must pay Rosemary Morrow directly.';

-- ============================================================================
-- SECTION 2: ADD STATIC TEXT FOR RESERVATION_PAYMENTS DETAIL PAGE
-- Shows payment instructions on all reservation payment detail pages
-- ============================================================================

INSERT INTO metadata.static_text (
  table_name, content, sort_order, column_width,
  show_on_detail, show_on_create, show_on_edit
) VALUES (
  'reservation_payments',
  '### Cleaning Fee Payment Instructions

**Cleaning Fee payments cannot be made by credit card.** Please pay Rosemary Morrow directly using one of these methods:

- **CashApp**: $RoseMorrowTxLady
- **Money Order or Check**: Payable to Rosemary Morrow
  - Mail to: Mott Park Club House, 2401 Nolen Drive, Flint, Michigan 48504
  - Or drop off at the clubhouse mailbox on the front door

**Questions?** Contact Rose at 810-247-8681 or Stormprincess24@gmail.com

*Security Deposit and Facility Fee can be paid online using the Pay Now button.*',
  1, 8,
  TRUE, FALSE, FALSE
);

-- ============================================================================
-- SECTION 3: UPDATE DASHBOARD WIDGET WITH PAYMENT METHODS
-- Add payment method column to pricing table
-- ============================================================================

UPDATE metadata.dashboard_widgets
SET config = jsonb_set(config, '{content}',
  '"### How It Works\n\n1. **Check Availability** - Use the calendar below to see open dates\n2. **Submit Request** - Click \"Request a Reservation\" and fill out the form\n3. **Wait for Approval** - Staff will review within 2-3 business days\n4. **Make Payment** - Once approved, pay your deposit and fees\n\n### Pricing\n\n| Fee | Amount | When Due | Payment Method |\n|-----|--------|----------|----------------|\n| Security Deposit | $150 | Upon approval | Credit Card |\n| Facility Fee (Weekday) | $150 | 30 days before | Credit Card |\n| Facility Fee (Weekend/Holiday) | $300 | 30 days before | Credit Card |\n| Cleaning Fee | $75 | 30 days before | **CashApp/Check/Money Order** |\n\n*Security deposit is refundable after event if no damages.*\n\n**Cleaning Fee**: Pay to Rosemary Morrow via CashApp ($RoseMorrowTxLady), check, or money order."'
)
WHERE id = 14;

-- ============================================================================
-- SECTION 4: UPDATE CLEANING FEE TYPE DESCRIPTION
-- Add payment instructions to the fee type itself
-- ============================================================================

UPDATE public.reservation_payment_types
SET description = 'Non-refundable cleaning fee due prior to event. Pay directly to Rosemary Morrow via CashApp ($RoseMorrowTxLady) or check/money order mailed to Mott Park Club House.'
WHERE code = 'cleaning_fee';

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';
