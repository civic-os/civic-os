package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
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
	bucket := "civic-os-files" // TODO: Make configurable via env var
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

// ============================================================================
// Main Service
// ============================================================================

func main() {
	log.Println("========================================")
	log.Println("Civic OS - S3 Signer Service (Go+River)")
	log.Println("========================================")

	ctx := context.Background()

	// Get configuration from environment variables
	databaseURL := getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/civic_os")

	// S3 configuration with dual support (generic S3_* names take priority)
	s3AccessKey := getS3Env("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "")
	s3SecretKey := getS3Env("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "")
	s3Region := getS3Env("S3_REGION", "AWS_REGION", "us-east-1")
	s3Endpoint := getS3Env("S3_ENDPOINT", "AWS_ENDPOINT_URL", "")
	publicEndpoint := getEnv("S3_PUBLIC_ENDPOINT", "")

	log.Printf("Database URL: %s", maskPassword(databaseURL))
	log.Printf("S3 Region: %s", s3Region)
	if s3Endpoint != "" {
		log.Printf("S3 Endpoint: %s", s3Endpoint)
	}
	if publicEndpoint != "" {
		log.Printf("S3 Public Endpoint: %s", publicEndpoint)
	}

	// Initialize AWS S3 client with explicit credentials
	log.Println("\n[Init] Loading AWS SDK configuration...")
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

	// For presigning, use public endpoint if configured (for local MinIO/Docker)
	var s3PresignClient *s3.PresignClient
	if publicEndpoint != "" {
		// Create separate config with public endpoint for presigned URLs
		publicCfg, err := config.LoadDefaultConfig(ctx,
			config.WithRegion(s3Region),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				s3AccessKey,
				s3SecretKey,
				"",
			)),
		)
		if err != nil {
			log.Fatalf("Failed to load AWS SDK configuration for presigning: %v", err)
		}

		publicS3Client := s3.NewFromConfig(publicCfg, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(publicEndpoint)
			o.UsePathStyle = true // Required for MinIO path-style URLs
		})
		s3PresignClient = s3.NewPresignClient(publicS3Client)
		log.Printf("[Init] ✓ S3 client initialized with public endpoint for presigning")
	} else {
		s3PresignClient = s3.NewPresignClient(s3Client)
		log.Println("[Init] ✓ S3 client initialized")
	}

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
	river.AddWorker(workers, &S3PresignWorker{
		s3Client:        s3Client,
		s3PresignClient: s3PresignClient,
		dbPool:          dbPool,
	})
	log.Println("[Init] ✓ S3PresignWorker registered")

	// Initialize River client
	log.Println("[Init] Starting River client...")
	riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
		Queues: map[string]river.QueueConfig{
			"s3_signer": {MaxWorkers: 50}, // I/O-bound, many workers
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
	log.Println("\n========================================")
	log.Println("🚀 S3 Signer service is running!")
	log.Println("========================================")
	log.Println("Listening to queue: s3_signer")
	log.Println("Max workers: 50")
	log.Println("Press Ctrl+C to gracefully shutdown")
	log.Println("========================================")

	// Wait for interrupt signal for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("\n[Shutdown] Received interrupt signal, shutting down gracefully...")

	// Graceful shutdown with 10 second timeout
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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

// maskPassword masks the password in a database URL for logging
func maskPassword(dbURL string) string {
	// Simple masking for logging (e.g., postgres://user:****@host:port/db)
	// You can use a more sophisticated URL parser if needed
	return dbURL // For now, return as-is; implement proper masking as needed
}
