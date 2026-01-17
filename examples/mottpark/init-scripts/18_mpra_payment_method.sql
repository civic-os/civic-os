-- =============================================================================
-- PAYMENT METHOD & MANUAL PAYMENT RECORDING
--
-- 1. Add Payment Method status type (Cash, Check, Credit Card, Money Order, CashApp)
-- 2. Add payment_date field, migrate from paid_at
-- 3. Enable manual payment recording via entity action buttons
-- 4. Remove refund tracking fields (refund_requested_at, etc.)
-- 5. Remove waiver audit fields (waived_by, waived_at, waiver_reason)
--
-- LOGICAL DEPENDENCY: Should be run after 17_mpra_cancel_waives_pending.sql
--
-- This script is idempotent and safe to re-run.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: Add Payment Method Status Type
-- =============================================================================

-- First register the entity type
INSERT INTO metadata.status_types (entity_type, description)
VALUES ('payment_method', 'Payment method types for tracking how payments were received')
ON CONFLICT (entity_type) DO NOTHING;

-- Then add the status values
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal)
VALUES
  ('payment_method', 'Cash', 'Cash payment received in person', '#22C55E', 1, FALSE, TRUE),
  ('payment_method', 'Check', 'Payment by personal or business check', '#3B82F6', 2, FALSE, TRUE),
  ('payment_method', 'Credit Card', 'Online credit/debit card via Stripe', '#8B5CF6', 3, FALSE, TRUE),
  ('payment_method', 'Money Order', 'Payment by money order', '#F59E0B', 4, FALSE, TRUE),
  ('payment_method', 'CashApp', 'Payment via CashApp transfer', '#10B981', 5, FALSE, TRUE)
ON CONFLICT (entity_type, display_name) DO UPDATE SET
  description = EXCLUDED.description,
  color = EXCLUDED.color,
  sort_order = EXCLUDED.sort_order;

-- =============================================================================
-- PART 2: Schema Changes
-- =============================================================================

-- 2.1 Add payment_method_id column
ALTER TABLE reservation_payments
ADD COLUMN IF NOT EXISTS payment_method_id INT REFERENCES metadata.statuses(id);

-- 2.2 Create index on new FK
CREATE INDEX IF NOT EXISTS idx_reservation_payments_payment_method
ON reservation_payments(payment_method_id);

-- 2.3 Add payment_date column (will migrate from paid_at)
ALTER TABLE reservation_payments
ADD COLUMN IF NOT EXISTS payment_date DATE;

-- 2.4 Add can_record_payment column for button visibility
ALTER TABLE reservation_payments
ADD COLUMN IF NOT EXISTS can_record_payment BOOLEAN DEFAULT FALSE;

-- 2.5 Migrate existing paid_at data to payment_date
UPDATE reservation_payments
SET payment_date = (paid_at AT TIME ZONE 'America/Detroit')::DATE
WHERE paid_at IS NOT NULL AND payment_date IS NULL;

-- 2.6 Set Credit Card method for existing Stripe payments
UPDATE reservation_payments rp
SET payment_method_id = s.id
FROM metadata.statuses s
WHERE s.entity_type = 'payment_method'
  AND s.display_name = 'Credit Card'
  AND rp.payment_transaction_id IS NOT NULL
  AND rp.payment_method_id IS NULL;

-- 2.7 Drop deprecated columns (paid_at, refund_*, waived_*)
ALTER TABLE reservation_payments
  DROP COLUMN IF EXISTS paid_at,
  DROP COLUMN IF EXISTS refund_requested_at,
  DROP COLUMN IF EXISTS refund_processed_at,
  DROP COLUMN IF EXISTS refund_amount,
  DROP COLUMN IF EXISTS refund_notes,
  DROP COLUMN IF EXISTS waived_by,
  DROP COLUMN IF EXISTS waived_at,
  DROP COLUMN IF EXISTS waiver_reason;

-- =============================================================================
-- PART 3: Update display_name Trigger
-- =============================================================================
-- Format: "Security Deposit - $150.00 (Paid - Cash)"

CREATE OR REPLACE FUNCTION set_payment_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_type_name TEXT;
  v_status_name TEXT;
  v_method_name TEXT;
