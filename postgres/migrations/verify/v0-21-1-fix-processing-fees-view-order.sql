-- Verify civic-os:v0-21-1-fix-processing-fees-view-order on pg

BEGIN;

-- Verify processing fee columns exist on payments.transactions
SELECT
    processing_fee,
    total_amount,
    max_refundable,
    fee_percent,
    fee_flat_cents,
    fee_refundable
FROM payments.transactions
WHERE FALSE;

-- Verify payment_transactions view includes fee columns
SELECT
    processing_fee,
    total_amount,
    max_refundable,
    fee_percent,
    fee_flat_cents,
    fee_refundable
FROM public.payment_transactions
WHERE FALSE;

-- Verify initiate_payment_refund function exists
SELECT has_function_privilege('public.initiate_payment_refund(uuid, numeric, text)', 'execute');

ROLLBACK;
