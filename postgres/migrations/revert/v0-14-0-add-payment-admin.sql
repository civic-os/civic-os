-- Revert civic-os:v0-14-0-add-payment-admin from pg

BEGIN;

-- ============================================================================
-- Revert in reverse order of creation
-- ============================================================================

-- 11. Revoke grants
REVOKE SELECT ON public.payment_refunds FROM authenticated;

-- 10. Drop notification triggers and functions
DROP TRIGGER IF EXISTS refund_succeeded_notification ON payments.refunds;
DROP TRIGGER IF EXISTS payment_succeeded_notification ON payments.transactions;
DROP FUNCTION IF EXISTS payments.notify_refund_succeeded();
DROP FUNCTION IF EXISTS payments.notify_payment_succeeded();

-- 9. Remove notification templates
DELETE FROM metadata.notification_templates WHERE name IN ('payment_refunded', 'payment_succeeded');

-- 8. Drop computed field function
DROP FUNCTION IF EXISTS payments.effective_status(payments.transactions);

-- 7. Drop refunds view
DROP VIEW IF EXISTS public.payment_refunds;

-- 6. Drop refund RPC function
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'initiate_payment_refund') THEN
        REVOKE EXECUTE ON FUNCTION public.initiate_payment_refund(UUID, NUMERIC, TEXT) FROM authenticated;
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.initiate_payment_refund(UUID, NUMERIC, TEXT);

-- 5. Restore original payment_transactions view (without user info, effective_status, refund data)
-- Must DROP and recreate because column structure changed
DROP VIEW IF EXISTS public.payment_transactions;

CREATE VIEW public.payment_transactions AS
SELECT
    id,
    user_id,
    amount,
    currency,
    status,
    error_message,
    provider,
    provider_payment_id,
    provider_client_secret,
    description,
    display_name,
    created_at,
    updated_at
FROM payments.transactions;

GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;

-- 4. Remove entity reference columns from transactions
-- Note: refund_id column no longer exists (1:M design uses refunds.transaction_id FK instead)
DROP INDEX IF EXISTS idx_transactions_entity;
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS entity_type;
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS entity_id;

-- 3. Drop refunds table (must be after removing FK from transactions)
DROP POLICY IF EXISTS "Refund managers create refunds" ON payments.refunds;
DROP POLICY IF EXISTS "Refund managers see refunds" ON payments.refunds;
DROP TABLE IF EXISTS payments.refunds;

-- 2. Drop permission-based RLS policy
DROP POLICY IF EXISTS "Payment managers see all payments" ON payments.transactions;

-- 1. Remove payment permissions
-- Must delete permission_roles first due to FK constraint
DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT id FROM metadata.permissions
  WHERE table_name IN ('payment_transactions', 'payment_refunds')
);

DELETE FROM metadata.permissions
WHERE table_name IN ('payment_transactions', 'payment_refunds');

COMMIT;
