-- Revert civic-os:v0-21-1-fix-processing-fees-view-order from pg
-- requires: v0-21-0-add-processing-fees

BEGIN;

-- ============================================================================
-- 1. DROP THE NEW VIEW
-- ============================================================================
DROP VIEW IF EXISTS public.payment_transactions;

-- ============================================================================
-- 2. REMOVE PROCESSING FEE COLUMNS
-- ============================================================================
-- Remove in reverse order of addition

-- Drop display_name (will be recreated with original definition)
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS display_name;

-- Drop generated columns
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS max_refundable;
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS total_amount;

-- Drop fee columns
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS fee_refundable;
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS fee_flat_cents;
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS fee_percent;
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS processing_fee;

-- Recreate original display_name
ALTER TABLE payments.transactions
ADD COLUMN display_name TEXT GENERATED ALWAYS AS (
    '$' || amount::TEXT || ' - ' ||
    CASE status
        WHEN 'pending_intent' THEN 'Creating...'
        WHEN 'pending' THEN 'Pending'
        WHEN 'succeeded' THEN 'Paid'
        WHEN 'failed' THEN 'Failed'
        WHEN 'canceled' THEN 'Canceled'
        ELSE UPPER(status)
    END
) STORED;

-- ============================================================================
-- 3. RECREATE ORIGINAL VIEW (without fee columns)
-- ============================================================================
CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,
    u.email AS user_email,
    t.amount,
    t.currency,
    t.status,
    t.effective_status,
    t.description,
    t.display_name,
    t.provider,
    t.provider_payment_id,
    t.provider_client_secret,
    t.created_at,
    t.updated_at,
    t.error_message,
    t.total_refunded,
    t.refund_count,
    t.pending_refund_count
FROM payments.transactions t
LEFT JOIN metadata.civic_os_users u ON t.user_id = u.id;

GRANT SELECT ON public.payment_transactions TO authenticated;
GRANT SELECT ON public.payment_transactions TO web_anon;

COMMENT ON VIEW public.payment_transactions IS
    'Public view of payment transactions with user details joined.';

-- ============================================================================
-- 4. RESTORE ORIGINAL initiate_payment_refund RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.initiate_payment_refund(
    p_payment_id UUID,
    p_amount NUMERIC(10, 2),
    p_reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_payment RECORD;
    v_refund_id UUID;
    v_total_refunded NUMERIC(10, 2);
BEGIN
    -- 1. Fetch payment with lock
    SELECT * INTO v_payment
    FROM payments.transactions
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment not found: %', p_payment_id;
    END IF;

    -- 2. Authorization: Admin only
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Only administrators can initiate refunds';
    END IF;

    -- 3. Validate payment status
    IF v_payment.status != 'succeeded' THEN
        RAISE EXCEPTION 'Can only refund succeeded payments (current status: %)', v_payment.status;
    END IF;

    -- 4. Validate refund amount
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Refund amount must be positive';
    END IF;

    -- Calculate total already refunded (completed + pending)
    v_total_refunded := COALESCE(v_payment.total_refunded, 0);

    -- Check total doesn't exceed original amount
    IF v_total_refunded + p_amount > v_payment.amount THEN
        RAISE EXCEPTION 'Refund amount ($%) exceeds remaining refundable balance ($%)',
            p_amount, (v_payment.amount - v_total_refunded);
    END IF;

    -- 5. Check for existing pending refund
    IF EXISTS (
        SELECT 1 FROM payments.refunds
        WHERE payment_id = p_payment_id AND status = 'pending'
    ) THEN
        RAISE EXCEPTION 'A refund is already pending for this payment. Wait for it to complete or cancel it.';
    END IF;

    -- 6. Create refund record
    INSERT INTO payments.refunds (
        payment_id,
        amount,
        reason,
        status,
        initiated_by
    ) VALUES (
        p_payment_id,
        p_amount,
        p_reason,
        'pending',
        current_user_id()
    )
    RETURNING id INTO v_refund_id;

    RETURN v_refund_id;
END;
$$;

COMMENT ON FUNCTION public.initiate_payment_refund IS
    'Initiate a refund for a succeeded payment. Admin only. Creates refund record and enqueues River job.';

COMMIT;
