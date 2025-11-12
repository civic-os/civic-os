package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// ValidationArgs defines the validation job arguments
type ValidationArgs struct {
	ValidationID    string `json:"validation_id"`
	SubjectTemplate string `json:"subject_template"`
	HTMLTemplate    string `json:"html_template"`
	TextTemplate    string `json:"text_template"`
	SMSTemplate     string `json:"sms_template"`
}

// Kind returns the job type identifier
func (ValidationArgs) Kind() string { return "validate_template_parts" }

// InsertOpts returns job insertion options
func (ValidationArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "notifications",
		MaxAttempts: 3,
		Priority:    100, // HIGH PRIORITY (vs 1 for notifications)
	}
}

// ValidationWorker validates template syntax
type ValidationWorker struct {
	river.WorkerDefaults[ValidationArgs]
	dbPool   *pgxpool.Pool
	renderer *Renderer
}

// Work executes the validation job
func (w *ValidationWorker) Work(ctx context.Context, job *river.Job[ValidationArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting validation job (attempt %d/%d): validation_id=%s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.ValidationID)

	// Validate each non-empty template part
	results := []ValidationPartResult{}

	if job.Args.SubjectTemplate != "" {
		result := w.validatePart("subject", job.Args.SubjectTemplate, false)
		results = append(results, result)
	}

	if job.Args.HTMLTemplate != "" {
		result := w.validatePart("html", job.Args.HTMLTemplate, true)
		results = append(results, result)
	}

	if job.Args.TextTemplate != "" {
		result := w.validatePart("text", job.Args.TextTemplate, false)
		results = append(results, result)
	}

	if job.Args.SMSTemplate != "" {
		result := w.validatePart("sms", job.Args.SMSTemplate, false)
		results = append(results, result)
	}

	// Insert results into database
	for _, result := range results {
		err := w.insertValidationResult(ctx, job.Args.ValidationID, result)
		if err != nil {
			log.Printf("[Job %d] Failed to insert validation result: %v", job.ID, err)
			return fmt.Errorf("failed to insert validation result: %w", err)
		}
	}

	// Mark validation as completed
	err := w.markValidationCompleted(ctx, job.Args.ValidationID)
	if err != nil {
		log.Printf("[Job %d] Failed to mark validation completed: %v", job.ID, err)
		return fmt.Errorf("failed to mark validation completed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] ✓ Validation completed in %v (validated %d parts)", job.ID, duration, len(results))

	return nil
}

// ValidationPartResult holds the result of validating a single template part
type ValidationPartResult struct {
	PartName     string
	Valid        bool
	ErrorMessage string
}

// validatePart validates a single template part
func (w *ValidationWorker) validatePart(partName, template string, isHTML bool) ValidationPartResult {
	// Try to parse the template
	err := w.renderer.ValidateTemplate(template, isHTML)

	if err != nil {
		return ValidationPartResult{
			PartName:     partName,
			Valid:        false,
			ErrorMessage: err.Error(),
		}
	}

	return ValidationPartResult{
		PartName:     partName,
		Valid:        true,
		ErrorMessage: "",
	}
}

// insertValidationResult inserts a validation result into the database
func (w *ValidationWorker) insertValidationResult(ctx context.Context, validationID string, result ValidationPartResult) error {
	_, err := w.dbPool.Exec(ctx, `
		INSERT INTO metadata.template_part_validation_results (validation_id, part_name, valid, error_message)
		VALUES ($1, $2, $3, $4)
	`, validationID, result.PartName, result.Valid, result.ErrorMessage)

	return err
}

// markValidationCompleted marks the validation request as completed
func (w *ValidationWorker) markValidationCompleted(ctx context.Context, validationID string) error {
	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.template_validation_results
		SET status = 'completed',
		    completed_at = NOW()
		WHERE id = $1
	`, validationID)

	return err
}
