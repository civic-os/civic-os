package main

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// ============================================================================
// Job Definition: S3 Presign
// ============================================================================

// S3PresignArgs defines the arguments for generating presigned S3 URLs
type S3PresignArgs struct {
	RequestID  string `json:"request_id"`
	FileName   string `json:"file_name"`
	FileType   string `json:"file_type"`
	EntityType string `json:"entity_type"`
	EntityID   string `json:"entity_id"`
}

// Kind returns the job type identifier for River routing
func (S3PresignArgs) Kind() string {
	return "s3_presign"
}

// InsertOpts specifies River job insertion options
func (S3PresignArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "s3_signer",
		MaxAttempts: 25,
		Priority:    1,
	}
}

// ============================================================================
// Worker Implementation: S3 Presign Worker
// ============================================================================

// S3PresignWorker implements River's Worker interface for presigning S3 URLs
type S3PresignWorker struct {
	river.WorkerDefaults[S3PresignArgs]
	s3Client        *s3.Client
	s3PresignClient *s3.PresignClient
	dbPool          *pgxpool.Pool
}

// Work executes the S3 presigning job
func (w *S3PresignWorker) Work(ctx context.Context, job *river.Job[S3PresignArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting S3 presign job (attempt %d/%d)", job.ID, job.Attempt, job.MaxAttempts)
	log.Printf("[Job %d] Request: entity=%s/%s, file=%s", job.ID, job.Args.EntityType, job.Args.EntityID, job.Args.FileName)

	// Generate file ID and build S3 key
	fileID, err := w.generateFileID(ctx)
	if err != nil {
		log.Printf("[Job %d] Error generating file ID: %v", job.ID, err)
		return fmt.Errorf("failed to generate file ID: %w", err)
	}

	// Extract file extension from file_name
	fileExt := filepath.Ext(job.Args.FileName)
	if fileExt == "" {
		fileExt = ".bin" // Fallback for files without extension
	}

	// Build S3 key: {entity_type}/{entity_id}/{file_id}/original.{ext}
	bucket := getEnv("S3_BUCKET", "civic-os-files")
	s3Key := fmt.Sprintf("%s/%s/%s/original%s", job.Args.EntityType, job.Args.EntityID, fileID, fileExt)

	// Generate presigned upload URL
	presignedURL, err := w.generateUploadURL(ctx, bucket, s3Key)
	if err != nil {
		log.Printf("[Job %d] Error generating presigned URL: %v", job.ID, err)
		return fmt.Errorf("failed to generate presigned URL: %w", err)
	}

	// Update database with presigned URL, file_id, s3_key, and status
	query := `
		UPDATE metadata.file_upload_requests
		SET presigned_url = $1,
		    file_id = $2,
		    s3_key = $3,
		    status = 'completed'
		WHERE id = $4
	`

	_, err = w.dbPool.Exec(ctx, query, presignedURL, fileID, s3Key, job.Args.RequestID)
	if err != nil {
		log.Printf("[Job %d] Error updating database: %v", job.ID, err)
		return fmt.Errorf("failed to update database: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] ✓ Completed successfully in %v (file_id=%s, key=%s)", job.ID, duration, fileID, s3Key)

	return nil
}

// generateFileID creates a new UUID v7 for the file
func (w *S3PresignWorker) generateFileID(ctx context.Context) (string, error) {
	var fileID string
	err := w.dbPool.QueryRow(ctx, "SELECT uuid_generate_v7()::text").Scan(&fileID)
	if err != nil {
		return "", fmt.Errorf("failed to generate file ID: %w", err)
	}
	return fileID, nil
}

// generateUploadURL creates a presigned URL for uploading files to S3
func (w *S3PresignWorker) generateUploadURL(ctx context.Context, bucket, key string) (string, error) {
	// Create presigned PUT request for upload (15 minutes expiry)
	presignResult, err := w.s3PresignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(15*time.Minute))

	if err != nil {
		return "", fmt.Errorf("failed to presign PUT object: %w", err)
	}

	return presignResult.URL, nil
}
