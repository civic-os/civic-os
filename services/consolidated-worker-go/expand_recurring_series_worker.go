package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/teambition/rrule-go"
)

// ============================================================================
// Job Definition: Expand Recurring Series
// ============================================================================

// ExpandRecurringSeriesArgs defines the arguments for expanding a recurring series
type ExpandRecurringSeriesArgs struct {
	SeriesID    int64     `json:"series_id"`
	ExpandUntil time.Time `json:"expand_until"`
}

// Kind returns the job type identifier for River routing
func (ExpandRecurringSeriesArgs) Kind() string {
	return "expand_recurring_series"
}

// InsertOpts specifies River job insertion options
func (ExpandRecurringSeriesArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "recurring",
		MaxAttempts: 10,
		Priority:    2,
	}
}

// ============================================================================
// Series Data Structures
// ============================================================================

// SeriesRecord represents a time_slot_series row
type SeriesRecord struct {
	ID               int64
	GroupID          *int64
	EntityTable      string
	EntityTemplate   map[string]interface{}
	RRULE            string
	Dtstart          time.Time
	Duration         time.Duration
	Timezone         *string
	TimeSlotProperty string
	Status           string
	ExpandedUntil    *time.Time
	CreatedBy        *string
}

// ============================================================================
// Worker Implementation: Expand Recurring Series Worker
// ============================================================================

// ExpandRecurringSeriesWorker implements River's Worker interface
type ExpandRecurringSeriesWorker struct {
	river.WorkerDefaults[ExpandRecurringSeriesArgs]
	dbPool *pgxpool.Pool
}

