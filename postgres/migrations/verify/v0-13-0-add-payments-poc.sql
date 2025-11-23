-- Verify civic_os:v0-13-0-add-payments-poc on pg

BEGIN;

-- Verify payments schema exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_namespace WHERE nspname = 'payments';

-- Verify payments.transactions table exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_tables
WHERE schemaname = 'payments' AND tablename = 'transactions';

-- Verify required columns exist
SELECT
    id,
    user_id,
    amount,
    currency,
    status,
    provider,
    provider_payment_id,
    provider_client_secret,
    description,
    error_message,
    created_at,
    updated_at
FROM payments.transactions
WHERE FALSE;

-- Verify indexes exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'transactions'
AND indexname = 'idx_payments_transactions_user_id';

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'transactions'
AND indexname = 'idx_payments_transactions_status';

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'transactions'
AND indexname = 'idx_payments_transactions_created_at';

SELECT 1/COUNT(*) FROM pg_catalog.pg_indexes
WHERE schemaname = 'payments' AND tablename = 'transactions'
AND indexname = 'idx_payments_transactions_provider_payment_id';

-- Verify trigger function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc
WHERE proname = 'enqueue_create_intent_job'
AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'payments');

-- Verify triggers exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_trigger
WHERE tgname = 'enqueue_create_intent_job_trigger'
AND tgrelid = 'payments.transactions'::regclass;

SELECT 1/COUNT(*) FROM pg_catalog.pg_trigger
WHERE tgname = 'enqueue_process_webhook_job_trigger'
AND tgrelid = 'metadata.webhooks'::regclass;

-- Verify RPC functions exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc
WHERE proname = 'create_payment_intent_sync'
AND pronargs = 2;  -- Takes 2 arguments (amount, description)

SELECT 1/COUNT(*) FROM pg_catalog.pg_proc
WHERE proname = 'process_payment_webhook'
AND pronargs = 2;  -- Takes 2 arguments (provider, payload)

-- Verify RLS is enabled
SELECT 1/COUNT(*) FROM pg_catalog.pg_class
WHERE oid = 'payments.transactions'::regclass
AND relrowsecurity = true;

-- Verify RLS policies exist
SELECT 1/COUNT(*) FROM pg_catalog.pg_policy
WHERE polname = 'Users see own payments'
AND polrelid = 'payments.transactions'::regclass;

SELECT 1/COUNT(*) FROM pg_catalog.pg_policy
WHERE polname = 'Users create own payments'
AND polrelid = 'payments.transactions'::regclass;

-- Verify public view exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_views
WHERE schemaname = 'public' AND viewname = 'payment_transactions';

-- Verify view columns are accessible
SELECT
    id,
    user_id,
    amount,
    currency,
    status,
    description,
    provider,
    provider_payment_id,
    error_message,
    created_at,
    updated_at
FROM public.payment_transactions
WHERE FALSE;

ROLLBACK;
