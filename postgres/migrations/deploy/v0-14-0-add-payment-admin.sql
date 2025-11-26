-- Deploy civic-os:v0-14-0-add-payment-admin to pg
-- requires: v0-13-0-add-payment-metadata
-- Payment Admin: Refund support, admin permissions, effective_status computed field
-- Version: 0.14.0

BEGIN;

-- ============================================================================
-- 1. PAYMENT PERMISSIONS SETUP
-- ============================================================================
-- Create granular permissions for payment management
-- These enable role flexibility beyond simple isAdmin() checks

-- Insert permissions for payment management
-- Uses existing permission enum: 'create', 'read', 'update', 'delete'
INSERT INTO metadata.permissions (table_name, permission)
VALUES
    ('payment_transactions', 'read'),   -- View ALL payments (not just own)
    ('payment_refunds', 'read'),        -- View refunds
    ('payment_refunds', 'create')       -- Initiate refunds
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant payment permissions to admin role by default
INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT r.id, p.id
FROM metadata.roles r
CROSS JOIN metadata.permissions p
WHERE r.display_name = 'admin'
  AND p.table_name IN ('payment_transactions', 'payment_refunds')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMENT ON TABLE metadata.permissions IS
    'Extended in v0.14.0 to include payment_transactions and payment_refunds permissions for granular payment access control.';


-- ============================================================================
-- 2. PERMISSION-BASED RLS POLICY FOR PAYMENTS
-- ============================================================================
-- Allow users with payment_transactions:select to see ALL payments
-- Uses OR semantics with existing "Users see own payments" policy

CREATE POLICY "Payment managers see all payments"
    ON payments.transactions
    FOR SELECT
    TO authenticated
    USING (public.has_permission('payment_transactions', 'read'));

COMMENT ON POLICY "Payment managers see all payments" ON payments.transactions IS
    'Users with payment_transactions:read permission can view all payment records for admin/support purposes.';


-- ============================================================================
-- 3. REFUNDS TABLE
-- ============================================================================
-- Track refund requests and their status

CREATE TABLE payments.refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES payments.transactions(id) ON DELETE RESTRICT,

    -- Refund details
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) >= 10),

    -- Who initiated the refund
    initiated_by UUID NOT NULL REFERENCES metadata.civic_os_users(id),

    -- Stripe data
    provider_refund_id TEXT,  -- Stripe Refund ID (re_...)

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'succeeded', 'failed')),
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_refunds_transaction_id ON payments.refunds(transaction_id);
CREATE INDEX idx_refunds_status ON payments.refunds(status);
CREATE INDEX idx_refunds_initiated_by ON payments.refunds(initiated_by);
CREATE INDEX idx_refunds_created_at ON payments.refunds(created_at DESC);

-- Comments
COMMENT ON TABLE payments.refunds IS
    'Refund requests for payment transactions. Created via initiate_payment_refund() RPC, processed by payment worker.';
COMMENT ON COLUMN payments.refunds.reason IS
    'Reason for refund (min 10 characters). Displayed to user and stored in Stripe.';
COMMENT ON COLUMN payments.refunds.provider_refund_id IS
    'Stripe Refund ID (re_...). Populated by worker after successful Stripe API call.';

-- RLS: Permission-based access
ALTER TABLE payments.refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Refund managers see refunds"
    ON payments.refunds
    FOR SELECT
    TO authenticated
    USING (public.has_permission('payment_refunds', 'read'));

CREATE POLICY "Refund managers create refunds"
    ON payments.refunds
    FOR INSERT
    TO authenticated
    WITH CHECK (public.has_permission('payment_refunds', 'create'));

COMMENT ON POLICY "Refund managers see refunds" ON payments.refunds IS
    'Users with payment_refunds:read permission can view refund records.';
COMMENT ON POLICY "Refund managers create refunds" ON payments.refunds IS
    'Users with payment_refunds:create permission can initiate refunds via RPC.';


-- ============================================================================
-- 4. ADD ENTITY REFERENCE TO TRANSACTIONS
-- ============================================================================
-- Note: refund_id column REMOVED in favor of 1:M relationship
-- Refunds are linked via refunds.transaction_id (not transactions.refund_id)
-- This allows multiple partial refunds per transaction

