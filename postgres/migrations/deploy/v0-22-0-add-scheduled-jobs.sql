-- Deploy civic-os:v0-22-0-add-scheduled-jobs to pg
-- requires: v0-21-0-add-processing-fees
-- Scheduled Jobs: Metadata-driven SQL function scheduling with run history
-- Version: 0.22.0

BEGIN;

-- ============================================================================
-- 1. CREATE scheduled_jobs TABLE
-- ============================================================================
-- Configuration table for scheduled SQL functions

CREATE TABLE metadata.scheduled_jobs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    function_name VARCHAR(200) NOT NULL,    -- SQL function to call (must return JSONB)
    schedule VARCHAR(100) NOT NULL,          -- cron expression: '0 8 * * *'
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Denormalized for quick access (updated by executor after each run)
    last_run_at TIMESTAMPTZ,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.scheduled_jobs IS
    'Configuration for scheduled SQL functions. Jobs are executed by the consolidated worker service.';

COMMENT ON COLUMN metadata.scheduled_jobs.function_name IS
    'Name of the SQL function to execute. Must return JSONB with {success: boolean, message: string, details?: object}.';

COMMENT ON COLUMN metadata.scheduled_jobs.schedule IS
    'Cron expression for job scheduling (e.g., ''0 8 * * *'' for daily at 8 AM). Standard 5-field format: minute hour day-of-month month day-of-week.';

COMMENT ON COLUMN metadata.scheduled_jobs.timezone IS
    'IANA timezone for schedule interpretation (e.g., ''America/Detroit'', ''UTC'').';


-- ============================================================================
-- 2. CREATE scheduled_job_runs TABLE
-- ============================================================================
-- History of job executions for auditing and debugging

CREATE TABLE metadata.scheduled_job_runs (
    id BIGSERIAL PRIMARY KEY,
    job_id INT NOT NULL REFERENCES metadata.scheduled_jobs(id) ON DELETE CASCADE,

    -- Timing
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INT,

    -- Result
    success BOOLEAN,
    message TEXT,
    details JSONB,                           -- Full JSONB response from function

    -- Context
    scheduled_for TIMESTAMPTZ,               -- When this run was supposed to happen
    triggered_by VARCHAR(50) NOT NULL DEFAULT 'scheduler'  -- 'scheduler', 'manual', 'catchup'
);

COMMENT ON TABLE metadata.scheduled_job_runs IS
    'Execution history for scheduled jobs. Stores result of each run for auditing and debugging.';

COMMENT ON COLUMN metadata.scheduled_job_runs.scheduled_for IS
    'The scheduled time this run was meant to execute (may differ from started_at for catch-up runs).';

COMMENT ON COLUMN metadata.scheduled_job_runs.triggered_by IS
    'How the job was triggered: scheduler (normal), manual (UI/RPC), catchup (missed while offline).';


-- Create indexes for common queries
CREATE INDEX idx_scheduled_job_runs_job_id ON metadata.scheduled_job_runs(job_id);
CREATE INDEX idx_scheduled_job_runs_started_at ON metadata.scheduled_job_runs(started_at DESC);
CREATE INDEX idx_scheduled_job_runs_job_success ON metadata.scheduled_job_runs(job_id, success);


-- ============================================================================
-- 3. CREATE HELPER FUNCTION FOR MANUAL JOB TRIGGERING
-- ============================================================================
-- Allows admins to manually trigger a scheduled job via RPC

CREATE OR REPLACE FUNCTION public.trigger_scheduled_job(p_job_name VARCHAR(100))
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_job RECORD;
    v_run_id BIGINT;
    v_result JSONB;
    v_start_time TIMESTAMPTZ;
    v_end_time TIMESTAMPTZ;
    v_duration_ms INT;
