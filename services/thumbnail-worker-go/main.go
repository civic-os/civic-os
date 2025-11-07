package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/h2non/bimg"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
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

// ============================================================================
// Main Service
// ============================================================================

func main() {
	log.Println("=============================================")
	log.Println("Civic OS - Thumbnail Worker (Go+River+bimg)")
	log.Println("=============================================")

	ctx := context.Background()

	// Get configuration from environment variables
	databaseURL := getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/civic_os")

	// S3 configuration with dual support (generic S3_* names take priority)
	s3AccessKey := getS3Env("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "")
	s3SecretKey := getS3Env("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "")
	s3Region := getS3Env("S3_REGION", "AWS_REGION", "us-east-1")
	s3Endpoint := getS3Env("S3_ENDPOINT", "AWS_ENDPOINT_URL", "")

	// Worker concurrency configuration
	maxWorkers := getEnvInt("THUMBNAIL_MAX_WORKERS", 5)

	log.Printf("Database URL: %s", maskPassword(databaseURL))
	log.Printf("S3 Region: %s", s3Region)
	if s3Endpoint != "" {
		log.Printf("S3 Endpoint: %s", s3Endpoint)
	}
	log.Printf("Max workers: %d", maxWorkers)

	// Check for pdftoppm (required for PDF processing)
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		log.Fatal("pdftoppm not found - please install poppler-utils")
	}
	log.Println("[Init] ✓ pdftoppm found")

	// Check bimg/libvips
	log.Printf("[Init] bimg version: %s, libvips version: %s", bimg.Version, bimg.VipsVersion)

	// Initialize AWS S3 client with explicit credentials
	log.Println("[Init] Loading AWS SDK configuration...")
	awsCfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			s3AccessKey,
			s3SecretKey,
			"", // session token (not used)
		)),
	)
	if err != nil {
		log.Fatalf("Failed to load AWS SDK configuration: %v", err)
	}

	// Configure S3 client with custom endpoint (if provided) and path-style URLs
	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if s3Endpoint != "" {
			o.BaseEndpoint = aws.String(s3Endpoint)
		}
		o.UsePathStyle = true // Required for MinIO and DigitalOcean Spaces
	})
	log.Println("[Init] ✓ S3 client initialized")

	// Initialize PostgreSQL connection pool
	log.Println("[Init] Connecting to PostgreSQL...")
	dbPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("Failed to create database pool: %v", err)
	}
	defer dbPool.Close()

	// Test database connection
	if err := dbPool.Ping(ctx); err != nil {
		log.Fatalf("Failed to ping database: %v", err)
	}
	log.Println("[Init] ✓ Database connection established")

	// Initialize River workers
	log.Println("[Init] Registering River workers...")
	workers := river.NewWorkers()
	river.AddWorker(workers, &ThumbnailWorker{
		s3Client: s3Client,
		dbPool:   dbPool,
	})
	log.Println("[Init] ✓ ThumbnailWorker registered")

	// Initialize River client
	log.Println("[Init] Starting River client...")
	riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
		Queues: map[string]river.QueueConfig{
			"thumbnails": {MaxWorkers: maxWorkers}, // Configurable via THUMBNAIL_MAX_WORKERS
		},
		Workers: workers,
		Logger:  slog.Default(),
		Schema:  "metadata", // River tables are in metadata schema
	})
	if err != nil {
		log.Fatalf("Failed to create River client: %v", err)
	}

	// Start River client
	if err := riverClient.Start(ctx); err != nil {
		log.Fatalf("Failed to start River client: %v", err)
	}
	log.Println("[Init] ✓ River client started")
	log.Println("\n=============================================")
	log.Println("🚀 Thumbnail Worker is running!")
	log.Println("=============================================")
	log.Println("Listening to queue: thumbnails")
	log.Printf("Max workers: %d (tune via THUMBNAIL_MAX_WORKERS env var)", maxWorkers)
	log.Println("Thumbnail sizes: small (150x150), medium (400x400), large (800x800)")
	log.Println("Press Ctrl+C to gracefully shutdown")
	log.Println("=============================================")

	// Wait for interrupt signal for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("\n[Shutdown] Received interrupt signal, shutting down gracefully...")

	// Graceful shutdown with 30 second timeout (thumbnail jobs can be slow)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := riverClient.Stop(shutdownCtx); err != nil {
		log.Printf("[Shutdown] Warning: River client shutdown error: %v", err)
	}

	log.Println("[Shutdown] ✓ Shutdown complete")
}

// ============================================================================
// Utilities
// ============================================================================

// getEnv retrieves environment variable with fallback to default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getS3Env retrieves S3-related environment variable with dual support for generic and AWS-specific names.
// Priority: Generic S3_* names first, fallback to AWS_* names with deprecation warning.
// This maintains backward compatibility while migrating to vendor-neutral naming.
func getS3Env(genericKey, awsKey, defaultValue string) string {
	// Try generic S3_* name first (preferred)
	if value := os.Getenv(genericKey); value != "" {
		return value
	}

	// Fallback to AWS-specific name (deprecated)
	if value := os.Getenv(awsKey); value != "" {
		log.Printf("⚠️  WARNING: %s is deprecated, use %s instead (AWS-specific naming will be removed in v1.0.0)", awsKey, genericKey)
		return value
	}

	return defaultValue
}

// getEnvInt retrieves environment variable as integer with fallback to default value
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
		log.Printf("⚠️  WARNING: Invalid integer value for %s: %s, using default: %d", key, value, defaultValue)
	}
	return defaultValue
}

// maskPassword masks the password in a database URL for logging
func maskPassword(dbURL string) string {
	return dbURL // Implement proper masking as needed
}
