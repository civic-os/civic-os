-- ============================================================================
-- MOTT PARK - PAYMENT STATUS SYNC TRIGGERS
-- ============================================================================
-- Syncs payment status from Stripe to reservation_payments via two triggers:
--
-- 1. payments.transactions → reservation_payments (payment success/failure)
-- 2. payments.refunds → reservation_payments (refund processing)
--
-- Status Mapping:
--   transactions.status    →  reservation_payments.status
--   'succeeded'            →  'Paid'
--   'failed'/'canceled'    →  (stays 'Pending' - user can retry)
--
--   refunds.status         →  reservation_payments.status
--   'succeeded'            →  'Refunded' (updates refund_amount, refund_processed_at)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: PAYMENT SUCCESS/FAILURE TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_reservation_payment_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_paid_status_id INT;
  v_pending_status_id INT;
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

  -- Update reservation_payments that reference this transaction
  IF NEW.status = 'succeeded' THEN
    -- Payment succeeded → mark as Paid
    UPDATE reservation_payments
    SET
      status_id = v_paid_status_id,
      paid_at = NOW(),
      paid_amount = NEW.amount::MONEY
    WHERE payment_transaction_id = NEW.id
      AND status_id != v_paid_status_id;  -- Don't update if already Paid

    IF FOUND THEN
      RAISE NOTICE 'Payment succeeded: updated reservation_payment to Paid for transaction %', NEW.id;
    END IF;

  ELSIF NEW.status IN ('failed', 'canceled') THEN
    -- Payment failed/canceled → keep as Pending (user can retry)
    -- Clear the transaction link so user can create a new payment attempt
    UPDATE reservation_payments
    SET payment_transaction_id = NULL
    WHERE payment_transaction_id = NEW.id
      AND status_id = v_pending_status_id;  -- Only clear if still Pending

    IF FOUND THEN
      RAISE NOTICE 'Payment %: cleared transaction link for retry (transaction %)', NEW.status, NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_reservation_payment_status_trigger ON payments.transactions;

CREATE TRIGGER sync_reservation_payment_status_trigger
  AFTER UPDATE OF status ON payments.transactions
  FOR EACH ROW
  EXECUTE FUNCTION sync_reservation_payment_status();

-- ============================================================================
-- SECTION 2: REFUND SUCCESS TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_reservation_payment_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_refunded_status_id INT;
  v_transaction_id UUID;
  v_total_refunded NUMERIC;
BEGIN
  -- Only process if status changed to 'succeeded'
  IF TG_OP = 'UPDATE' AND NEW.status = 'succeeded' AND OLD.status != 'succeeded' THEN

    -- Get the Refunded status ID
    SELECT id INTO v_refunded_status_id
    FROM metadata.statuses
    WHERE entity_type = 'reservation_payment' AND display_name = 'Refunded';

    -- Calculate total refunded amount for this transaction
    -- (supports multiple partial refunds)
    SELECT COALESCE(SUM(amount), 0) INTO v_total_refunded
    FROM payments.refunds
    WHERE transaction_id = NEW.transaction_id
      AND status = 'succeeded';

    -- Update the reservation_payment linked to this transaction
    UPDATE reservation_payments
    SET
      status_id = v_refunded_status_id,
      refund_amount = v_total_refunded::MONEY,
      refund_processed_at = NOW()
    WHERE payment_transaction_id = NEW.transaction_id;

    IF FOUND THEN
      RAISE NOTICE 'Refund succeeded: updated reservation_payment to Refunded (amount: %) for transaction %',
        v_total_refunded, NEW.transaction_id;
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_reservation_payment_refund_trigger ON payments.refunds;

CREATE TRIGGER sync_reservation_payment_refund_trigger
  AFTER UPDATE OF status ON payments.refunds
  FOR EACH ROW
  EXECUTE FUNCTION sync_reservation_payment_refund();

-- ============================================================================
-- SECTION 3: VERIFICATION
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE 'PAYMENT STATUS SYNC TRIGGERS INSTALLED';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'When payments.transactions.status changes:';
  RAISE NOTICE '  succeeded → reservation_payments.status = Paid';
  RAISE NOTICE '  failed    → transaction link cleared (retry allowed)';
  RAISE NOTICE '  canceled  → transaction link cleared (retry allowed)';
  RAISE NOTICE '';
  RAISE NOTICE 'When payments.refunds.status changes to succeeded:';
  RAISE NOTICE '  → reservation_payments.status = Refunded';
  RAISE NOTICE '  → refund_amount updated with total refunded';
  RAISE NOTICE '  → refund_processed_at set to NOW()';
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════';
END;
$$;

COMMIT;

-- Notify PostgREST to refresh
NOTIFY pgrst, 'reload schema';
