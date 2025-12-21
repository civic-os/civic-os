package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/robfig/cron/v3"
)

// ============================================================================
// Job Definitions
// ============================================================================

// ScheduledJobExecuteArgs defines the arguments for executing a scheduled job
type ScheduledJobExecuteArgs struct {
	JobID        int       `json:"job_id"`
	JobName      string    `json:"job_name"`
	FunctionName string    `json:"function_name"`
	ScheduledFor time.Time `json:"scheduled_for"`
	TriggeredBy  string    `json:"triggered_by"` // "scheduler", "manual", "catchup"
}

// Kind returns the job type identifier for River routing
func (ScheduledJobExecuteArgs) Kind() string {
	return "scheduled_job_execute"
}

// InsertOpts specifies River job insertion options
func (ScheduledJobExecuteArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "scheduled_jobs",
		MaxAttempts: 3,
		Priority:    2,
	}
}

// ============================================================================
// Data Structures
// ============================================================================

// ScheduledJobRow represents a row from metadata.scheduled_jobs
type ScheduledJobRow struct {
	ID           int
	Name         string
	FunctionName string
	Schedule     string
	Timezone     string
	Enabled      bool
	LastRunAt    sql.NullTime
	CreatedAt    time.Time
}

// ============================================================================
// Scheduler Implementation (Go Ticker)
// ============================================================================

// ScheduledJobScheduler checks for due jobs using a Go ticker.
//
// ARCHITECTURE: This scheduler uses a Go time.Ticker instead of River periodic
// jobs. This ensures only consolidated-worker runs the scheduler, avoiding the
// issue where payment-worker could win River's leader election and fail to run
// periodic jobs (since it didn't have them configured).
//
// CONSTRAINT: If you run multiple consolidated-worker instances, each will run
// the scheduler independently. Duplicate job execution is prevented by unique_key
// deduplication on River job insertion.
type ScheduledJobScheduler struct {
	dbPool *pgxpool.Pool
	ticker *time.Ticker
	done   chan bool
}

