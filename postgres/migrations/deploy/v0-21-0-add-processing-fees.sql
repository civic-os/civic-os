-- Deploy civic-os:v0-21-0-add-processing-fees to pg
-- requires: v0-20-4-fix-upsert-null-handling
-- Processing Fees: Configurable processing fee support with refund controls
-- Version: 0.21.0

BEGIN;

-- ============================================================================
-- 1. ADD PROCESSING FEE COLUMNS TO payments.transactions
-- ============================================================================
-- Add columns for fee tracking, auditing, and refund control
-- NOTE: We must drop and recreate generated columns (display_name) to update them

-- First, drop the existing display_name generated column
-- (we'll recreate it to use total_amount instead of amount)
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS display_name;

-- Add processing fee columns
ALTER TABLE payments.transactions
ADD COLUMN processing_fee NUMERIC(10, 2) NOT NULL DEFAULT 0
    CHECK (processing_fee >= 0),
ADD COLUMN fee_percent NUMERIC(5, 3),
ADD COLUMN fee_flat_cents INTEGER,
ADD COLUMN fee_refundable BOOLEAN NOT NULL DEFAULT false;

-- Add generated columns for total_amount and max_refundable
-- These are computed from base amount + fee
ALTER TABLE payments.transactions
ADD COLUMN total_amount NUMERIC(10, 2) GENERATED ALWAYS AS (amount + processing_fee) STORED,
ADD COLUMN max_refundable NUMERIC(10, 2) GENERATED ALWAYS AS (
    CASE WHEN fee_refundable THEN amount + processing_fee ELSE amount END
) STORED;

-- Recreate display_name to show total_amount instead of base amount
ALTER TABLE payments.transactions
ADD COLUMN display_name TEXT GENERATED ALWAYS AS (
    '$' || (amount + processing_fee)::TEXT || ' - ' ||
    CASE status
        WHEN 'pending_intent' THEN 'Creating...'
        WHEN 'pending' THEN 'Pending'
        WHEN 'succeeded' THEN 'Paid'
        WHEN 'failed' THEN 'Failed'
        WHEN 'canceled' THEN 'Canceled'
        ELSE UPPER(status)
    END
) STORED;

-- Comments for new columns
COMMENT ON COLUMN payments.transactions.processing_fee IS
    'Processing fee calculated by payment worker. Stored for audit trail.';
COMMENT ON COLUMN payments.transactions.fee_percent IS
    'Fee percentage applied at time of payment (e.g., 2.9 for 2.9%). Null if fees disabled.';
COMMENT ON COLUMN payments.transactions.fee_flat_cents IS
    'Flat fee in cents applied at time of payment (e.g., 30 for $0.30). Null if fees disabled.';
COMMENT ON COLUMN payments.transactions.fee_refundable IS
    'Whether the processing fee was refundable at time of payment. Used by refund validation.';
COMMENT ON COLUMN payments.transactions.total_amount IS
    'Total amount charged to customer (base + processing_fee). Computed column.';
COMMENT ON COLUMN payments.transactions.max_refundable IS
    'Maximum refundable amount. Equals total_amount if fee_refundable=true, else equals base amount.';


-- ============================================================================
-- 2. UPDATE payment_transactions VIEW
-- ============================================================================
-- Add fee columns to the public API view
-- Must DROP and recreate because we're changing columns

DROP VIEW IF EXISTS public.payment_transactions;

CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,
    u.email AS user_email,
    -- Base amount (original pricing)
    t.amount,
    -- Processing fee breakdown
    t.processing_fee,
    t.total_amount,
    t.max_refundable,
    t.fee_percent,
    t.fee_flat_cents,
    t.fee_refundable,
    -- Currency and status
    t.currency,
    t.status,
    t.provider_payment_id,

    -- Aggregated refund data (supports multiple refunds per transaction)
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,

    -- Effective status computed from aggregated refund data
    -- Now uses max_refundable instead of amount for refund threshold
    CASE
        WHEN r_agg.total_refunded >= t.max_refundable THEN 'refunded'
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
    -- Entity reference for reverse lookup
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

COMMENT ON VIEW public.payment_transactions IS
    'Public API view for payment transactions. Updated in v0.21.0 to add processing fee columns (processing_fee, total_amount, max_refundable, fee_percent, fee_flat_cents, fee_refundable).';

-- Maintain existing grants
GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- ============================================================================
-- 3. UPDATE REFUND VALIDATION
-- ============================================================================
-- Update initiate_payment_refund() to use max_refundable instead of amount
-- This respects the fee_refundable setting at time of payment

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
    v_remaining NUMERIC(10, 2);
BEGIN
    -- Get current user
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Permission check (not isAdmin - allows flexible role configuration)
    IF NOT public.has_permission('payment_refunds', 'create') THEN
        RAISE EXCEPTION 'Missing payment_refunds:create permission'
            USING HINT = 'Contact administrator to grant payment refund permissions';
    END IF;

    -- Validate reason length (enforced by CHECK constraint, but provide better error)
    IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 10 THEN
        RAISE EXCEPTION 'Refund reason must be at least 10 characters'
            USING HINT = 'Provide a detailed reason for the refund';
    END IF;

    -- Lock and fetch payment
    SELECT * INTO v_payment
    FROM payments.transactions
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment not found: %', p_payment_id;
    END IF;

    -- Validate payment can be refunded
    IF v_payment.status != 'succeeded' THEN
        RAISE EXCEPTION 'Can only refund succeeded payments (current status: %)', v_payment.status
            USING HINT = 'Payment must have succeeded before it can be refunded';
    END IF;

    -- Check for pending refunds (block concurrent refunds to prevent race conditions)
    SELECT COUNT(*) INTO v_pending_count
    FROM payments.refunds
    WHERE transaction_id = p_payment_id AND status = 'pending';

    IF v_pending_count > 0 THEN
        RAISE EXCEPTION 'Payment has % pending refund(s). Wait for them to complete before issuing another.', v_pending_count
            USING HINT = 'Pending refunds must complete or fail before new refunds can be initiated';
    END IF;

    -- Calculate total already refunded (supports multiple partial refunds)
    SELECT COALESCE(SUM(amount), 0) INTO v_total_refunded
    FROM payments.refunds
    WHERE transaction_id = p_payment_id AND status = 'succeeded';

    -- Validate refund amount
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid refund amount: %', p_amount
            USING HINT = 'Refund amount must be greater than zero';
    END IF;

    -- Calculate remaining refundable amount
    -- Uses max_refundable which respects fee_refundable setting
    v_remaining := v_payment.max_refundable - v_total_refunded;

    -- Check if total refunds would exceed max refundable amount
    IF v_total_refunded + p_amount > v_payment.max_refundable THEN
        IF v_payment.fee_refundable THEN
            RAISE EXCEPTION 'Total refunds ($%) would exceed payment amount ($%). Already refunded: $%',
                v_total_refunded + p_amount, v_payment.max_refundable, v_total_refunded
                USING HINT = format('Maximum additional refund allowed: $%s', v_remaining);
        ELSE
            RAISE EXCEPTION 'Total refunds ($%) would exceed base amount ($%). Processing fee ($%) is non-refundable. Already refunded: $%',
                v_total_refunded + p_amount, v_payment.max_refundable, v_payment.processing_fee, v_total_refunded
                USING HINT = format('Maximum additional refund allowed: $%s (processing fee retained)', v_remaining);
        END IF;
    END IF;

    -- Create refund record
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

    -- Enqueue River job for Stripe refund processing
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
        1,  -- Normal priority
        'default',
        3,  -- Retry up to 3 times
        NOW(),
        'available'
    );

    RAISE NOTICE 'Created refund % for payment % (amount: $%, total refunded after: $%, max refundable: $%)',
        v_refund_id, p_payment_id, p_amount, v_total_refunded + p_amount, v_payment.max_refundable;

    RETURN v_refund_id;