-- Add entity reference columns for reverse lookup (payment -> entity)
-- Enables: linking from payment admin to the source entity, tracking abandoned payments
ALTER TABLE payments.transactions
ADD COLUMN entity_type TEXT,
ADD COLUMN entity_id TEXT;

CREATE INDEX idx_transactions_entity ON payments.transactions(entity_type, entity_id)
    WHERE entity_type IS NOT NULL;

COMMENT ON COLUMN payments.transactions.entity_type IS
    'Table name of the entity this payment is for (e.g., ''reservation_requests''). Populated by create_and_link_payment helper.';
COMMENT ON COLUMN payments.transactions.entity_id IS
    'Primary key of the entity this payment is for (stored as text for flexibility with different PK types).';


-- ============================================================================
-- 4b. UPDATE create_and_link_payment TO STORE ENTITY REFERENCE
-- ============================================================================
-- Modify the helper function to populate entity_type and entity_id

CREATE OR REPLACE FUNCTION payments.create_and_link_payment(
    p_entity_table_name NAME,
    p_entity_id_column_name NAME,
    p_entity_id_value ANYELEMENT,
    p_payment_column_name NAME,
    p_amount NUMERIC(10,2),
    p_description TEXT,
    p_user_id UUID DEFAULT current_user_id(),
    p_currency TEXT DEFAULT 'USD'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = payments, metadata, public
AS $$
DECLARE
    v_payment_id UUID;
    v_sql TEXT;
BEGIN
    -- Validate inputs
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid payment amount: %. Amount must be greater than zero.', p_amount;
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID required for payment creation';
    END IF;

    -- Validate currency (POC only supports USD)
    IF p_currency != 'USD' THEN
        RAISE EXCEPTION 'Only USD currency supported in POC (got: %)', p_currency;
    END IF;

    -- Create payment record with entity reference
    -- Trigger will automatically enqueue River job for Stripe intent creation
    INSERT INTO payments.transactions (
        user_id,
        amount,
        currency,
        status,
        description,
        provider,
        entity_type,
        entity_id
    ) VALUES (
        p_user_id,
        p_amount,
        p_currency,
        'pending_intent',  -- Worker will update to 'pending' after creating Stripe intent
        p_description,
        'stripe',
        p_entity_table_name::TEXT,
        p_entity_id_value::TEXT
    ) RETURNING id INTO v_payment_id;

    -- Link payment to entity using dynamic SQL
    -- Use format() with %I (identifier) to prevent SQL injection
    v_sql := format(
        'UPDATE %I SET %I = $1 WHERE %I = $2',
        p_entity_table_name,
        p_payment_column_name,
        p_entity_id_column_name
    );

    EXECUTE v_sql USING v_payment_id, p_entity_id_value;

    -- Verify the entity was updated
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entity not found: %.% = %', p_entity_table_name, p_entity_id_column_name, p_entity_id_value;
    END IF;

    RETURN v_payment_id;
END;
$$;

COMMENT ON FUNCTION payments.create_and_link_payment IS
    'Create payment record and atomically link to entity. Stores entity_type and entity_id for reverse lookup. Prevents common errors: wrong status, missing entity link, incorrect currency. Uses format() with %I for safe dynamic SQL.';


-- ============================================================================
-- 5. UPDATE payment_transactions VIEW
-- ============================================================================
-- Add user info, refund data, and effective_status for admin UI
-- Uses LATERAL JOIN to aggregate refunds (supports 1:M multiple refunds)
-- Must DROP and recreate because we're adding columns in the middle

DROP VIEW IF EXISTS public.payment_transactions;

CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,  -- Access-controlled: visible to admins/self
    u.email AS user_email,  -- Access-controlled: visible to admins/self
    t.amount,
    t.currency,
    t.status,  -- Original status preserved for auditing
    t.provider_payment_id,  -- pi_* for Stripe cross-reference in admin UI

    -- Aggregated refund data (supports multiple refunds per transaction)
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,

    -- Effective status computed from aggregated refund data
    -- Distinguishes partial vs full refunds for clear admin UX
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
    -- Entity reference for reverse lookup
    t.entity_type,
    t.entity_id,
    COALESCE(e.display_name, t.entity_type) AS entity_display_name  -- Friendly name from metadata
FROM payments.transactions t
LEFT JOIN public.civic_os_users u ON t.user_id = u.id  -- Use public view for access control
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
    'Public API view for payment transactions. Updated in v0.14.0 to add user info, effective_status (based on aggregated refunds), and entity reference. Supports multiple partial refunds per transaction.';

-- Maintain existing grants
GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- ============================================================================
-- 6. REFUND RPC FUNCTION
-- ============================================================================
-- Initiate payment refund with permission check
-- Supports multiple partial refunds per transaction

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

    -- Check if total refunds would exceed payment amount
    IF v_total_refunded + p_amount > v_payment.amount THEN
        RAISE EXCEPTION 'Total refunds ($%) would exceed payment amount ($%). Already refunded: $%',
            v_total_refunded + p_amount, v_payment.amount, v_total_refunded
            USING HINT = format('Maximum additional refund allowed: $%s', v_payment.amount - v_total_refunded);
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

    RAISE NOTICE 'Created refund % for payment % (amount: $%, total refunded after: $%)',
        v_refund_id, p_payment_id, p_amount, v_total_refunded + p_amount;

    RETURN v_refund_id;
END;
$$;

COMMENT ON FUNCTION public.initiate_payment_refund IS
    'Initiate payment refund. Requires payment_refunds:create permission. Supports multiple partial refunds per transaction. Validates total refunds do not exceed payment amount. Blocks concurrent refunds while one is pending.';

GRANT EXECUTE ON FUNCTION public.initiate_payment_refund TO authenticated;


-- ============================================================================
-- 7. REFUNDS VIEW
-- ============================================================================
-- Public view for refund data (used by refund history modal)

CREATE OR REPLACE VIEW public.payment_refunds AS
SELECT
    r.id,
    r.transaction_id,
    r.amount,
    r.reason,
    r.initiated_by,
    u.display_name AS initiated_by_name,
    r.provider_refund_id,  -- re_* for Stripe cross-reference
    r.status,
    r.error_message,
    r.created_at,
    r.processed_at,
    -- Include payment context for modal display
    t.amount AS payment_amount,
    t.description AS payment_description,
    t.provider_payment_id  -- pi_* for Stripe cross-reference
FROM payments.refunds r
LEFT JOIN public.civic_os_users u ON r.initiated_by = u.id  -- Use public view
LEFT JOIN payments.transactions t ON r.transaction_id = t.id;

COMMENT ON VIEW public.payment_refunds IS
    'Public API view for payment refunds. Includes initiator name, payment context, and Stripe IDs for cross-reference.';

GRANT SELECT ON public.payment_refunds TO authenticated;


-- ============================================================================
-- 8. COMPUTED FIELD: effective_status ON payments.transactions TYPE
-- ============================================================================
-- PostgREST exposes this as a virtual column on any embedded payment
-- Works automatically for ANY entity with a payment FK - no per-entity wrappers
-- Uses aggregation to support multiple refunds per transaction

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

    -- Compute effective status
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

COMMENT ON FUNCTION payments.effective_status(payments.transactions) IS
    'PostgREST computed field for payment effective status. Automatically exposed when payments are embedded. Uses aggregation to support multiple refunds. Returns: refunded, partially_refunded, refund_pending, or original status.';


-- ============================================================================
-- 9. NOTIFICATION TEMPLATE FOR REFUNDS
-- ============================================================================
-- Email notification when refund is processed

-- Payment refund notification (updated for 1:M refund schema)
-- Entity data includes payment info and ALL refunds for the transaction
-- Money values are pre-formatted in the trigger function
INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template
) VALUES (
    'payment_refunded',
    'Notify user when their payment is refunded (shows full refund history)',
    'payments.refunds',
    'Refund Processed: {{.Entity.payment.description}}',
    '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a;">Refund Confirmation</h2>
        <p>A refund has been processed for your payment.</p>

        <h3 style="color: #374151; margin-top: 24px;">Original Payment</h3>
        <table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Description:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.Entity.payment.description}}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Amount Paid:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.Entity.payment.display_name}}</td>
            </tr>
        </table>

        <h3 style="color: #374151; margin-top: 24px;">Refund History</h3>
        <table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
            <tr style="background-color: #f3f4f6;">
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e5e7eb;">Amount</th>
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e5e7eb;">Reason</th>
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #e5e7eb;">Status</th>
            </tr>
            {{range .Entity.refunds}}<tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.amount}}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.reason}}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.status}}</td>
            </tr>{{end}}
        </table>

        <table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Total Refunded:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.Entity.total_refunded}}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Remaining:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.Entity.remaining}}</td>
            </tr>
        </table>

        <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">Refunds typically appear on your statement within 5-10 business days.</p>
    </div>',
    'Refund Confirmation

