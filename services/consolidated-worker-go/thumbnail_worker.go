package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/h2non/bimg"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// ============================================================================
// Job Definition: Thumbnail Generation
// ============================================================================

// ThumbnailArgs defines the arguments for generating thumbnails
// Only contains file_id; worker queries metadata.files for all file metadata
type ThumbnailArgs struct {
	FileID string `json:"file_id"`
}

// Kind returns the job type identifier for River routing
func (ThumbnailArgs) Kind() string {
	return "thumbnail_generate"
}

// InsertOpts specifies River job insertion options
func (ThumbnailArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       "thumbnails",
		MaxAttempts: 25,
		Priority:    1,
	}
}

// ============================================================================
// Thumbnail Configuration
// ============================================================================

// ThumbnailSize defines a thumbnail size configuration
type ThumbnailSize struct {
	Name    string // "small", "medium", "large"
	Width   int
	Height  int
	Quality int
}

var thumbnailSizes = []ThumbnailSize{
	{Name: "small", Width: 150, Height: 150, Quality: 80},
	{Name: "medium", Width: 400, Height: 400, Quality: 85},
	{Name: "large", Width: 800, Height: 800, Quality: 90},
}

// ============================================================================
// Worker Implementation: Thumbnail Worker
// ============================================================================

// ThumbnailWorker implements River's Worker interface for thumbnail generation
type ThumbnailWorker struct {
	river.WorkerDefaults[ThumbnailArgs]
	s3Client *s3.Client
	dbPool   *pgxpool.Pool
}

// Work executes the thumbnail generation job
func (w *ThumbnailWorker) Work(ctx context.Context, job *river.Job[ThumbnailArgs]) error {
	startTime := time.Now()
	log.Printf("[Job %d] Starting thumbnail generation job (attempt %d/%d)", job.ID, job.Attempt, job.MaxAttempts)

	// Query database for file metadata (single source of truth)
	var bucket, s3Key, fileType string
	query := `SELECT s3_bucket, s3_original_key, file_type FROM metadata.files WHERE id = $1`
	err := w.dbPool.QueryRow(ctx, query, job.Args.FileID).Scan(&bucket, &s3Key, &fileType)
	if err != nil {
		log.Printf("[Job %d] Error querying file metadata: %v", job.ID, err)
		return fmt.Errorf("failed to query file metadata from database: %w", err)
	}
	log.Printf("[Job %d] File: %s (type: %s, bucket: %s)", job.ID, s3Key, fileType, bucket)

	// Download original file from S3
	log.Printf("[Job %d] Downloading original from S3...", job.ID)
	fileData, err := w.downloadFromS3(ctx, bucket, s3Key)
	if err != nil {
		log.Printf("[Job %d] Error downloading file: %v", job.ID, err)
		return fmt.Errorf("failed to download file from S3: %w", err)
	}
	log.Printf("[Job %d] ✓ Downloaded %d bytes", job.ID, len(fileData))

	// Generate thumbnails based on file type
	var thumbnailKeys map[string]string
	if fileType == "pdf" {
		thumbnailKeys, err = w.generatePDFThumbnails(ctx, job.ID, fileData, s3Key, bucket)
	} else {
		thumbnailKeys, err = w.generateImageThumbnails(ctx, job.ID, fileData, s3Key, bucket)
	}

	if err != nil {
		log.Printf("[Job %d] Error generating thumbnails: %v", job.ID, err)
		// Update database with error status
		w.updateThumbnailStatus(ctx, job.Args.FileID, "error", nil)
		return fmt.Errorf("failed to generate thumbnails: %w", err)
	}

	// Update database with thumbnail keys and completed status
	err = w.updateThumbnailStatus(ctx, job.Args.FileID, "completed", thumbnailKeys)
	if err != nil {
		log.Printf("[Job %d] Error updating database: %v", job.ID, err)
		return fmt.Errorf("failed to update database: %w", err)
	}

	duration := time.Since(startTime)
	log.Printf("[Job %d] ✓ Completed successfully in %v", job.ID, duration)

	return nil
}

