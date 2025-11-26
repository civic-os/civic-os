-- Verify civic-os:v0-14-0-add-payment-admin on pg

BEGIN;

-- ============================================================================
-- 1. Verify payment permissions exist
-- ============================================================================
SELECT 1/COUNT(*) FROM metadata.permissions
WHERE table_name = 'payment_transactions' AND permission = 'read';

SELECT 1/COUNT(*) FROM metadata.permissions
WHERE table_name = 'payment_refunds' AND permission = 'read';

SELECT 1/COUNT(*) FROM metadata.permissions
WHERE table_name = 'payment_refunds' AND permission = 'create';

-- ============================================================================
-- 2. Verify permission-based RLS policy exists
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_policy
WHERE polname = 'Payment managers see all payments'
AND polrelid = 'payments.transactions'::regclass;

-- ============================================================================
-- 3. Verify refunds table exists with correct columns
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables
WHERE schemaname = 'payments' AND tablename = 'refunds';

SELECT
    id,
    transaction_id,
    amount,
    reason,
    initiated_by,
    provider_refund_id,
    status,
    error_message,
    created_at,
    processed_at
FROM payments.refunds
WHERE FALSE;

-- Verify refunds table indexes
SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'refunds'
AND indexname = 'idx_refunds_transaction_id';

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'refunds'
AND indexname = 'idx_refunds_status';

-- Verify refunds RLS is enabled
SELECT 1/COUNT(*) FROM pg_catalog.pg_class
WHERE oid = 'payments.refunds'::regclass
AND relrowsecurity = true;

-- Verify refunds RLS policies
SELECT 1/COUNT(*) FROM pg_catalog.pg_policy
WHERE polname = 'Refund managers see refunds'
AND polrelid = 'payments.refunds'::regclass;

SELECT 1/COUNT(*) FROM pg_catalog.pg_policy
WHERE polname = 'Refund managers create refunds'
AND polrelid = 'payments.refunds'::regclass;

-- ============================================================================
-- 4. Verify entity reference columns added to transactions
-- Note: refund_id column no longer exists (1:M design uses refunds.transaction_id FK)
-- ============================================================================
SELECT entity_type, entity_id FROM payments.transactions WHERE FALSE;

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'transactions'
AND indexname = 'idx_transactions_entity';

-- ============================================================================
-- 5. Verify updated payment_transactions view has new columns
-- Note: Uses aggregated refund data (total_refunded, refund_count, pending_refund_count)
-- instead of single refund FK columns
-- ============================================================================
SELECT
    user_display_name,
    user_full_name,
    user_email,
    provider_payment_id,
    total_refunded,
    refund_count,
    pending_refund_count,
    effective_status,
    entity_type,
    entity_id,
    entity_display_name
FROM public.payment_transactions
WHERE FALSE;

-- ============================================================================
-- 6. Verify refund RPC function exists
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc
WHERE proname = 'initiate_payment_refund'
AND pronargs = 3;  -- Takes 3 arguments (payment_id, amount, reason)

-- ============================================================================
-- 7. Verify refunds view exists (with Stripe IDs for cross-reference)
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_views
WHERE schemaname = 'public' AND viewname = 'payment_refunds';

SELECT
    id,
    transaction_id,
    amount,
    reason,
    initiated_by,
    initiated_by_name,
    provider_refund_id,
    status,
    payment_amount,
    payment_description,
    provider_payment_id  -- pi_* for Stripe cross-reference
FROM public.payment_refunds
WHERE FALSE;

-- ============================================================================
-- 8. Verify computed field function exists
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'payments'
AND p.proname = 'effective_status';

-- ============================================================================
-- 9. Verify notification templates exist
-- ============================================================================
SELECT 1/COUNT(*) FROM metadata.notification_templates
WHERE name = 'payment_refunded';

SELECT 1/COUNT(*) FROM metadata.notification_templates
WHERE name = 'payment_succeeded';

-- ============================================================================
-- 10. Verify notification trigger functions exist
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'payments'
AND p.proname = 'notify_payment_succeeded';

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'payments'
AND p.proname = 'notify_refund_succeeded';

-- ============================================================================
-- 11. Verify notification triggers exist
-- ============================================================================
SELECT 1/COUNT(*) FROM pg_catalog.pg_trigger
WHERE tgname = 'payment_succeeded_notification'
AND tgrelid = 'payments.transactions'::regclass;

SELECT 1/COUNT(*) FROM pg_catalog.pg_trigger
WHERE tgname = 'refund_succeeded_notification'
AND tgrelid = 'payments.refunds'::regclass;

ROLLBACK;
