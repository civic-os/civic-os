# Scheduled Jobs Architecture

## Status: Implemented (v0.22.0)

This document describes the scheduled jobs system in Civic OS, which allows integrators to execute SQL functions on a cron-based schedule.

---

## Overview

Civic OS provides a **metadata-driven scheduled jobs system** that:
- Executes arbitrary SQL functions on a configurable schedule
- Tracks execution history for auditing and debugging
- Handles catch-up for missed jobs (e.g., worker downtime)
- Supports per-job timezone configuration

### Key Design Decisions

1. **Framework-first**: Integrators define jobs via SQL, no Go code changes needed
2. **RPC pattern**: Functions return `JSONB {success, message, details?}` for structured results
3. **Polling-based discovery**: Scheduler runs every minute, checks for due/overdue jobs
4. **Run history**: Every execution is logged with timing and results

---

## Database Schema

### `metadata.scheduled_jobs`

Configuration table for scheduled SQL functions:

```sql
CREATE TABLE metadata.scheduled_jobs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    function_name VARCHAR(200) NOT NULL,    -- SQL function to call
    schedule VARCHAR(100) NOT NULL,          -- cron expression: '0 8 * * *'
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `metadata.scheduled_job_runs`

History of job executions:

```sql
CREATE TABLE metadata.scheduled_job_runs (
    id BIGSERIAL PRIMARY KEY,
    job_id INT NOT NULL REFERENCES metadata.scheduled_jobs(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INT,
    success BOOLEAN,
    message TEXT,
    details JSONB,
    scheduled_for TIMESTAMPTZ,              -- When this run was supposed to happen
    triggered_by VARCHAR(50) NOT NULL DEFAULT 'scheduler'  -- 'scheduler', 'manual', 'catchup'
);
```

---

## Function Contract

Scheduled functions **MUST** follow this signature:

```sql
CREATE OR REPLACE FUNCTION my_scheduled_job()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Do work...
    RETURN jsonb_build_object(
        'success', true,
        'message', 'Processed 5 records',
        'details', jsonb_build_object('count', 5)  -- optional
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', SQLERRM
    );
END;
$$;
```

**Important:**
- Function must return JSONB with at least `success` (boolean) and `message` (string)
- Use `SECURITY DEFINER` to run with elevated privileges if needed
- Use `SET search_path` to control schema resolution
- Wrap in exception handler to gracefully report errors

---

## Go Worker Architecture

### Scheduler + Executor Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    consolidated-worker                           │
│                                                                  │
│  ┌─────────────────┐                                             │
│  │   Go Ticker     │  ← Runs every minute (not River periodic)   │
│  │  (scheduling)   │                                             │
│  └────────┬────────┘                                             │
│           │ Finds due jobs, inserts into River queue             │
│           ▼                                                      │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │           ScheduledJobScheduler                         │     │
│  │  - Reads metadata.scheduled_jobs                        │     │
│  │  - Parses cron expressions with timezone                │     │
│  │  - Finds due/overdue jobs                               │     │
│  │  - Inserts ScheduledJobExecuteArgs into River queue     │     │
│  └────────────────────────────┬────────────────────────────┘     │
│                               │                                  │
│                               ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │              River Job Queue                             │    │
│  │         (scheduled_job_execute jobs)                     │    │
│  └─────────────────────────────────────────────────────────┘     │
│                               │                                  │
│                               ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │           ScheduledJobExecuteWorker                     │     │
│  │  - Executes SQL function dynamically                    │     │
│  │  - Creates run record in scheduled_job_runs             │     │
│  │  - Parses JSONB result                                  │     │
│  │  - Updates last_run_at on scheduled_jobs                │     │
│  └─────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### Architecture Note: Ticker vs River Periodic

The scheduler uses a Go `time.Ticker` instead of River periodic jobs. This design choice was made because:

1. **Service Isolation**: Only consolidated-worker runs the scheduler, not payment-worker
2. **No Leader Election Dependency**: River's leader election is schema-wide, meaning any client could become leader. If payment-worker became leader but had no periodic jobs configured, scheduled jobs wouldn't run.
3. **Simplicity**: Ticker-based scheduling is straightforward and predictable

**Constraint**: If you run multiple consolidated-worker instances, each will run the scheduler independently. Duplicate job execution is prevented by `unique_key` deduplication on River job insertion - only the first insert succeeds.

**Future Scaling**: When horizontal scaling is needed, migrate back to River periodic jobs and ensure all workers have identical periodic job configuration.

### Due/Overdue Detection Logic

```go
// Calculate when the job should have run next (after last_run_at)
nextDue := schedule.Next(lastRunAt.In(timezone))

// If that time is in the past (or now), job is due/overdue
if !nextDue.After(now) {
    // Queue the job for execution
}
```

**Key behaviors:**
- **Catch-up**: If worker was down at 8 AM, job runs when it comes back up
- **No duplicates**: `unique_key` on River job prevents re-queuing same scheduled_for time
- **Timezone-aware**: Cron parsing respects per-job timezone for DST handling

---

## Usage Examples

### Register a Scheduled Job

```sql
-- Create your scheduled function
CREATE OR REPLACE FUNCTION run_daily_cleanup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM some_temp_table WHERE created_at < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'message', format('Deleted %s old records', v_deleted),
        'details', jsonb_build_object('deleted_count', v_deleted)
    );