// generateImageThumbnails creates thumbnails for image files using bimg (libvips)
func (w *ThumbnailWorker) generateImageThumbnails(ctx context.Context, jobID int64, imageData []byte, originalKey, bucket string) (map[string]string, error) {
	thumbnailKeys := make(map[string]string)
	basePath := filepath.Dir(originalKey)

	for _, size := range thumbnailSizes {
		log.Printf("[Job %d] Generating %s thumbnail (%dx%d)...", jobID, size.Name, size.Width, size.Height)

		// Generate thumbnail with proper centering and background handling
		options := bimg.Options{
			Width:      size.Width,
			Height:     size.Height,
			Embed:      true,                               // Maintain aspect ratio, center within dimensions
			Gravity:    bimg.GravityCentre,                 // Center the image
			Background: bimg.Color{R: 255, G: 255, B: 255}, // White background for transparent areas
			Type:       bimg.JPEG,
			Quality:    size.Quality,
		}

		thumbnail, err := bimg.NewImage(imageData).Process(options)
		if err != nil {
			return nil, fmt.Errorf("failed to generate %s thumbnail: %w", size.Name, err)
		}

		// Upload to S3
		// Expected format: {entity_type}/{entity_id}/{file_id}/thumb-{size}.jpg
		thumbnailKey := fmt.Sprintf("%s/thumb-%s.jpg", basePath, size.Name)
		err = w.uploadToS3(ctx, bucket, thumbnailKey, thumbnail)
		if err != nil {
			return nil, fmt.Errorf("failed to upload %s thumbnail: %w", size.Name, err)
		}

		thumbnailKeys[fmt.Sprintf("thumbnail_%s_key", size.Name)] = thumbnailKey
		log.Printf("[Job %d] ✓ %s thumbnail uploaded: %s", jobID, size.Name, thumbnailKey)
	}

	return thumbnailKeys, nil
}

// generatePDFThumbnails creates thumbnails for PDF files (first page only)
func (w *ThumbnailWorker) generatePDFThumbnails(ctx context.Context, jobID int64, pdfData []byte, originalKey, bucket string) (map[string]string, error) {
	log.Printf("[Job %d] Converting PDF first page to image...", jobID)

	// Write PDF to temp file
	tempPDF, err := os.CreateTemp("", "pdf-*.pdf")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp PDF file: %w", err)
	}
	defer os.Remove(tempPDF.Name())
	defer tempPDF.Close()

	if _, err := tempPDF.Write(pdfData); err != nil {
		return nil, fmt.Errorf("failed to write temp PDF: %w", err)
	}
	tempPDF.Close()

	// Use pdftoppm to convert first page to PPM image
	tempImage := tempPDF.Name() + ".ppm"
	defer os.Remove(tempImage)

	cmd := exec.Command("pdftoppm", "-f", "1", "-l", "1", "-singlefile", "-r", "300", tempPDF.Name(), tempPDF.Name())
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to run pdftoppm: %w", err)
	}

	// Read the converted image
	imageData, err := os.ReadFile(tempImage)
	if err != nil {
		return nil, fmt.Errorf("failed to read converted image: %w", err)
	}

	log.Printf("[Job %d] ✓ PDF converted to image (%d bytes)", jobID, len(imageData))

	// Generate thumbnails from the converted image (same as image thumbnails)
	return w.generateImageThumbnails(ctx, jobID, imageData, originalKey, bucket)
}

// downloadFromS3 retrieves a file from S3
func (w *ThumbnailWorker) downloadFromS3(ctx context.Context, bucket, key string) ([]byte, error) {
	result, err := w.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get object from S3: %w", err)
	}
	defer result.Body.Close()

	data, err := io.ReadAll(result.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read S3 object body: %w", err)
	}

	return data, nil
}

// uploadToS3 uploads data to S3
func (w *ThumbnailWorker) uploadToS3(ctx context.Context, bucket, key string, data []byte) error {
	_, err := w.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("image/jpeg"),
	})
	return err
}

// updateThumbnailStatus updates the database with thumbnail keys and status
func (w *ThumbnailWorker) updateThumbnailStatus(ctx context.Context, fileID, status string, thumbnailKeys map[string]string) error {
	var smallKey, mediumKey, largeKey *string

	if thumbnailKeys != nil {
		if key, ok := thumbnailKeys["thumbnail_small_key"]; ok {
			smallKey = &key
		}
		if key, ok := thumbnailKeys["thumbnail_medium_key"]; ok {
			mediumKey = &key
		}
		if key, ok := thumbnailKeys["thumbnail_large_key"]; ok {
			largeKey = &key
		}
	}

	query := `
		UPDATE metadata.files
		SET thumbnail_status = $1,
		    s3_thumbnail_small_key = $2,
		    s3_thumbnail_medium_key = $3,
		    s3_thumbnail_large_key = $4,
		    updated_at = NOW()
		WHERE id = $5
	`

	_, err := w.dbPool.Exec(ctx, query, status, smallKey, mediumKey, largeKey, fileID)
	return err
}