BEGIN
  -- Get payment type name
  SELECT display_name INTO v_type_name
  FROM reservation_payment_types
  WHERE id = NEW.payment_type_id;

  -- Get status name
  SELECT display_name INTO v_status_name
  FROM metadata.statuses
  WHERE id = NEW.status_id;

  -- Get payment method name (if set)
  IF NEW.payment_method_id IS NOT NULL THEN
    SELECT display_name INTO v_method_name
    FROM metadata.statuses
    WHERE id = NEW.payment_method_id;
  END IF;

  -- Build display name: "Type - $amount (Status)" or "Type - $amount (Status - Method)"
  NEW.display_name := COALESCE(v_type_name, 'Payment') || ' - ' ||
                      NEW.amount::TEXT ||
                      ' (' || COALESCE(v_status_name, 'Unknown');

  IF v_method_name IS NOT NULL THEN
    NEW.display_name := NEW.display_name || ' - ' || v_method_name;
  END IF;

  NEW.display_name := NEW.display_name || ')';

  RETURN NEW;
END;
$$;

-- Update trigger to fire on payment_method_id changes too
DROP TRIGGER IF EXISTS set_payment_display_name_trigger ON reservation_payments;

CREATE TRIGGER set_payment_display_name_trigger
  BEFORE INSERT OR UPDATE OF payment_type_id, status_id, amount, payment_method_id ON reservation_payments
  FOR EACH ROW
  EXECUTE FUNCTION set_payment_display_name();

-- =============================================================================
-- PART 4: Update Stripe Sync Trigger
-- =============================================================================
-- Auto-sets payment_method_id to Credit Card and payment_date when Stripe succeeds

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
BEGIN
  -- Only process if status actually changed
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Get the reservation_payment status IDs
  SELECT id INTO v_paid_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Paid';

  SELECT id INTO v_pending_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Pending';

  -- Get Credit Card payment method ID
  SELECT id INTO v_credit_card_method_id
  FROM metadata.statuses
  WHERE entity_type = 'payment_method' AND display_name = 'Credit Card';

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
-- PART 5: Remove Refund Sync Trigger (no longer needed)
-- =============================================================================

DROP TRIGGER IF EXISTS sync_reservation_payment_refund_trigger ON payments.refunds;
DROP FUNCTION IF EXISTS sync_reservation_payment_refund();

-- =============================================================================
-- PART 6: Manual Payment RPC Functions
-- =============================================================================

-- Core function that handles all payment methods
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

  -- Get status IDs
  SELECT id INTO v_paid_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Paid';

  SELECT id INTO v_pending_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Pending';

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

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Payment recorded as %s on %s', p_payment_method, v_actual_date::TEXT),
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_manual_payment(BIGINT, TEXT, DATE) TO authenticated;

