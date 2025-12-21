-- Verify civic-os:v0-22-0-add-scheduled-jobs on pg

BEGIN;

-- Verify scheduled_jobs table exists with expected columns
SELECT
    id,
    name,
    description,
    function_name,
    schedule,
    timezone,
    enabled,
    last_run_at,
    created_at,
    updated_at
FROM metadata.scheduled_jobs
WHERE FALSE;

-- Verify scheduled_job_runs table exists with expected columns
SELECT
    id,
    job_id,
    started_at,
    completed_at,
    duration_ms,
    success,
    message,
    details,
    scheduled_for,
    triggered_by
FROM metadata.scheduled_job_runs
WHERE FALSE;

-- Verify trigger_scheduled_job function exists
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'trigger_scheduled_job'
  AND pronamespace = 'public'::regnamespace;

-- Verify scheduled_job_status view exists
SELECT
    id,
    name,
    description,
    function_name,
    schedule,
    timezone,
    enabled,
    last_run_at,
    last_run_id,
    last_run_success,
    last_run_message,
    total_runs,
    successful_runs,
    failed_runs,
    success_rate_percent
FROM public.scheduled_job_status
WHERE FALSE;

-- Verify indexes exist
SELECT 1/COUNT(*)
FROM pg_indexes
WHERE indexname = 'idx_scheduled_job_runs_job_id';

SELECT 1/COUNT(*)
FROM pg_indexes
WHERE indexname = 'idx_scheduled_job_runs_started_at';

ROLLBACK;
