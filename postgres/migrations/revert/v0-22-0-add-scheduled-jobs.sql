-- Revert civic-os:v0-22-0-add-scheduled-jobs from pg

BEGIN;

-- ============================================================================
-- 1. DROP VIEW
-- ============================================================================

DROP VIEW IF EXISTS public.scheduled_job_status;


-- ============================================================================
-- 2. DROP FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS public.trigger_scheduled_job(VARCHAR);


-- ============================================================================
-- 3. DROP TABLES (CASCADE handles FK)
-- ============================================================================

DROP TABLE IF EXISTS metadata.scheduled_job_runs;
DROP TABLE IF EXISTS metadata.scheduled_jobs;


-- ============================================================================
-- 4. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
