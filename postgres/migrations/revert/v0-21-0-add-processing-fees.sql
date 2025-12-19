-- Revert civic-os:v0-21-0-add-processing-fees from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE ORIGINAL effective_status FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION payments.effective_status(payments.transactions)
RETURNS text AS $$
DECLARE
    v_total_refunded NUMERIC;
    v_pending_count INTEGER;
BEGIN
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0),
        COUNT(*) FILTER (WHERE status = 'pending')
    INTO v_total_refunded, v_pending_count
    FROM payments.refunds
    WHERE transaction_id = $1.id;

    IF v_total_refunded >= $1.amount THEN
        RETURN 'refunded';
    ELSIF v_total_refunded > 0 THEN
        RETURN 'partially_refunded';
    ELSIF v_pending_count > 0 THEN
        RETURN 'refund_pending';
    ELSE
        RETURN COALESCE($1.status, 'unpaid');
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;


-- ============================================================================
-- 2. RESTORE ORIGINAL initiate_payment_refund FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.initiate_payment_refund(
    p_payment_id UUID,
    p_amount NUMERIC(10, 2),
    p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = payments, metadata, public
AS $$
DECLARE
    v_payment RECORD;
    v_refund_id UUID;
    v_user_id UUID;
    v_total_refunded NUMERIC(10, 2);
    v_pending_count INTEGER;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT public.has_permission('payment_refunds', 'create') THEN
        RAISE EXCEPTION 'Missing payment_refunds:create permission'
            USING HINT = 'Contact administrator to grant payment refund permissions';
    END IF;

    IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 10 THEN
        RAISE EXCEPTION 'Refund reason must be at least 10 characters'
            USING HINT = 'Provide a detailed reason for the refund';
    END IF;

    SELECT * INTO v_payment
    FROM payments.transactions
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment not found: %', p_payment_id;
    END IF;

    IF v_payment.status != 'succeeded' THEN
        RAISE EXCEPTION 'Can only refund succeeded payments (current status: %)', v_payment.status
            USING HINT = 'Payment must have succeeded before it can be refunded';
    END IF;

    SELECT COUNT(*) INTO v_pending_count
    FROM payments.refunds
    WHERE transaction_id = p_payment_id AND status = 'pending';

    IF v_pending_count > 0 THEN
        RAISE EXCEPTION 'Payment has % pending refund(s). Wait for them to complete before issuing another.', v_pending_count
            USING HINT = 'Pending refunds must complete or fail before new refunds can be initiated';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_total_refunded
    FROM payments.refunds
    WHERE transaction_id = p_payment_id AND status = 'succeeded';

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid refund amount: %', p_amount
            USING HINT = 'Refund amount must be greater than zero';
    END IF;

    IF v_total_refunded + p_amount > v_payment.amount THEN
        RAISE EXCEPTION 'Total refunds ($%) would exceed payment amount ($%). Already refunded: $%',
            v_total_refunded + p_amount, v_payment.amount, v_total_refunded
            USING HINT = format('Maximum additional refund allowed: $%s', v_payment.amount - v_total_refunded);
    END IF;

    INSERT INTO payments.refunds (
        transaction_id,
        amount,
        reason,
        initiated_by,
        status
    ) VALUES (
        p_payment_id,
        p_amount,
        TRIM(p_reason),
        v_user_id,
        'pending'
    ) RETURNING id INTO v_refund_id;

    INSERT INTO metadata.river_job (
        kind,
        args,
        priority,
        queue,
        max_attempts,
        scheduled_at,
        state
    ) VALUES (
        'process_refund',
        jsonb_build_object(
            'refund_id', v_refund_id,
            'payment_intent_id', v_payment.provider_payment_id,
            'amount_cents', (p_amount * 100)::INTEGER
        ),
        1,
        'default',
        3,
        NOW(),
        'available'
    );

    RAISE NOTICE 'Created refund % for payment % (amount: $%, total refunded after: $%)',
        v_refund_id, p_payment_id, p_amount, v_total_refunded + p_amount;

    RETURN v_refund_id;
END;
$$;


-- ============================================================================
-- 3. RESTORE ORIGINAL notify_refund_succeeded FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION payments.notify_refund_succeeded()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction RECORD;
    v_refunds JSONB;
    v_total_refunded NUMERIC;
BEGIN
    IF NEW.status = 'succeeded' AND (OLD.status IS NULL OR OLD.status != 'succeeded') THEN
        SELECT * INTO v_transaction
        FROM payments.transactions
        WHERE id = NEW.transaction_id;

        IF FOUND THEN
            SELECT
                jsonb_agg(
                    jsonb_build_object(
                        'amount', '$' || to_char(r.amount, 'FM999,999,990.00'),
                        'reason', COALESCE(r.reason, 'No reason provided'),
                        'status', r.status,
                        'created_at', r.created_at
                    ) ORDER BY r.created_at
                ),
                COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'succeeded'), 0)
            INTO v_refunds, v_total_refunded
            FROM payments.refunds r
            WHERE r.transaction_id = NEW.transaction_id;

            PERFORM public.create_notification(
                p_user_id := v_transaction.user_id,
                p_template_name := 'payment_refunded',
                p_entity_type := 'payments.refunds',
                p_entity_id := NEW.id::text,
                p_entity_data := jsonb_build_object(
                    'id', NEW.id,
                    'payment', jsonb_build_object(
                        'description', v_transaction.description,
                        'display_name', v_transaction.display_name
                    ),
                    'refunds', COALESCE(v_refunds, '[]'::jsonb),
                    'total_refunded', '$' || to_char(v_total_refunded, 'FM999,999,990.00'),
                    'remaining', '$' || to_char(v_transaction.amount - v_total_refunded, 'FM999,999,990.00')
                ),
                p_channels := ARRAY['email']
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- 4. RESTORE ORIGINAL payment_transactions VIEW
-- ============================================================================

DROP VIEW IF EXISTS public.payment_transactions;

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
    t.provider_payment_id,
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,
    CASE
        WHEN r_agg.total_refunded >= t.amount THEN 'refunded'
        WHEN r_agg.total_refunded > 0 THEN 'partially_refunded'
        WHEN r_agg.pending_count > 0 THEN 'refund_pending'
        ELSE COALESCE(t.status, 'unpaid')
    END AS effective_status,
    t.error_message,
    t.provider,
    t.provider_client_secret,
    t.description,
    t.display_name,
    t.created_at,
    t.updated_at,
    t.entity_type,
    t.entity_id,
    COALESCE(e.display_name, t.entity_type) AS entity_display_name
FROM payments.transactions t
LEFT JOIN public.civic_os_users u ON t.user_id = u.id
LEFT JOIN metadata.entities e ON t.entity_type = e.table_name
LEFT JOIN LATERAL (
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS total_refunded,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS refund_count,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM payments.refunds
    WHERE transaction_id = t.id
) r_agg ON true;

GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- ============================================================================
-- 5. REMOVE PROCESSING FEE COLUMNS FROM payments.transactions
-- ============================================================================

-- Drop the display_name column (will be recreated with original formula)
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS display_name;

-- Drop generated columns first
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


COMMIT;