END;
$$;

-- Register the job
INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES (
    'daily_cleanup',
    'run_daily_cleanup',
    '0 3 * * *',           -- 3 AM daily
    'America/New_York',    -- Eastern time
    'Clean up temporary records older than 30 days'
);
```

### Manual Trigger via RPC

Admins can manually trigger a job:

```sql
SELECT trigger_scheduled_job('daily_cleanup');
-- Returns: {"success": true, "run_id": 42, "job_name": "daily_cleanup", ...}
```

### View Job Status

```sql
-- Quick status overview
SELECT name, enabled, last_run_at, last_run_success, total_runs, success_rate_percent
FROM scheduled_job_status;

-- Recent run history
SELECT started_at, completed_at, success, message, triggered_by
FROM metadata.scheduled_job_runs
WHERE job_id = 1
ORDER BY started_at DESC
LIMIT 10;
```

---

## Cron Expression Reference

Standard 5-field cron format: `minute hour day-of-month month day-of-week`

| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Daily at 8:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 * * 0` | Weekly on Sunday at midnight |
| `0 9 1 * *` | Monthly on the 1st at 9:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |

---

## Best Practices

### Idempotency

Design functions to be idempotent since River provides at-least-once delivery:

```sql
-- Good: Uses INSERT ... ON CONFLICT
INSERT INTO processed_items (item_id, processed_at)
SELECT id, NOW() FROM items WHERE status = 'pending'
ON CONFLICT (item_id) DO NOTHING;

-- Good: Uses row-level locking to prevent double-processing
UPDATE items SET status = 'processing'
WHERE id IN (
    SELECT id FROM items WHERE status = 'pending'
    FOR UPDATE SKIP LOCKED
    LIMIT 100
);
```

### Error Handling

Always catch exceptions and return structured errors:

```sql
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', SQLERRM,
        'details', jsonb_build_object(
            'sqlstate', SQLSTATE,
            'context', pg_exception_context()
        )
    );
```

### Execution Time

Keep scheduled functions fast (< 30 seconds). For longer operations:
- Break into smaller batches
- Use River jobs for parallelization
- Consider running more frequently with smaller workloads

---

## Observability

### River Job Table

```sql
-- View pending/running scheduled job executions
SELECT id, kind, args, state, attempt, created_at
FROM metadata.river_job
WHERE kind = 'scheduled_job_execute'
ORDER BY created_at DESC;
```

### Run History Analysis

```sql
-- Average execution time by job
SELECT
    sj.name,
    COUNT(*) as total_runs,
    AVG(duration_ms) as avg_duration_ms,
    MAX(duration_ms) as max_duration_ms,
    SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as success_rate
FROM metadata.scheduled_job_runs r
JOIN metadata.scheduled_jobs sj ON r.job_id = sj.id
WHERE r.started_at > NOW() - INTERVAL '7 days'
GROUP BY sj.name;
```

---

## Future Enhancements

### Admin UI (Phase 3)
- View configured jobs
- Enable/disable toggle
- View run history with logs
- Manual trigger button
- Schedule editor with cron builder

### Failure Notifications
- Configure alerts when jobs fail
- Integration with notification system
- Escalation policies for repeated failures