-- Wrapper functions for entity action buttons (single parameter required)
CREATE OR REPLACE FUNCTION public.record_cash_payment(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN record_manual_payment(p_entity_id, 'Cash');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_check_payment(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN record_manual_payment(p_entity_id, 'Check');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_money_order_payment(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN record_manual_payment(p_entity_id, 'Money Order');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_cashapp_payment(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN record_manual_payment(p_entity_id, 'CashApp');
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_cash_payment(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_check_payment(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_money_order_payment(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_cashapp_payment(BIGINT) TO authenticated;

-- =============================================================================
-- PART 7: can_record_payment Trigger & Entity Action Buttons
-- =============================================================================

-- Trigger to maintain can_record_payment flag
CREATE OR REPLACE FUNCTION update_can_record_payment()
RETURNS TRIGGER AS $$
DECLARE
  v_pending_status_id INT;
BEGIN
  SELECT id INTO v_pending_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Pending';

  NEW.can_record_payment := (NEW.status_id = v_pending_status_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_payments_can_record ON reservation_payments;

CREATE TRIGGER trg_reservation_payments_can_record
  BEFORE INSERT OR UPDATE OF status_id ON reservation_payments
  FOR EACH ROW EXECUTE FUNCTION update_can_record_payment();

-- Initialize existing records
UPDATE reservation_payments rp SET
  can_record_payment = (rp.status_id = (
    SELECT id FROM metadata.statuses
    WHERE entity_type = 'reservation_payment' AND display_name = 'Pending'
  ));

-- Register entity action buttons
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description, rpc_function,
  icon, button_style, sort_order,
  requires_confirmation, confirmation_message,
  visibility_condition,
  default_success_message, refresh_after_action, show_on_detail
) VALUES
  ('reservation_payments', 'record_cash', 'Record Cash', 'Mark payment as received in cash', 'record_cash_payment',
   'payments', 'success', 10, TRUE, 'Mark this payment as received in cash?',
   '{"field": "can_record_payment", "operator": "eq", "value": true}'::jsonb,
   'Cash payment recorded', TRUE, TRUE),
  ('reservation_payments', 'record_check', 'Record Check', 'Mark payment as received by check', 'record_check_payment',
   'receipt_long', 'secondary', 11, TRUE, 'Mark this payment as received by check?',
   '{"field": "can_record_payment", "operator": "eq", "value": true}'::jsonb,
   'Check payment recorded', TRUE, TRUE),
  ('reservation_payments', 'record_money_order', 'Record Money Order', 'Mark payment as received by money order', 'record_money_order_payment',
   'request_quote', 'secondary', 12, TRUE, 'Mark this payment as received by money order?',
   '{"field": "can_record_payment", "operator": "eq", "value": true}'::jsonb,
   'Money order payment recorded', TRUE, TRUE),
  ('reservation_payments', 'record_cashapp', 'Record CashApp', 'Mark payment as received via CashApp', 'record_cashapp_payment',
   'phone_iphone', 'success', 13, TRUE, 'Mark this payment as received via CashApp?',
   '{"field": "can_record_payment", "operator": "eq", "value": true}'::jsonb,
   'CashApp payment recorded', TRUE, TRUE)
ON CONFLICT (table_name, action_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  rpc_function = EXCLUDED.rpc_function,
  icon = EXCLUDED.icon,
  button_style = EXCLUDED.button_style,
  visibility_condition = EXCLUDED.visibility_condition,
  requires_confirmation = EXCLUDED.requires_confirmation,
  confirmation_message = EXCLUDED.confirmation_message;

-- Grant actions to manager and admin roles
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reservation_payments'
  AND ea.action_name LIKE 'record_%'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- PART 8: Update Existing Functions (remove waiver column references)
-- =============================================================================

-- 8.1 Update waive_all_reservation_payments
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
  v_request RECORD;
  v_waived_count INT;
BEGIN
  -- Get status IDs
  SELECT id INTO v_waived_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Waived';

  SELECT id INTO v_pending_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Pending';

  SELECT id INTO v_approved_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  -- Verify request exists and is Approved
  SELECT * INTO v_request FROM reservation_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  IF v_request.status_id != v_approved_status_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Can only waive fees for approved reservations');
  END IF;

  -- Check permission (manager or admin)
  IF NOT ('manager' = ANY(public.get_user_roles()) OR public.is_admin()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only managers can waive fees');
  END IF;

  -- Waive all pending payments (no longer sets waived_by/waived_at/waiver_reason)
  UPDATE reservation_payments SET
    status_id = v_waived_status_id
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_pending_status_id;

  GET DIAGNOSTICS v_waived_count = ROW_COUNT;

  IF v_waived_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'No pending payments to waive');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', format('%s payment(s) waived successfully', v_waived_count),
    'refresh', true
  );
END;
$$;

-- 8.2 Update cancel_reservation_request (uses Cancelled status, no waiver columns)
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
-- PART 9: Metadata Properties Configuration
-- =============================================================================

-- Configure payment_method_id property for frontend
INSERT INTO metadata.properties (
  table_name, column_name, display_name, description,
  sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail,
  status_entity_type, filterable
) VALUES (
  'reservation_payments', 'payment_method_id', 'Payment Method', 'How the payment was received',
  6, TRUE, FALSE, FALSE, TRUE, 'payment_method', TRUE
) ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  status_entity_type = EXCLUDED.status_entity_type,
  filterable = EXCLUDED.filterable;

-- Configure payment_date property
INSERT INTO metadata.properties (
  table_name, column_name, display_name, description,
  sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail
) VALUES (
  'reservation_payments', 'payment_date', 'Payment Date', 'Date payment was received',
  7, TRUE, FALSE, FALSE, TRUE
) ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- Hide can_record_payment from UI (internal use only)
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('reservation_payments', 'can_record_payment', FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = FALSE, show_on_detail = FALSE, show_on_create = FALSE, show_on_edit = FALSE;

-- Clean up metadata for dropped columns
DELETE FROM metadata.properties
WHERE table_name = 'reservation_payments'
  AND column_name IN ('paid_at', 'refund_requested_at', 'refund_processed_at', 'refund_amount',
                      'refund_notes', 'waived_by', 'waived_at', 'waiver_reason');

-- =============================================================================
-- PART 10: Refresh display_name for all existing payments
-- =============================================================================

-- Touch all payment records to trigger display_name update
UPDATE reservation_payments SET updated_at = NOW();

-- =============================================================================
-- Reload PostgREST schema cache
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
