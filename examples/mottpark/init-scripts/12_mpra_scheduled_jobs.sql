-- ============================================================================
-- MOTT PARK RECREATION AREA - SCHEDULED JOBS MIGRATION
-- Part 12: Migrate to Civic OS Scheduled Jobs System (v0.22.0+)
-- ============================================================================
-- Run AFTER upgrading to Civic OS v0.22.0 (which adds metadata.scheduled_jobs)
-- This script:
--   1. Updates run_daily_reservation_tasks() to use the new JSONB return format
--   2. Registers the job with the scheduled jobs system
-- ============================================================================

BEGIN;

-- ============================================================================
-- STEP 1: UPDATE FUNCTION TO NEW RPC PATTERN
-- ============================================================================
-- The scheduled jobs system expects functions to return JSONB with:
--   - success: boolean
--   - message: string
--   - details: optional JSONB object
--
-- This replaces the old TABLE(task_name TEXT, records_processed INT) signature

CREATE OR REPLACE FUNCTION run_daily_reservation_tasks()
RETURNS JSONB
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_results JSONB := '[]'::JSONB;
  v_count INT;
  v_total_processed INT := 0;
BEGIN
  -- 1. Auto-complete past events (run first so payment reminders don't go to completed events)
  v_count := auto_complete_past_events();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'auto_complete_past_events', 'count', v_count);

  -- 2. Send 7-day payment reminders
  v_count := send_payment_reminders_7day();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'payment_reminders_7day', 'count', v_count);

  -- 3. Send payment due today notifications
  v_count := send_payment_due_today();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'payment_due_today', 'count', v_count);

  -- 4. Send overdue payment notifications
  v_count := send_payment_overdue_notifications();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'payment_overdue', 'count', v_count);

  -- 5. Send pre-event reminders to managers
  v_count := send_pre_event_reminders();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'pre_event_reminders', 'count', v_count);

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Processed %s records across 5 tasks', v_total_processed),
    'details', jsonb_build_object(
      'total_processed', v_total_processed,
      'tasks', v_results
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'message', SQLERRM,
    'details', jsonb_build_object(
      'sqlstate', SQLSTATE,
      'context', pg_exception_context()
    )
  );
END;
$$;

COMMENT ON FUNCTION run_daily_reservation_tasks() IS
  'Master function to run all daily reservation system tasks.
   Called automatically by Civic OS Scheduled Jobs system at 8 AM ET.
   Returns JSONB with success, message, and detailed task breakdown.';

-- ============================================================================
-- STEP 2: REGISTER SCHEDULED JOB
-- ============================================================================
-- This registers the job with the Civic OS scheduled jobs system.
-- The worker will automatically pick it up and run it at 8 AM Eastern daily.

INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES (
  'daily_reservation_tasks',
  'run_daily_reservation_tasks',
  '0 8 * * *',           -- 8 AM daily
  'America/Detroit',     -- Eastern Time (Michigan)
  'Runs daily automation: auto-complete past events, payment reminders (7-day, due today, overdue), and pre-event manager notifications.'
) ON CONFLICT (name) DO UPDATE SET
  function_name = EXCLUDED.function_name,
  schedule = EXCLUDED.schedule,
  timezone = EXCLUDED.timezone,
  description = EXCLUDED.description;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After running this script, verify the job is registered:

DO $$
DECLARE
  v_job_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM metadata.scheduled_jobs WHERE name = 'daily_reservation_tasks'
  ) INTO v_job_exists;

  IF NOT v_job_exists THEN
    RAISE EXCEPTION 'Scheduled job registration failed!';
  END IF;

  RAISE NOTICE '✓ Scheduled job "daily_reservation_tasks" registered successfully';
  RAISE NOTICE '  Schedule: 8:00 AM Eastern Time daily';
  RAISE NOTICE '  Function: run_daily_reservation_tasks()';
  RAISE NOTICE '';
  RAISE NOTICE 'To test immediately: SELECT trigger_scheduled_job(''daily_reservation_tasks'');';
  RAISE NOTICE 'To view status: SELECT * FROM scheduled_job_status;';
END $$;

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
-- ============================================================================
/*
After applying this migration:

1. VERIFY THE JOB IS REGISTERED:
   SELECT * FROM scheduled_job_status WHERE name = 'daily_reservation_tasks';

2. TEST THE FUNCTION MANUALLY:
   SELECT run_daily_reservation_tasks();

   Expected output:
   {
     "success": true,
     "message": "Processed N records across 5 tasks",
     "details": {
       "total_processed": N,
       "tasks": [
         {"task": "auto_complete_past_events", "count": 0},
         {"task": "payment_reminders_7day", "count": 0},
         ...
       ]
     }
   }

3. TRIGGER VIA SCHEDULED JOBS SYSTEM:
   SELECT trigger_scheduled_job('daily_reservation_tasks');

   This creates a run record that you can view:
   SELECT * FROM metadata.scheduled_job_runs
   WHERE job_id = (SELECT id FROM metadata.scheduled_jobs WHERE name = 'daily_reservation_tasks')
   ORDER BY started_at DESC LIMIT 5;

4. DISABLE OLD CRON JOB (if applicable):
   If you had an external cron job calling run_daily_reservation_tasks(),
   you can now disable it - the Civic OS worker handles scheduling.

5. MONITOR:
   The scheduled_job_status view shows:
   - Last run time
   - Success/failure of last run
   - Total runs and success rate
*/
