-- Revert civic_os:v0-13-0-add-payments-poc from pg

BEGIN;

-- Drop in reverse order of creation

-- Drop grants
-- Note: anon role might be named web_anon in some setups
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.payment_transactions FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
        REVOKE ALL ON public.payment_transactions FROM web_anon;
    END IF;
END $$;

REVOKE ALL ON public.payment_transactions FROM authenticated;

-- Revoke RPC functions if they exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_payment_intent_sync') THEN
        REVOKE EXECUTE ON FUNCTION create_payment_intent_sync(NUMERIC, TEXT) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'check_existing_payment') THEN
        REVOKE EXECUTE ON FUNCTION payments.check_existing_payment(UUID) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_and_link_payment') THEN
        REVOKE EXECUTE ON FUNCTION payments.create_and_link_payment(NAME, NAME, ANYELEMENT, NAME, NUMERIC, TEXT, UUID, TEXT) FROM authenticated;
    END IF;
END $$;

REVOKE USAGE ON SCHEMA payments FROM authenticated;

-- Drop public view
DROP VIEW IF EXISTS public.payment_transactions;

-- Drop RLS policies
DROP POLICY IF EXISTS "Users create own payments" ON payments.transactions;
DROP POLICY IF EXISTS "Users see own payments" ON payments.transactions;

-- Drop RPC functions
DROP FUNCTION IF EXISTS create_payment_intent_sync(NUMERIC, TEXT);

-- Drop helper functions (added in v0.13.0)
DROP FUNCTION IF EXISTS payments.create_and_link_payment(NAME, NAME, ANYELEMENT, NAME, NUMERIC, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS payments.check_existing_payment(UUID);

-- NOTE: Removed stale PostgREST webhook infrastructure (process_payment_webhook RPC, trigger, trigger function)
-- Webhooks are processed via HTTP endpoint (payment-worker:8080) not PostgREST

-- Drop webhooks table (only if created by this migration, check if exists)
-- Note: Other services may use this table, only drop if empty
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'metadata' AND table_name = 'webhooks') THEN
        -- Only drop if table has no non-payment webhooks
        IF NOT EXISTS (SELECT 1 FROM metadata.webhooks WHERE provider != 'stripe' LIMIT 1) THEN
            DROP TABLE metadata.webhooks;
        END IF;
    END IF;
END $$;

-- Drop trigger
DROP TRIGGER IF EXISTS enqueue_create_intent_job_trigger ON payments.transactions;

-- Drop trigger function
DROP FUNCTION IF EXISTS payments.enqueue_create_intent_job();

-- Drop table
DROP TABLE IF EXISTS payments.transactions;

-- Drop schema
DROP SCHEMA IF EXISTS payments CASCADE;

COMMIT;
