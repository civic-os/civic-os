package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// PreviewArgs defines the preview job arguments
type PreviewArgs struct {
	ValidationID     string          `json:"validation_id"`
	SubjectTemplate  string          `json:"subject_template"`
	HTMLTemplate     string          `json:"html_template"`
	TextTemplate     string          `json:"text_template"`
	SMSTemplate      string          `json:"sms_template"`
	SampleEntityData json.RawMessage `json:"sample_entity_data"`
}

// Kind returns the job type identifier
func (PreviewArgs) Kind() string { return "preview_template_parts" }

// InsertOpts returns job insertion options
func (PreviewArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "notifications",
		MaxAttempts: 3,
		Priority:    100, // HIGH PRIORITY (vs 1 for notifications)
	}
}

// PreviewWorker renders template parts with sample data
type PreviewWorker struct {
	river.WorkerDefaults[PreviewArgs]
	dbPool   *pgxpool.Pool
	renderer *Renderer
	siteURL  string
}

// Work executes the preview job
func (w *PreviewWorker) Work(ctx context.Context, job *river.Job[PreviewArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting preview job (attempt %d/%d): validation_id=%s",
		job.ID, job.Attempt, job.MaxAttempts, job.Args.ValidationID)

	// Validate sample entity data is valid JSON
	var entityData map[string]interface{}
	if err := json.Unmarshal(job.Args.SampleEntityData, &entityData); err != nil {
		log.Printf("[Job %d] Invalid sample entity data: %v", job.ID, err)
		return fmt.Errorf("invalid sample entity data: %w", err)
	}

	// Preview each non-empty template part
	results := []PreviewPartResult{}

	if job.Args.SubjectTemplate != "" {
		result := w.previewPart("subject", job.Args.SubjectTemplate, false, job.Args.SampleEntityData)
		results = append(results, result)
	}

	if job.Args.HTMLTemplate != "" {
		result := w.previewPart("html", job.Args.HTMLTemplate, true, job.Args.SampleEntityData)
		results = append(results, result)
	}

	if job.Args.TextTemplate != "" {
		result := w.previewPart("text", job.Args.TextTemplate, false, job.Args.SampleEntityData)
		results = append(results, result)
	}

	if job.Args.SMSTemplate != "" {
		result := w.previewPart("sms", job.Args.SMSTemplate, false, job.Args.SampleEntityData)
		results = append(results, result)
	}

	// Insert results into database
	for _, result := range results {
		err := w.insertPreviewResult(ctx, job.Args.ValidationID, result)
		if err != nil {
			log.Printf("[Job %d] Failed to insert preview result: %v", job.ID, err)
			return fmt.Errorf("failed to insert preview result: %w", err)
		}
	}

	// Mark validation as completed
	err := w.markValidationCompleted(ctx, job.Args.ValidationID)
	if err != nil {
		log.Printf("[Job %d] Failed to mark validation completed: %v", job.ID, err)
		return fmt.Errorf("failed to mark validation completed: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] ✓ Preview completed in %v (rendered %d parts)", job.ID, duration, len(results))

	return nil
}

// PreviewPartResult holds the result of previewing a single template part
type PreviewPartResult struct {
	PartName       string
	Valid          bool
	RenderedOutput string // If valid, contains rendered template
	ErrorMessage   string // If invalid, contains error message
}

// previewPart validates and renders a single template part with sample data
func (w *PreviewWorker) previewPart(partName, template string, isHTML bool, sampleEntityData json.RawMessage) PreviewPartResult {
	// Step 1: Validate template syntax
	err := w.renderer.ValidateTemplate(template, isHTML)
	if err != nil {
		return PreviewPartResult{
			PartName:       partName,
			Valid:          false,
			RenderedOutput: "",
			ErrorMessage:   err.Error(),
		}
	}

	// Step 2: Render template with sample data
	rendered, err := w.renderer.RenderTemplatePart(template, isHTML, sampleEntityData)
	if err != nil {
		return PreviewPartResult{
			PartName:       partName,
			Valid:          false,
			RenderedOutput: "",
			ErrorMessage:   fmt.Sprintf("Rendering error: %v", err),
		}
	}

	return PreviewPartResult{
		PartName:       partName,
		Valid:          true,
		RenderedOutput: rendered,
		ErrorMessage:   "",
	}
}

// insertPreviewResult inserts a preview result into the database
// Note: We reuse error_message field to store rendered output for valid templates
func (w *PreviewWorker) insertPreviewResult(ctx context.Context, validationID string, result PreviewPartResult) error {
	var errorMessage string
	if result.Valid {
		// Store rendered output in error_message field for valid templates
		errorMessage = result.RenderedOutput
	} else {
		// Store error message for invalid templates
		errorMessage = result.ErrorMessage
	}

	_, err := w.dbPool.Exec(ctx, `
		INSERT INTO metadata.template_part_validation_results (validation_id, part_name, valid, error_message)
		VALUES ($1, $2, $3, $4)
	`, validationID, result.PartName, result.Valid, errorMessage)

	return err
}

// markValidationCompleted marks the validation request as completed
func (w *PreviewWorker) markValidationCompleted(ctx context.Context, validationID string) error {
	_, err := w.dbPool.Exec(ctx, `
		UPDATE metadata.template_validation_results
		SET status = 'completed',
		    completed_at = NOW()
		WHERE id = $1
	`, validationID)

	return err
}