END;
$$;

COMMENT ON FUNCTION public.initiate_payment_refund IS
    'Initiate payment refund. Updated in v0.21.0 to use max_refundable which respects fee_refundable setting. Non-refundable fees (default) mean max refund = base amount only.';


-- ============================================================================
-- 4. UPDATE effective_status COMPUTED FIELD
-- ============================================================================
-- Update to use max_refundable for determining full refund status

CREATE OR REPLACE FUNCTION payments.effective_status(payments.transactions)
RETURNS text AS $$
DECLARE
    v_total_refunded NUMERIC;
    v_pending_count INTEGER;
BEGIN
    -- Get aggregated refund data
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0),
        COUNT(*) FILTER (WHERE status = 'pending')
    INTO v_total_refunded, v_pending_count
    FROM payments.refunds
    WHERE transaction_id = $1.id;

    -- Compute effective status using max_refundable instead of amount
    IF v_total_refunded >= $1.max_refundable THEN
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

COMMENT ON FUNCTION payments.effective_status(payments.transactions) IS
    'PostgREST computed field for payment effective status. Updated in v0.21.0 to use max_refundable for determining full refund threshold.';


-- ============================================================================
-- 5. UPDATE REFUND NOTIFICATION TO SHOW FEE INFO
-- ============================================================================
-- Update notification trigger to include fee breakdown in entity data

