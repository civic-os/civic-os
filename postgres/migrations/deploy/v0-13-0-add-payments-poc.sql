-- Deploy civic_os:v0-13-0-add-payments-poc to pg
-- requires: v0-12-3-add-calendar-widget-type
-- Payment Processing POC: Minimal vertical slice to prove architecture
-- Version: 0.13.0

BEGIN;

-- ===========================================================================
-- Payments Schema
-- ===========================================================================
-- Separate schema for payment-related tables to enable:
-- 1. Clean namespace separation from metadata
-- 2. Schema-level security policies
-- 3. Optional deployment (instances not using payments can skip)

CREATE SCHEMA IF NOT EXISTS payments;

COMMENT ON SCHEMA payments IS
    'Payment processing tables for Stripe integration. Separate schema for optional deployment and security isolation.';


-- ===========================================================================
-- Payment Transactions Table
-- ===========================================================================
-- Core table for tracking payment intents and their lifecycle
-- Minimal POC version - no entity references, webhooks, or refunds yet

CREATE TABLE payments.transactions (
    -- Identity
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id) ON DELETE RESTRICT,

    -- Amount and Currency
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'USD',

    -- Status Tracking
    status TEXT NOT NULL DEFAULT 'pending_intent',
    error_message TEXT,  -- Error details if creation fails

    -- Stripe Integration
    provider TEXT NOT NULL DEFAULT 'stripe',
    provider_payment_id TEXT,  -- Stripe PaymentIntent ID (pi_...)
    provider_client_secret TEXT,  -- client_secret for Stripe Elements

    -- Metadata
    description TEXT,
    display_name TEXT GENERATED ALWAYS AS (
        '$' || amount::TEXT || ' - ' ||
        CASE status
            WHEN 'pending_intent' THEN 'Creating...'
            WHEN 'pending' THEN 'Pending'
            WHEN 'succeeded' THEN 'Paid'
            WHEN 'failed' THEN 'Failed'
            WHEN 'canceled' THEN 'Canceled'
            ELSE UPPER(status)
        END
    ) STORED,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_status CHECK (status IN (
        'pending_intent',  -- Initial state, waiting for worker to create Stripe intent
        'pending',         -- Stripe intent created, waiting for customer confirmation
        'succeeded',       -- Payment succeeded
        'failed',          -- Payment failed
        'canceled'         -- Payment canceled
    )),
    CONSTRAINT valid_currency CHECK (currency = 'USD'),  -- POC: USD only
    CONSTRAINT valid_provider CHECK (provider = 'stripe')  -- POC: Stripe only
);

