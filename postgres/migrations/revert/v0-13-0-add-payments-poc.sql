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
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'process_payment_webhook') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION process_payment_webhook(TEXT, JSONB) FROM authenticated, web_anon';
    END IF;
END $$;

REVOKE USAGE ON SCHEMA payments FROM authenticated;

-- Drop public view
DROP VIEW IF EXISTS public.payment_transactions;

-- Drop RLS policies
DROP POLICY IF EXISTS "Users create own payments" ON payments.transactions;
DROP POLICY IF EXISTS "Users see own payments" ON payments.transactions;

-- Drop webhook trigger
DROP TRIGGER IF EXISTS enqueue_process_webhook_job_trigger ON metadata.webhooks;

-- Drop webhook trigger function
DROP FUNCTION IF EXISTS payments.enqueue_process_webhook_job();

-- Drop RPC functions
DROP FUNCTION IF EXISTS process_payment_webhook(TEXT, JSONB);
DROP FUNCTION IF EXISTS create_payment_intent_sync(NUMERIC, TEXT);

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