// Start begins the scheduler goroutine that checks for due jobs every minute
func (s *ScheduledJobScheduler) Start(ctx context.Context) {
	s.ticker = time.NewTicker(1 * time.Minute)
	s.done = make(chan bool)

	// Run immediately on start to catch any missed jobs
	s.checkDueJobs(ctx)

	go func() {
		for {
			select {
			case <-s.ticker.C:
				s.checkDueJobs(ctx)
			case <-s.done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	log.Println("[Scheduler] Started - checking for due jobs every minute")
}

// Stop gracefully shuts down the scheduler
func (s *ScheduledJobScheduler) Stop() {
	if s.ticker != nil {
		s.ticker.Stop()
	}
	if s.done != nil {
		s.done <- true
	}
	log.Println("[Scheduler] Stopped")
}

// checkDueJobs queries enabled scheduled jobs and queues any that are due
func (s *ScheduledJobScheduler) checkDueJobs(ctx context.Context) {
	log.Printf("[Scheduler] Checking for due scheduled jobs...")

	// Query all enabled scheduled jobs
	rows, err := s.dbPool.Query(ctx, `
		SELECT id, name, function_name, schedule, timezone, enabled, last_run_at, created_at
		FROM metadata.scheduled_jobs
		WHERE enabled = true
	`)
	if err != nil {
		log.Printf("[Scheduler] Failed to query scheduled jobs: %v", err)
		return
	}
	defer rows.Close()

	now := time.Now()
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	jobsQueued := 0
	jobsSkipped := 0

	for rows.Next() {
		var sj ScheduledJobRow
		err := rows.Scan(
			&sj.ID, &sj.Name, &sj.FunctionName, &sj.Schedule,
			&sj.Timezone, &sj.Enabled, &sj.LastRunAt, &sj.CreatedAt,
		)
		if err != nil {
			log.Printf("[Scheduler] Error scanning job row: %v", err)
			continue
		}

		// Load timezone
		loc, err := time.LoadLocation(sj.Timezone)
		if err != nil {
			log.Printf("[Scheduler] Invalid timezone '%s' for job '%s', using UTC: %v", sj.Timezone, sj.Name, err)
			loc = time.UTC
		}

		// Parse cron schedule
		schedule, err := parser.Parse(sj.Schedule)
		if err != nil {
			log.Printf("[Scheduler] Invalid cron expression '%s' for job '%s': %v", sj.Schedule, sj.Name, err)
			continue
		}

		// Determine base time for calculating next run
		var baseTime time.Time
		if sj.LastRunAt.Valid {
			baseTime = sj.LastRunAt.Time
		} else {
			// Never run - use created_at or 24 hours ago, whichever is later
			// This prevents running catch-up jobs from before the job was created
			dayAgo := now.Add(-24 * time.Hour)
			if sj.CreatedAt.After(dayAgo) {
				baseTime = sj.CreatedAt
			} else {
				baseTime = dayAgo
			}
		}

		// Calculate when the job should have run next (after baseTime)
		// Use the timezone for proper DST handling
		nextDue := schedule.Next(baseTime.In(loc))

		// If nextDue is in the past (or now), job is due/overdue
		if !nextDue.After(now) {
			triggeredBy := "scheduler"
			if sj.LastRunAt.Valid && now.Sub(nextDue) > time.Hour {
				triggeredBy = "catchup" // More than 1 hour overdue
			}

			// Queue the job for execution via direct SQL insert
			// Use unique_key to prevent duplicate jobs for the same scheduled_for time
			err := s.queueExecuteJob(ctx, sj, nextDue, triggeredBy)
			if err != nil {
				log.Printf("[Scheduler] Failed to queue job '%s': %v", sj.Name, err)
				continue
			}

			log.Printf("[Scheduler] Queued job '%s' (scheduled_for: %s, triggered_by: %s)",
				sj.Name, nextDue.Format(time.RFC3339), triggeredBy)
			jobsQueued++
		} else {
			jobsSkipped++
		}
	}

	if err := rows.Err(); err != nil {
		log.Printf("[Scheduler] Error iterating scheduled jobs: %v", err)
		return
	}

	log.Printf("[Scheduler] Check complete: %d jobs queued, %d jobs not yet due", jobsQueued, jobsSkipped)
}

// queueExecuteJob inserts a scheduled job execution into the River queue
// Uses unique_key to prevent duplicate jobs for the same scheduled_for time
func (s *ScheduledJobScheduler) queueExecuteJob(ctx context.Context, sj ScheduledJobRow, scheduledFor time.Time, triggeredBy string) error {
	args := ScheduledJobExecuteArgs{
		JobID:        sj.ID,
		JobName:      sj.Name,
		FunctionName: sj.FunctionName,
		ScheduledFor: scheduledFor,
		TriggeredBy:  triggeredBy,
	}

	argsJSON, err := json.Marshal(args)
	if err != nil {
		return fmt.Errorf("failed to marshal job args: %w", err)
	}

	// Insert directly into River job table
	// unique_key prevents duplicate jobs for the same job_id + scheduled_for combination
	uniqueKey := fmt.Sprintf("scheduled_job:%d:%s", sj.ID, scheduledFor.Format(time.RFC3339))

	_, err = s.dbPool.Exec(ctx, `
		INSERT INTO metadata.river_job (
			state,
			queue,
			kind,
			args,
			priority,
			max_attempts,
			scheduled_at,
			unique_key
		) VALUES (
			'available',
			'scheduled_jobs',
			'scheduled_job_execute',
			$1,
			2,
			3,
			NOW(),
			$2
		)
		ON CONFLICT (kind, unique_key) WHERE unique_key IS NOT NULL DO NOTHING
	`, argsJSON, uniqueKey)

	return err
}

// ============================================================================
// Executor Worker Implementation (River Worker - unchanged)
// ============================================================================

// ScheduledJobExecuteWorker executes scheduled SQL functions
type ScheduledJobExecuteWorker struct {
	river.WorkerDefaults[ScheduledJobExecuteArgs]
	dbPool *pgxpool.Pool
}

// Work executes a scheduled SQL function and records the result
func (w *ScheduledJobExecuteWorker) Work(ctx context.Context, job *river.Job[ScheduledJobExecuteArgs]) error {
	startTime := time.Now()
	args := job.Args

	log.Printf("[Job %d] Executing scheduled job '%s' (function: %s, scheduled_for: %s, triggered_by: %s)",
		job.ID, args.JobName, args.FunctionName, args.ScheduledFor.Format(time.RFC3339), args.TriggeredBy)

	// Create run record
	var runID int64
	err := w.dbPool.QueryRow(ctx, `
		INSERT INTO metadata.scheduled_job_runs (job_id, started_at, scheduled_for, triggered_by)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, args.JobID, startTime, args.ScheduledFor, args.TriggeredBy).Scan(&runID)

	if err != nil {
		return fmt.Errorf("failed to create run record: %w", err)
	}

	// Execute the SQL function dynamically
	// Using format string with %I for identifier quoting to prevent SQL injection
	query := fmt.Sprintf("SELECT %s()", args.FunctionName)

	var resultJSON []byte
	err = w.dbPool.QueryRow(ctx, query).Scan(&resultJSON)

	endTime := time.Now()
	durationMs := int(endTime.Sub(startTime).Milliseconds())

	if err != nil {
		// Function execution failed
		log.Printf("[Job %d] Function execution failed: %v", job.ID, err)

		// Update run record with error
		_, updateErr := w.dbPool.Exec(ctx, `
			UPDATE metadata.scheduled_job_runs
			SET completed_at = $1, duration_ms = $2, success = false, message = $3
			WHERE id = $4
		`, endTime, durationMs, err.Error(), runID)

		if updateErr != nil {
			log.Printf("[Job %d] Failed to update run record: %v", job.ID, updateErr)
		}

		// Update last_run_at even on failure
		w.updateLastRunAt(ctx, args.JobID, startTime)

		return fmt.Errorf("function execution failed: %w", err)
	}

	// Parse result JSON
	var result struct {
		Success bool            `json:"success"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details,omitempty"`
	}

	if err := json.Unmarshal(resultJSON, &result); err != nil {
		// Result isn't valid JSON - treat as success with raw message
		result.Success = true
		result.Message = string(resultJSON)
	}

	// Update run record with result
	_, err = w.dbPool.Exec(ctx, `
		UPDATE metadata.scheduled_job_runs
		SET completed_at = $1, duration_ms = $2, success = $3, message = $4, details = $5
		WHERE id = $6
	`, endTime, durationMs, result.Success, result.Message, resultJSON, runID)

	if err != nil {
		log.Printf("[Job %d] Failed to update run record: %v", job.ID, err)
	}

	// Update last_run_at on the scheduled job
	w.updateLastRunAt(ctx, args.JobID, startTime)

	if result.Success {
		log.Printf("[Job %d] ✓ Completed successfully: %s (took %dms)", job.ID, result.Message, durationMs)
	} else {
		log.Printf("[Job %d] ✗ Completed with failure: %s (took %dms)", job.ID, result.Message, durationMs)
		// Don't return error - the function ran but reported failure
		// This is different from the function crashing
	}

	return nil
}

// updateLastRunAt updates the last_run_at field on a scheduled job
func (w *ScheduledJobExecuteWorker) updateLastRunAt(ctx context.Context, jobID int, runTime time.Time) {
	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.scheduled_jobs
		SET last_run_at = $1, updated_at = NOW()
		WHERE id = $2
	`, runTime, jobID)

	if err != nil {
		log.Printf("[Executor] Failed to update last_run_at for job %d: %v", jobID, err)
	}
}