-- Indexes for common queries
CREATE INDEX idx_payments_transactions_user_id ON payments.transactions(user_id);
CREATE INDEX idx_payments_transactions_status ON payments.transactions(status);
CREATE INDEX idx_payments_transactions_created_at ON payments.transactions(created_at DESC);
CREATE INDEX idx_payments_transactions_provider_payment_id ON payments.transactions(provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

-- Comments
COMMENT ON TABLE payments.transactions IS
    'Payment transaction records. POC version with minimal fields to prove sync RPC + River + Stripe integration.';
COMMENT ON COLUMN payments.transactions.status IS
    'Payment lifecycle: pending_intent → pending → succeeded/failed/canceled';
COMMENT ON COLUMN payments.transactions.provider_payment_id IS
    'Stripe PaymentIntent ID (pi_...). Created by worker after INSERT.';
COMMENT ON COLUMN payments.transactions.provider_client_secret IS
    'Stripe client_secret for Elements SDK. Created by worker, returned to frontend via RPC.';


-- ===========================================================================
-- Trigger Function: Enqueue Create Intent Job
-- ===========================================================================
-- Automatically enqueues River job when payment is created with status='pending_intent'

CREATE OR REPLACE FUNCTION payments.enqueue_create_intent_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = payments, metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only enqueue job for new payments in pending_intent status
    IF NEW.status = 'pending_intent' THEN
        INSERT INTO metadata.river_job (
            kind,
            args,
            priority,
            queue,
            max_attempts,
            scheduled_at,
            state
        ) VALUES (
            'create_payment_intent',
            jsonb_build_object('payment_id', NEW.id),
            1,  -- Normal priority
            'default',
            5,  -- Retry up to 5 times
            NOW(),
            'available'
        );

        RAISE NOTICE 'Enqueued create_payment_intent job for payment %', NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION payments.enqueue_create_intent_job() IS
    'Trigger function that enqueues River job to create Stripe PaymentIntent when payment is inserted.';


-- ===========================================================================
-- Trigger: Enqueue Create Intent Job on INSERT
-- ===========================================================================

CREATE TRIGGER enqueue_create_intent_job_trigger
    AFTER INSERT ON payments.transactions
    FOR EACH ROW
    WHEN (NEW.status = 'pending_intent')
    EXECUTE FUNCTION payments.enqueue_create_intent_job();


-- ===========================================================================
-- Helper Function: Check Existing Payment for Idempotency
-- ===========================================================================
-- Standardized idempotency logic for payment initiation RPCs
-- Eliminates ~28 lines of boilerplate per domain RPC
--
-- Returns:
--   'create_new' - No payment exists or previous failed/canceled (proceed with new payment)
--   'reuse'      - Payment in progress (return existing payment_id to user)
--   'duplicate'  - Payment succeeded (raise exception - don't charge twice)
--
-- Usage in domain RPC:
--   v_status := payments.check_existing_payment(v_entity.payment_transaction_id);
--   IF v_status = 'reuse' THEN RETURN v_entity.payment_transaction_id; END IF;
--   IF v_status = 'duplicate' THEN RAISE EXCEPTION 'Payment already succeeded'; END IF;
--   -- v_status = 'create_new', fall through to create new payment

CREATE OR REPLACE FUNCTION payments.check_existing_payment(
    p_payment_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_payment_status TEXT;
BEGIN
    -- No existing payment - create new
    IF p_payment_id IS NULL THEN
        RETURN 'create_new';
    END IF;

    -- Get status of existing payment
    SELECT status INTO v_payment_status
    FROM payments.transactions
    WHERE id = p_payment_id;

    -- Payment not found (shouldn't happen if FK constraint exists, but be defensive)
    IF NOT FOUND THEN
        RETURN 'create_new';
    END IF;

    -- Payment in progress - reuse existing PaymentIntent
    IF v_payment_status IN ('pending_intent', 'pending') THEN
        RETURN 'reuse';
    END IF;

    -- Payment failed or canceled - allow retry with NEW transaction
    -- Important: Don't modify old transaction, it stays as audit trail
    IF v_payment_status IN ('failed', 'canceled') THEN
        RETURN 'create_new';
    END IF;

    -- Payment succeeded - prevent duplicate charge
    IF v_payment_status = 'succeeded' THEN
        RETURN 'duplicate';
    END IF;

    -- Unknown status - fail safe
    RAISE EXCEPTION 'Unexpected payment status: %', v_payment_status;
END;
$$;

COMMENT ON FUNCTION payments.check_existing_payment IS
    'Check existing payment for idempotency. Returns: create_new, reuse, or duplicate. Prevents duplicate charges and ensures proper retry handling for failed payments.';

GRANT EXECUTE ON FUNCTION payments.check_existing_payment TO authenticated;


-- ===========================================================================
-- Helper Function: Create and Link Payment to Entity
-- ===========================================================================
-- Atomic payment creation + entity linking to prevent common integrator errors
-- Handles both INSERT and UPDATE in single transaction
--
-- Parameters:
--   p_entity_table_name      - Table containing entity (e.g., 'reservation_requests')
--   p_entity_id_column_name  - PK column name (e.g., 'id')
--   p_entity_id_value        - PK value (supports BIGINT, UUID, TEXT)
--   p_payment_column_name    - FK column to payments.transactions (e.g., 'payment_transaction_id')
--   p_amount                 - Payment amount in USD (must be > 0)
--   p_description            - Payment description for Stripe dashboard
--   p_user_id                - User making payment (defaults to current_user_id())
--   p_currency               - Currency code (defaults to 'USD', POC only supports USD)
--
-- Returns: payment_id (UUID)
--
-- Example:
--   RETURN payments.create_and_link_payment(
--       'reservation_requests', 'id', p_entity_id,
--       'payment_transaction_id', v_cost,
--       'Reservation for Main Hall'
--   );

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

    -- Create payment record
    -- Trigger will automatically enqueue River job for Stripe intent creation
    INSERT INTO payments.transactions (
        user_id,
        amount,
        currency,
        status,
        description,
        provider
    ) VALUES (
        p_user_id,
        p_amount,
        p_currency,
        'pending_intent',  -- Worker will update to 'pending' after creating Stripe intent
        p_description,
        'stripe'
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

    -- Verify update succeeded
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Failed to link payment to entity: % WHERE % = %',
            p_entity_table_name, p_entity_id_column_name, p_entity_id_value;
    END IF;

    RETURN v_payment_id;
END;
$$;

COMMENT ON FUNCTION payments.create_and_link_payment IS
    'Create payment record and atomically link to entity. Prevents common errors: wrong status, missing entity link, incorrect currency. Uses format() with %I for safe dynamic SQL.';

GRANT EXECUTE ON FUNCTION payments.create_and_link_payment TO authenticated;


-- ===========================================================================
-- RPC Function: Create Payment Intent (Synchronous)
-- ===========================================================================
-- Synchronous RPC that creates payment and polls until worker completes Stripe intent creation
-- Returns client_secret for frontend Stripe Elements integration
--
-- Flow:
-- 1. INSERT payment row with status='pending_intent'
-- 2. Trigger enqueues River job
-- 3. Poll with pg_sleep() until status changes from 'pending_intent'
-- 4. Return payment details with client_secret
--
-- Timeout: 30 seconds (should complete in ~3 seconds under normal load)

CREATE OR REPLACE FUNCTION create_payment_intent_sync(
    p_amount NUMERIC,
    p_description TEXT DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = payments, metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_payment_id UUID;
    v_payment_record RECORD;
    v_timeout_seconds INTEGER := 30;
    v_poll_interval_seconds NUMERIC := 0.5;
    v_elapsed_seconds NUMERIC := 0;
    v_user_id UUID;
BEGIN
    -- Get current user ID
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'User must be authenticated to create payment';
    END IF;

    -- Validate amount
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid payment amount: %', p_amount
            USING HINT = 'Amount must be greater than zero';
    END IF;

    -- Create payment record (trigger will enqueue River job)
    INSERT INTO payments.transactions (
        user_id,
        amount,
        description,
        status
    ) VALUES (
        v_user_id,
        p_amount,
        p_description,
        'pending_intent'
    )
    RETURNING id INTO v_payment_id;

    RAISE NOTICE 'Created payment % with amount %, polling for Stripe intent creation...',
        v_payment_id, p_amount;

    -- Poll until worker completes (status changes from 'pending_intent')
    WHILE v_elapsed_seconds < v_timeout_seconds LOOP
        -- Check current status
        SELECT * INTO v_payment_record
        FROM payments.transactions
        WHERE id = v_payment_id;

        -- If status changed from pending_intent, worker completed
        IF v_payment_record.status != 'pending_intent' THEN
            -- Check if creation succeeded
            IF v_payment_record.status = 'pending' AND v_payment_record.provider_client_secret IS NOT NULL THEN
                -- Success - return payment details
                RETURN jsonb_build_object(
                    'payment_id', v_payment_record.id,
                    'client_secret', v_payment_record.provider_client_secret,
                    'amount', v_payment_record.amount,
                    'currency', v_payment_record.currency,
                    'status', v_payment_record.status,
                    'description', v_payment_record.description
                );
            ELSE
                -- Worker failed to create intent
                RAISE EXCEPTION 'Payment intent creation failed: %',
                    COALESCE(v_payment_record.error_message, 'Unknown error')
                    USING HINT = 'Check payment worker logs for details';
            END IF;
        END IF;

        -- Sleep and increment elapsed time
        PERFORM pg_sleep(v_poll_interval_seconds);
        v_elapsed_seconds := v_elapsed_seconds + v_poll_interval_seconds;
    END LOOP;

    -- Timeout reached
    RAISE EXCEPTION 'Payment intent creation timeout after % seconds', v_timeout_seconds
        USING HINT = 'Check if payment worker is running and Stripe API is accessible';
END;
$$;

COMMENT ON FUNCTION create_payment_intent_sync(NUMERIC, TEXT) IS
    'Create payment and wait synchronously for Stripe PaymentIntent creation. Returns client_secret for Stripe Elements. POC version - proves sync RPC architecture.';


-- ===========================================================================
-- Row Level Security Policies
-- ===========================================================================

ALTER TABLE payments.transactions ENABLE ROW LEVEL SECURITY;

-- Users see their own payments
CREATE POLICY "Users see own payments"
    ON payments.transactions
    FOR SELECT
    TO authenticated
    USING (user_id = current_user_id());

-- Users can create their own payments (via RPC only in practice)
CREATE POLICY "Users create own payments"
    ON payments.transactions
    FOR INSERT
    TO authenticated
    WITH CHECK (user_id = current_user_id());

-- Only payment worker can update payments (SECURITY DEFINER functions bypass RLS)
-- No direct UPDATE policy for users


-- ===========================================================================
-- Public View: payment_transactions
-- ===========================================================================
-- Exposes payment transactions via public schema (following metadata pattern)
-- This provides API stability and allows schema changes without breaking clients
--
-- Security Note: provider_client_secret is included because:
-- 1. RLS policies ensure users only see their own payments
-- 2. Required by Stripe Elements SDK to complete payment
-- 3. Short-lived (expires in 24 hours) and cannot be used for refunds

CREATE OR REPLACE VIEW public.payment_transactions AS
SELECT
    id,
    user_id,
    amount,
    currency,
    status,
    error_message,
    provider,
    provider_payment_id,
    provider_client_secret,  -- Required by Stripe Elements SDK
    description,
    display_name,
    created_at,
    updated_at
FROM payments.transactions;

COMMENT ON VIEW public.payment_transactions IS
    'Public API view for payment transactions. Wraps payments.transactions to provide stable interface. Includes provider_client_secret for Stripe Elements integration (protected by RLS).';


-- ===========================================================================
-- Webhooks Table (if not exists from previous migrations)
-- ===========================================================================
-- Store webhook events from payment providers with idempotency

CREATE TABLE IF NOT EXISTS metadata.webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,  -- 'stripe', 'paypal', etc.
    provider_event_id TEXT NOT NULL,  -- Stripe event ID (evt_...)
    event_type TEXT NOT NULL,  -- e.g., 'payment_intent.succeeded'
    payload JSONB NOT NULL,  -- Full webhook payload
    signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,  -- Error if processing failed
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    -- Idempotency: prevent duplicate webhook processing
    CONSTRAINT unique_webhook_event UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhooks_provider_event ON metadata.webhooks(provider, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_processed ON metadata.webhooks(processed, received_at);
CREATE INDEX IF NOT EXISTS idx_webhooks_event_type ON metadata.webhooks(event_type);

COMMENT ON TABLE metadata.webhooks IS
    'Webhook events from payment providers. Deduplicated by (provider, provider_event_id). Processed by HTTP webhook server (payment-worker) not PostgREST RPC.';


-- ===========================================================================
-- NOTE: Webhook Processing
-- ===========================================================================
-- Webhooks are processed via HTTP endpoint (payment-worker:8080/webhooks/stripe)
-- NOT via PostgREST RPC. The HTTP server handles signature verification and
-- updates metadata.webhooks + payments.transactions directly.
--
-- We do NOT use:
-- - PostgREST /rpc/process_payment_webhook endpoint (can't handle Stripe signatures)
-- - Database triggers to enqueue River jobs for webhooks
-- - River workers for webhook processing
--
-- This architecture ensures proper Stripe signature validation and atomic
-- transaction handling.


-- ===========================================================================
-- Grants
-- ===========================================================================

-- Grant USAGE on payments schema for internal functions only
-- Note: We do NOT grant direct access to payments.transactions
GRANT USAGE ON SCHEMA payments TO authenticated;

-- Grant access to public view (following metadata pattern)
GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;

-- Grant EXECUTE on RPC functions
GRANT EXECUTE ON FUNCTION create_payment_intent_sync(NUMERIC, TEXT) TO authenticated;

-- Anonymous users cannot access payments at all
-- Note: anon role might be named web_anon in some setups
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA payments FROM anon;
        REVOKE ALL ON public.payment_transactions FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
        REVOKE ALL ON SCHEMA payments FROM web_anon;
        REVOKE ALL ON public.payment_transactions FROM web_anon;
    END IF;
END $$;

COMMIT;
