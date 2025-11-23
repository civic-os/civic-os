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
    'Webhook events from payment providers. Deduplicated by (provider, provider_event_id).';


-- ===========================================================================
-- RPC Function: Process Payment Webhook
-- ===========================================================================
-- Receives webhook events from Stripe via PostgREST endpoint
-- Inserts into metadata.webhooks with idempotency, then trigger enqueues processing job

CREATE OR REPLACE FUNCTION process_payment_webhook(
    p_provider TEXT,
    p_payload JSONB
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = metadata, payments, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_event_id TEXT;
    v_event_type TEXT;
    v_webhook_id UUID;
BEGIN
    -- Validate provider
    IF p_provider IS NULL OR p_provider != 'stripe' THEN
        RAISE EXCEPTION 'Invalid provider: %', p_provider
            USING HINT = 'Only "stripe" provider is supported';
    END IF;

    -- Extract event ID and type from Stripe payload
    v_event_id := p_payload->>'id';
    v_event_type := p_payload->>'type';

    IF v_event_id IS NULL THEN
        RAISE EXCEPTION 'Missing event ID in webhook payload'
            USING HINT = 'Stripe webhooks must include "id" field';
    END IF;

    -- Insert with idempotency (ON CONFLICT DO NOTHING)
    -- Stripe may send duplicate webhooks, we only process once
    INSERT INTO metadata.webhooks (
        provider,
        provider_event_id,
        event_type,
        payload,
        signature_verified,
        processed,
        received_at
    ) VALUES (
        p_provider,
        v_event_id,
        v_event_type,
        p_payload,
        FALSE,  -- Signature verification happens in worker
        FALSE,
        NOW()
    )
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id INTO v_webhook_id;

    -- If webhook was duplicate, return early
    IF v_webhook_id IS NULL THEN
        -- Fetch existing webhook ID for response
        SELECT id INTO v_webhook_id
        FROM metadata.webhooks
        WHERE provider = p_provider AND provider_event_id = v_event_id;

        RETURN jsonb_build_object(
            'received', TRUE,
            'duplicate', TRUE,
            'event_id', v_event_id,
            'webhook_id', v_webhook_id
        );
    END IF;

    -- Return success response (Stripe expects 200 OK)
    RETURN jsonb_build_object(
        'received', TRUE,
        'duplicate', FALSE,
        'event_id', v_event_id,
        'event_type', v_event_type,
        'webhook_id', v_webhook_id
    );
END;
$$;

COMMENT ON FUNCTION process_payment_webhook(TEXT, JSONB) IS
    'Webhook endpoint for Stripe payment events. Called via PostgREST at /rpc/process_payment_webhook. Stores webhook with idempotency and enqueues processing job.';


-- ===========================================================================
-- Trigger Function: Enqueue Process Webhook Job
-- ===========================================================================
-- Automatically enqueues River job when webhook is inserted

CREATE OR REPLACE FUNCTION payments.enqueue_process_webhook_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = payments, metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only enqueue job for new, unprocessed webhooks
    IF NEW.processed = FALSE THEN
        INSERT INTO metadata.river_job (
            kind,
            args,
            priority,
            queue,
            max_attempts,
            scheduled_at,
            state
        ) VALUES (
            'process_payment_webhook',
            jsonb_build_object('webhook_id', NEW.id),
            1,  -- Normal priority
            'default',
            3,  -- Retry up to 3 times (webhooks are retried by Stripe anyway)
            NOW(),
            'available'
        );

        RAISE NOTICE 'Enqueued process_payment_webhook job for webhook %', NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION payments.enqueue_process_webhook_job() IS
    'Trigger function that enqueues River job to process webhook when inserted.';


-- ===========================================================================
-- Trigger: Enqueue Process Webhook Job on INSERT
-- ===========================================================================

CREATE TRIGGER enqueue_process_webhook_job_trigger
    AFTER INSERT ON metadata.webhooks
    FOR EACH ROW
    WHEN (NEW.processed = FALSE AND NEW.provider = 'stripe')
    EXECUTE FUNCTION payments.enqueue_process_webhook_job();


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
GRANT EXECUTE ON FUNCTION process_payment_webhook(TEXT, JSONB) TO authenticated, web_anon;  -- Webhooks can come from unauthenticated Stripe

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