A refund has been processed for your payment.

ORIGINAL PAYMENT
Description: {{.Entity.payment.description}}
Amount Paid: {{.Entity.payment.display_name}}

REFUND HISTORY
{{range .Entity.refunds}}- {{.amount}} ({{.status}}): {{.reason}}
{{end}}
Total Refunded: {{.Entity.total_refunded}}
Remaining: {{.Entity.remaining}}

Refunds typically appear on your statement within 5-10 business days.'
) ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    entity_type = EXCLUDED.entity_type,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template;

-- Payment succeeded notification
INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template
) VALUES (
    'payment_succeeded',
    'Notify user when their payment succeeds',
    'payments.transactions',
    'Payment Confirmed: {{.Entity.description}}',
    '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a;">Payment Confirmed</h2>
        <p>Thank you! Your payment has been successfully processed.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Description:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.Entity.description}}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><strong>Amount Paid:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">{{.Entity.display_name}}</td>
            </tr>
        </table>
        <p style="color: #6b7280; font-size: 14px;">This email serves as your receipt. Please keep it for your records.</p>
    </div>',
    'Payment Confirmed

Thank you! Your payment has been successfully processed.

Description: {{.Entity.description}}
Amount Paid: {{.Entity.display_name}}

This email serves as your receipt. Please keep it for your records.'
) ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template;

