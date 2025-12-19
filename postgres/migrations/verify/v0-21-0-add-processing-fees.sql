-- Verify civic-os:v0-21-0-add-processing-fees on pg

BEGIN;

-- Verify processing fee columns exist on payments.transactions
SELECT
    processing_fee,
    fee_percent,
    fee_flat_cents,
    fee_refundable,
    total_amount,
    max_refundable
FROM payments.transactions
WHERE FALSE;

-- Verify payment_transactions view has new columns
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
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'initiate_payment_refund'
  AND pronamespace = 'public'::regnamespace;

-- Verify effective_status function exists
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'effective_status'
  AND pronamespace = 'payments'::regnamespace;

ROLLBACK;
