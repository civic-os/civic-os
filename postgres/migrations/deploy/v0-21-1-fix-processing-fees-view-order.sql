-- Deploy civic-os:v0-21-1-fix-processing-fees-view-order to pg
-- requires: v0-21-0-add-processing-fees
-- Fix: Drop dependent view before modifying payments.transactions columns
-- This migration fixes v0.21.0 which failed due to view dependency order
-- Version: 0.21.1

BEGIN;

-- ============================================================================
-- 0. DROP DEPENDENT VIEW FIRST
-- ============================================================================
-- The payment_transactions view depends on payments.transactions.display_name
-- We must drop it BEFORE modifying the table columns, then recreate it after.
-- This fixes the error: "cannot drop column display_name because other objects depend on it"

DROP VIEW IF EXISTS public.payment_transactions;

-- ============================================================================
-- 1. ADD PROCESSING FEE COLUMNS TO payments.transactions
-- ============================================================================
-- Add columns for fee tracking, auditing, and refund control
-- NOTE: We must drop and recreate generated columns (display_name) to update them

-- First, drop the existing display_name generated column
-- (we'll recreate it to use total_amount instead of amount)
ALTER TABLE payments.transactions DROP COLUMN IF EXISTS display_name;

-- Add processing fee columns (skip if already exist from partial v0.21.0 run)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'payments' AND table_name = 'transactions' AND column_name = 'processing_fee'
    ) THEN
        ALTER TABLE payments.transactions
        ADD COLUMN processing_fee NUMERIC(10, 2) NOT NULL DEFAULT 0
            CHECK (processing_fee >= 0),
        ADD COLUMN fee_percent NUMERIC(5, 3),
        ADD COLUMN fee_flat_cents INTEGER,
        ADD COLUMN fee_refundable BOOLEAN NOT NULL DEFAULT false;

        -- Add generated columns for total_amount and max_refundable
        ALTER TABLE payments.transactions
        ADD COLUMN total_amount NUMERIC(10, 2) GENERATED ALWAYS AS (amount + processing_fee) STORED,
        ADD COLUMN max_refundable NUMERIC(10, 2) GENERATED ALWAYS AS (
            CASE WHEN fee_refundable THEN amount + processing_fee ELSE amount END
        ) STORED;
    END IF;
END $$;

-- Recreate display_name to show total_amount instead of base amount (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'payments' AND table_name = 'transactions' AND column_name = 'display_name'
    ) THEN
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
    END IF;
END $$;

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
-- 2. RECREATE payment_transactions VIEW
-- ============================================================================
-- Add fee columns to the public API view

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
    t.effective_status,
    t.description,
    t.display_name,
    -- Provider details (redact sensitive data)
    t.provider,
    t.provider_payment_id,
    t.provider_client_secret,
    -- Timestamps
    t.created_at,
    t.updated_at,
    -- Error info
    t.error_message,
    -- Refund aggregates
    t.total_refunded,
    t.refund_count,
    t.pending_refund_count
FROM payments.transactions t
LEFT JOIN metadata.civic_os_users u ON t.user_id = u.id;

-- Restore grants
GRANT SELECT ON public.payment_transactions TO authenticated;
GRANT SELECT ON public.payment_transactions TO web_anon;

COMMENT ON VIEW public.payment_transactions IS
    'Public view of payment transactions with user details joined. Includes processing fee breakdown.';


-- ============================================================================
-- 3. UPDATE initiate_payment_refund RPC
-- ============================================================================
-- Modify refund validation to use max_refundable instead of amount

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

    -- Check against max_refundable (respects fee_refundable setting)
    -- max_refundable = amount (if fee not refundable) or total_amount (if fee refundable)
    IF v_total_refunded + p_amount > v_payment.max_refundable THEN
        IF v_payment.fee_refundable THEN
            RAISE EXCEPTION 'Refund amount ($%) exceeds remaining refundable balance ($%)',
                p_amount, (v_payment.max_refundable - v_total_refunded);
        ELSE
            RAISE EXCEPTION 'Refund amount ($%) exceeds remaining refundable balance ($%). Note: Processing fee ($%) is non-refundable.',
                p_amount, (v_payment.max_refundable - v_total_refunded), v_payment.processing_fee;
        END IF;
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
    'Initiate a refund for a succeeded payment. Admin only. Validates against max_refundable which respects fee_refundable setting.';

COMMIT;