BEGIN
    -- Permission check
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only administrators can trigger scheduled jobs'
            USING HINT = 'Contact an administrator to run this job';
    END IF;

    -- Find the job
    SELECT * INTO v_job
    FROM metadata.scheduled_jobs
    WHERE name = p_job_name;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Scheduled job not found: %', p_job_name;
    END IF;

    -- Create run record
    v_start_time := NOW();
    INSERT INTO metadata.scheduled_job_runs (job_id, started_at, triggered_by)
    VALUES (v_job.id, v_start_time, 'manual')
    RETURNING id INTO v_run_id;

    -- Execute the function dynamically
    BEGIN
        EXECUTE format('SELECT %I()', v_job.function_name) INTO v_result;
        v_end_time := NOW();
        v_duration_ms := EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000;

        -- Update run record with result
        UPDATE metadata.scheduled_job_runs
        SET completed_at = v_end_time,
            duration_ms = v_duration_ms,
            success = COALESCE((v_result->>'success')::boolean, true),
            message = v_result->>'message',
            details = v_result
        WHERE id = v_run_id;

        -- Update last_run_at on job
        UPDATE metadata.scheduled_jobs
        SET last_run_at = v_start_time,
            updated_at = NOW()
        WHERE id = v_job.id;

        RETURN jsonb_build_object(
            'success', true,
            'run_id', v_run_id,
            'job_name', v_job.name,
            'result', v_result,
            'duration_ms', v_duration_ms
        );

    EXCEPTION WHEN OTHERS THEN
        v_end_time := NOW();
        v_duration_ms := EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000;

        -- Update run record with error
        UPDATE metadata.scheduled_job_runs
        SET completed_at = v_end_time,
            duration_ms = v_duration_ms,
            success = false,
            message = SQLERRM
        WHERE id = v_run_id;

        RETURN jsonb_build_object(
            'success', false,
            'run_id', v_run_id,
            'job_name', v_job.name,
            'error', SQLERRM,
            'duration_ms', v_duration_ms
        );
    END;
END;
$$;

COMMENT ON FUNCTION public.trigger_scheduled_job IS
    'Manually trigger a scheduled job by name. Requires admin role. Returns execution result.';

GRANT EXECUTE ON FUNCTION public.trigger_scheduled_job(VARCHAR) TO authenticated;


-- ============================================================================
-- 4. CREATE VIEW FOR SCHEDULED JOB STATUS
-- ============================================================================
-- Convenient view combining job config with latest run status

CREATE OR REPLACE VIEW public.scheduled_job_status AS
SELECT
    sj.id,
    sj.name,
    sj.description,
    sj.function_name,
    sj.schedule,
    sj.timezone,
    sj.enabled,
    sj.last_run_at,
    sj.created_at,
    sj.updated_at,
    -- Latest run info (denormalized for convenience)
    lr.id AS last_run_id,
    lr.success AS last_run_success,
    lr.message AS last_run_message,
    lr.duration_ms AS last_run_duration_ms,
    lr.triggered_by AS last_run_triggered_by,
    -- Run statistics
    stats.total_runs,
    stats.successful_runs,
    stats.failed_runs,
    CASE
        WHEN stats.total_runs > 0
        THEN ROUND((stats.successful_runs::numeric / stats.total_runs) * 100, 1)
        ELSE NULL
    END AS success_rate_percent
FROM metadata.scheduled_jobs sj
LEFT JOIN LATERAL (
    SELECT *
    FROM metadata.scheduled_job_runs
    WHERE job_id = sj.id
    ORDER BY started_at DESC
    LIMIT 1
) lr ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) AS total_runs,
        COUNT(*) FILTER (WHERE success = true) AS successful_runs,
        COUNT(*) FILTER (WHERE success = false) AS failed_runs
    FROM metadata.scheduled_job_runs
    WHERE job_id = sj.id
) stats ON true;

COMMENT ON VIEW public.scheduled_job_status IS
    'View combining scheduled job configuration with latest run status and statistics.';

GRANT SELECT ON public.scheduled_job_status TO authenticated;


-- ============================================================================
-- 5. PERMISSIONS
-- ============================================================================
-- Admins can manage jobs, authenticated users can view status

GRANT SELECT ON metadata.scheduled_jobs TO authenticated;
GRANT SELECT ON metadata.scheduled_job_runs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.scheduled_jobs_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.scheduled_job_runs_id_seq TO authenticated;

-- Admin-only write access (for future admin UI)
-- INSERT/UPDATE/DELETE would require has_permission checks in RPC functions


-- ============================================================================
-- 6. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