CREATE OR REPLACE FUNCTION payments.notify_refund_succeeded()
RETURNS TRIGGER AS $$
DECLARE
    v_transaction RECORD;
    v_refunds JSONB;
    v_total_refunded NUMERIC;
BEGIN
    -- Only trigger on status change to 'succeeded'
    IF NEW.status = 'succeeded' AND (OLD.status IS NULL OR OLD.status != 'succeeded') THEN
        -- Get parent transaction details
        SELECT * INTO v_transaction
        FROM payments.transactions
        WHERE id = NEW.transaction_id;

        IF FOUND THEN
            -- Get ALL refunds for this transaction (ordered by created_at)
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

            -- Create notification with full refund history
            -- Now includes fee breakdown info
            PERFORM public.create_notification(
                p_user_id := v_transaction.user_id,
                p_template_name := 'payment_refunded',
                p_entity_type := 'payments.refunds',
                p_entity_id := NEW.id::text,
                p_entity_data := jsonb_build_object(
                    'id', NEW.id,
                    'payment', jsonb_build_object(
                        'description', v_transaction.description,
                        'display_name', v_transaction.display_name,
                        'base_amount', '$' || to_char(v_transaction.amount, 'FM999,999,990.00'),
                        'processing_fee', '$' || to_char(v_transaction.processing_fee, 'FM999,999,990.00'),
                        'total_charged', '$' || to_char(v_transaction.total_amount, 'FM999,999,990.00'),
                        'fee_refundable', v_transaction.fee_refundable
                    ),
                    'refunds', COALESCE(v_refunds, '[]'::jsonb),
                    'total_refunded', '$' || to_char(v_total_refunded, 'FM999,999,990.00'),
                    'remaining', '$' || to_char(v_transaction.max_refundable - v_total_refunded, 'FM999,999,990.00'),
                    'non_refundable_fee', CASE
                        WHEN NOT v_transaction.fee_refundable AND v_transaction.processing_fee > 0
                        THEN '$' || to_char(v_transaction.processing_fee, 'FM999,999,990.00')
                        ELSE NULL
                    END
                ),
                p_channels := ARRAY['email']
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION payments.notify_refund_succeeded IS
    'Updated in v0.21.0 to include fee breakdown in refund notifications. Shows non-refundable fee amount when applicable.';


COMMIT;