-- ============================================================================
-- 10. NOTIFICATION TRIGGERS
-- ============================================================================

-- Function to send payment succeeded notification
CREATE OR REPLACE FUNCTION payments.notify_payment_succeeded()
RETURNS TRIGGER AS $$
BEGIN
    -- Only trigger on status change to 'succeeded'
    IF NEW.status = 'succeeded' AND (OLD.status IS NULL OR OLD.status != 'succeeded') THEN
        -- Create notification for the user who made the payment
        PERFORM public.create_notification(
            p_user_id := NEW.user_id,
            p_template_name := 'payment_succeeded',
            p_entity_type := 'payments.transactions',
            p_entity_id := NEW.id::text,
            p_entity_data := jsonb_build_object(
                'id', NEW.id,
                'amount', NEW.amount,
                'currency', NEW.currency,
                'description', NEW.description,
                'display_name', NEW.display_name
            ),
            p_channels := ARRAY['email']
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to send refund notification (includes full refund history)
-- Formats all money values as "$X.XX" for display
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
            -- Format amounts as currency strings
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
            -- All money values pre-formatted for display
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

-- Create triggers
DROP TRIGGER IF EXISTS payment_succeeded_notification ON payments.transactions;
CREATE TRIGGER payment_succeeded_notification
    AFTER UPDATE ON payments.transactions
    FOR EACH ROW
    EXECUTE FUNCTION payments.notify_payment_succeeded();

DROP TRIGGER IF EXISTS refund_succeeded_notification ON payments.refunds;
CREATE TRIGGER refund_succeeded_notification
    AFTER UPDATE ON payments.refunds
    FOR EACH ROW
    EXECUTE FUNCTION payments.notify_refund_succeeded();


-- ============================================================================
-- 10. GRANTS
-- ============================================================================

-- Grant access to refunds view
GRANT SELECT ON public.payment_refunds TO authenticated;

-- Ensure payments schema access for computed field function
GRANT USAGE ON SCHEMA payments TO authenticated;

COMMIT;