// Work executes the series expansion job
func (w *ExpandRecurringSeriesWorker) Work(ctx context.Context, job *river.Job[ExpandRecurringSeriesArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting recurring series expansion (attempt %d/%d)", job.ID, job.Attempt, job.MaxAttempts)
	log.Printf("[Job %d] Series ID: %d, Expand Until: %s", job.ID, job.Args.SeriesID, job.Args.ExpandUntil.Format("2006-01-02"))

	// 1. Fetch series record
	series, err := w.fetchSeries(ctx, job.Args.SeriesID)
	if err != nil {
		log.Printf("[Job %d] Error fetching series: %v", job.ID, err)
		return fmt.Errorf("failed to fetch series: %w", err)
	}

	if series.Status != "active" {
		log.Printf("[Job %d] Series status is '%s', skipping expansion", job.ID, series.Status)
		return nil
	}

	log.Printf("[Job %d] Series: entity_table=%s, rrule=%s", job.ID, series.EntityTable, series.RRULE)

	// 2. Validate template against schema (detect drift)
	driftIssues, err := w.checkSchemaDrift(ctx, series)
	if err != nil {
		log.Printf("[Job %d] Error checking schema drift: %v", job.ID, err)
		return fmt.Errorf("failed to check schema drift: %w", err)
	}

	if len(driftIssues) > 0 {
		log.Printf("[Job %d] Schema drift detected, pausing series: %v", job.ID, driftIssues)
		err = w.pauseSeriesWithReason(ctx, series.ID, "Schema drift detected")
		if err != nil {
			log.Printf("[Job %d] Error pausing series: %v", job.ID, err)
		}

		// Notify series creator about schema drift (non-blocking, optional)
		if series.CreatedBy != nil {
			w.notifySeriesSchemasDrift(ctx, series, driftIssues, job.ID)
		}

		return nil // Don't fail the job, just skip expansion
	}

	// 3. Parse RRULE and generate occurrences
	occurrences, err := w.generateOccurrences(series, job.Args.ExpandUntil)
	if err != nil {
		log.Printf("[Job %d] Error generating occurrences: %v", job.ID, err)
		return fmt.Errorf("failed to generate occurrences: %w", err)
	}

	log.Printf("[Job %d] Generated %d potential occurrences", job.ID, len(occurrences))

	// 4. Get existing instance dates to skip
	existingDates, err := w.getExistingInstanceDates(ctx, series.ID)
	if err != nil {
		log.Printf("[Job %d] Error getting existing dates: %v", job.ID, err)
		return fmt.Errorf("failed to get existing dates: %w", err)
	}

	log.Printf("[Job %d] Found %d existing instances", job.ID, len(existingDates))

	// 5. Create new instances
	created := 0
	skipped := 0

	for _, occDate := range occurrences {
		dateKey := occDate.Format("2006-01-02")

		if existingDates[dateKey] {
			continue // Already expanded
		}

		// Build time_slot from occurrence + duration
		endTime := occDate.Add(series.Duration)
		timeSlot := fmt.Sprintf("[%s,%s)",
			occDate.Format(time.RFC3339),
			endTime.Format(time.RFC3339))

		// Prepare entity record
		record := make(map[string]interface{})
		for k, v := range series.EntityTemplate {
			record[k] = v
		}
		record[series.TimeSlotProperty] = timeSlot

		// Insert entity record
		entityID, err := w.insertEntityRecord(ctx, series.EntityTable, record, series.CreatedBy)
		if err != nil {
			// Check if it's a conflict error (GIST exclusion constraint)
			log.Printf("[Job %d] Failed to insert entity for %s: %v", job.ID, dateKey, err)
			// Create junction record marking as conflict_skipped
			err = w.createInstanceRecord(ctx, series.ID, occDate, series.EntityTable, nil, true, "conflict_skipped")
			if err != nil {
				log.Printf("[Job %d] Failed to create skipped instance: %v", job.ID, err)
			}
			skipped++
			continue
		}

		// Create junction record
		err = w.createInstanceRecord(ctx, series.ID, occDate, series.EntityTable, &entityID, false, "")
		if err != nil {
			log.Printf("[Job %d] Failed to create instance record: %v", job.ID, err)
			// Rollback entity? For now, just log
			continue
		}

		created++
	}

	// 6. Update expanded_until
	err = w.updateExpandedUntil(ctx, series.ID, job.Args.ExpandUntil)
	if err != nil {
		log.Printf("[Job %d] Error updating expanded_until: %v", job.ID, err)
		return fmt.Errorf("failed to update expanded_until: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] ✓ Completed: %d created, %d skipped (conflicts), took %v", job.ID, created, skipped, duration)

	return nil
}

// fetchSeries retrieves series record from database
func (w *ExpandRecurringSeriesWorker) fetchSeries(ctx context.Context, seriesID int64) (*SeriesRecord, error) {
	query := `
		SELECT
			id, group_id, entity_table, entity_template, rrule,
			dtstart, duration::text, timezone, time_slot_property, status,
			expanded_until, created_by
		FROM metadata.time_slot_series
		WHERE id = $1
	`

	var series SeriesRecord
	var templateJSON []byte
	var durationStr string

	err := w.dbPool.QueryRow(ctx, query, seriesID).Scan(
		&series.ID, &series.GroupID, &series.EntityTable, &templateJSON,
		&series.RRULE, &series.Dtstart, &durationStr, &series.Timezone,
		&series.TimeSlotProperty, &series.Status, &series.ExpandedUntil,
		&series.CreatedBy,
	)
	if err != nil {
		return nil, err
	}

	// Parse template JSON
	if err := json.Unmarshal(templateJSON, &series.EntityTemplate); err != nil {
		return nil, fmt.Errorf("failed to parse entity_template: %w", err)
	}

	// Parse duration (PostgreSQL interval to Go duration)
	series.Duration, err = parsePGInterval(durationStr)
	if err != nil {
		return nil, fmt.Errorf("failed to parse duration: %w", err)
	}

	return &series, nil
}

// generateOccurrences parses RRULE and returns occurrence times in UTC.
// Handles timezone-aware expansion for wall-clock DST handling.
func (w *ExpandRecurringSeriesWorker) generateOccurrences(series *SeriesRecord, until time.Time) ([]time.Time, error) {
	// Determine the timezone for expansion
	// When a timezone is specified, we expand in that local time to respect DST transitions
	// (e.g., "2 PM every Monday" stays 2 PM local year-round)
	loc := time.UTC
	if series.Timezone != nil && *series.Timezone != "" {
		var err error
		loc, err = time.LoadLocation(*series.Timezone)
		if err != nil {
			log.Printf("[Warning] Invalid timezone '%s', falling back to UTC: %v", *series.Timezone, err)
			loc = time.UTC
		}
	}

	// Convert dtstart to the target timezone for wall-clock aware expansion
	localDtstart := series.Dtstart.In(loc)
	localUntil := until.In(loc)

	// Parse RRULE string with timezone-aware dtstart
	ruleStr := fmt.Sprintf("DTSTART:%s\nRRULE:%s",
		localDtstart.Format("20060102T150405"),
		series.RRULE)

	ruleSet, err := rrule.StrToRRuleSet(ruleStr)
	if err != nil {
		// Try simpler format if the full format fails
		rule, err := rrule.StrToRRule(series.RRULE)
		if err != nil {
			return nil, fmt.Errorf("failed to parse RRULE: %w", err)
		}
		rule.DTStart(localDtstart)
		localOccurrences := rule.Between(localDtstart, localUntil, true)
		// Convert results back to UTC for storage
		return convertToUTC(localOccurrences, loc), nil
	}

	localOccurrences := ruleSet.Between(localDtstart, localUntil, true)
	// Convert results back to UTC for storage
	return convertToUTC(localOccurrences, loc), nil
}

// convertToUTC converts a slice of times from local timezone to UTC.
// This ensures storage is always UTC while respecting wall-clock DST transitions.
func convertToUTC(times []time.Time, loc *time.Location) []time.Time {
	result := make([]time.Time, len(times))
	for i, t := range times {
		// Create time in the local timezone, then convert to UTC
		localTime := time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, loc)
		result[i] = localTime.UTC()
	}
	return result
}

// getExistingInstanceDates returns a map of already-expanded dates
func (w *ExpandRecurringSeriesWorker) getExistingInstanceDates(ctx context.Context, seriesID int64) (map[string]bool, error) {
	query := `
		SELECT occurrence_date
		FROM metadata.time_slot_instances
		WHERE series_id = $1
	`

	rows, err := w.dbPool.Query(ctx, query, seriesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	dates := make(map[string]bool)
	for rows.Next() {
		var date time.Time
		if err := rows.Scan(&date); err != nil {
			return nil, err
		}
		dates[date.Format("2006-01-02")] = true
	}

	return dates, rows.Err()
}

// insertEntityRecord inserts a new entity record and returns its ID
func (w *ExpandRecurringSeriesWorker) insertEntityRecord(ctx context.Context, tableName string, record map[string]interface{}, createdBy *string) (int64, error) {
	// Build INSERT query dynamically
	columns := make([]string, 0, len(record)+1)
	values := make([]interface{}, 0, len(record)+1)
	placeholders := make([]string, 0, len(record)+1)

	i := 1
	for col, val := range record {
		columns = append(columns, col)
		values = append(values, val)
		placeholders = append(placeholders, fmt.Sprintf("$%d", i))
		i++
	}

	// Add created_by if provided
	if createdBy != nil {
		columns = append(columns, "created_by")
		values = append(values, *createdBy)
		placeholders = append(placeholders, fmt.Sprintf("$%d", i))
	}

	query := fmt.Sprintf(
		"INSERT INTO public.%s (%s) VALUES (%s) RETURNING id",
		tableName,
		joinStrings(columns, ", "),
		joinStrings(placeholders, ", "),
	)

	var entityID int64
	err := w.dbPool.QueryRow(ctx, query, values...).Scan(&entityID)
	return entityID, err
}

// createInstanceRecord creates a junction record
func (w *ExpandRecurringSeriesWorker) createInstanceRecord(ctx context.Context, seriesID int64, occDate time.Time, entityTable string, entityID *int64, isException bool, exceptionType string) error {
	query := `
		INSERT INTO metadata.time_slot_instances
		(series_id, occurrence_date, entity_table, entity_id, is_exception, exception_type)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))
		ON CONFLICT (series_id, occurrence_date) DO NOTHING
	`

	_, err := w.dbPool.Exec(ctx, query, seriesID, occDate.Format("2006-01-02"), entityTable, entityID, isException, exceptionType)
	return err
}

// updateExpandedUntil updates the series expanded_until field
func (w *ExpandRecurringSeriesWorker) updateExpandedUntil(ctx context.Context, seriesID int64, expandedUntil time.Time) error {
	query := `
		UPDATE metadata.time_slot_series
		SET expanded_until = $1
		WHERE id = $2
	`

	_, err := w.dbPool.Exec(ctx, query, expandedUntil.Format("2006-01-02"), seriesID)
	return err
}

// checkSchemaDrift validates template against current schema
func (w *ExpandRecurringSeriesWorker) checkSchemaDrift(ctx context.Context, series *SeriesRecord) ([]string, error) {
	templateJSON, err := json.Marshal(series.EntityTemplate)
	if err != nil {
		return nil, err
	}

	query := `
		SELECT field, issue
		FROM metadata.validate_template_against_schema($1, $2)
	`

	rows, err := w.dbPool.Query(ctx, query, series.EntityTable, templateJSON)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var issues []string
	for rows.Next() {
		var field, issue string
		if err := rows.Scan(&field, &issue); err != nil {
			return nil, err
		}
		issues = append(issues, fmt.Sprintf("%s: %s", field, issue))
	}

	return issues, rows.Err()
}

// pauseSeriesWithReason pauses a series due to an issue
func (w *ExpandRecurringSeriesWorker) pauseSeriesWithReason(ctx context.Context, seriesID int64, reason string) error {
	query := `
		UPDATE metadata.time_slot_series
		SET status = 'needs_attention'
		WHERE id = $1
	`

	_, err := w.dbPool.Exec(ctx, query, seriesID)
	return err
}

// ============================================================================
// Helper Functions
// ============================================================================

// parsePGInterval parses a PostgreSQL interval string to Go duration
func parsePGInterval(interval string) (time.Duration, error) {
	// PostgreSQL intervals can be in various formats:
	// "02:00:00" (HH:MM:SS)
	// "1 day 02:00:00"
	// "PT2H" (ISO 8601)

	// Try simple HH:MM:SS format first
	d, err := time.ParseDuration(
		interval + "s",
	)
	if err == nil {
		return d, nil
	}

	// Try parsing as hours:minutes:seconds
	var hours, minutes, seconds int
	_, err = fmt.Sscanf(interval, "%d:%d:%d", &hours, &minutes, &seconds)
	if err == nil {
		return time.Duration(hours)*time.Hour +
			time.Duration(minutes)*time.Minute +
			time.Duration(seconds)*time.Second, nil
	}

	// Fail with error instead of silent default - this will cause job retry and alert operators
	return 0, fmt.Errorf("could not parse PostgreSQL interval '%s': unsupported format", interval)
}

// joinStrings joins strings with a separator
func joinStrings(strs []string, sep string) string {
	if len(strs) == 0 {
		return ""
	}
	result := strs[0]
	for i := 1; i < len(strs); i++ {
		result += sep + strs[i]
	}
	return result
}

// notifySeriesSchemasDrift attempts to send a notification to the series creator
// about schema drift. This is non-blocking - failures are logged but don't stop the worker.
// Requires 'series_schema_drift' notification template to be configured in metadata.notification_templates.
func (w *ExpandRecurringSeriesWorker) notifySeriesSchemasDrift(ctx context.Context, series *SeriesRecord, driftIssues []string, jobID int64) {
	// Check if the notification template exists
	var templateExists bool
	err := w.dbPool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM metadata.notification_templates
			WHERE name = 'series_schema_drift'
		)
	`).Scan(&templateExists)

	if err != nil || !templateExists {
		log.Printf("[Job %d] Schema drift notification skipped: template 'series_schema_drift' not configured", jobID)
		return
	}

	// Build entity data for notification template
	entityData := map[string]interface{}{
		"series_id":     series.ID,
		"group_id":      series.GroupID,
		"entity_table":  series.EntityTable,
		"drift_issues":  driftIssues,
		"drift_summary": joinStrings(driftIssues, "; "),
	}
	entityDataJSON, err := json.Marshal(entityData)
	if err != nil {
		log.Printf("[Job %d] Schema drift notification skipped: failed to marshal entity data: %v", jobID, err)
		return
	}

	// Insert notification record and queue job
	_, err = w.dbPool.Exec(ctx, `
		WITH notif AS (
			INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data, channels)
			VALUES ($1, 'series_schema_drift', 'time_slot_series', $2::TEXT, $3::JSONB, ARRAY['email'])
			RETURNING id
		)
		INSERT INTO river_job (state, queue, kind, args, scheduled_at)
		SELECT
			'available',
			'notifications',
			'send_notification',
			jsonb_build_object(
				'notification_id', notif.id::TEXT,
				'user_id', $1::TEXT,
				'template_name', 'series_schema_drift',
				'entity_type', 'time_slot_series',
				'entity_id', $2::TEXT,
				'entity_data', $3::JSONB,
				'channels', ARRAY['email']
			),
			NOW()
		FROM notif
	`, series.CreatedBy, series.ID, entityDataJSON)

	if err != nil {
		log.Printf("[Job %d] Schema drift notification skipped: failed to queue notification: %v", jobID, err)
		return
	}

	log.Printf("[Job %d] Schema drift notification queued for user %s", jobID, *series.CreatedBy)
}
