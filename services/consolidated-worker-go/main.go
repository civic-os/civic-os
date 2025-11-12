package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/h2non/bimg"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func main() {
	log.Println("========================================")
	log.Println("  Civic OS - Consolidated Worker")
	log.Println("  Version: 0.11.0")
	log.Println("========================================")
	log.Println("  Combines:")
	log.Println("    - S3 Signer")
	log.Println("    - Thumbnail Worker")
	log.Println("    - Notification Worker")
	log.Println("========================================")

	ctx := context.Background()

	// ===========================================================================
	// 1. Load Configuration from Environment
	// ===========================================================================
	databaseURL := getEnv("DATABASE_URL", "postgres://authenticator:password@localhost:5432/civic_os")

	// S3 Configuration (for s3-signer and thumbnail-worker)
	s3Bucket := getEnv("S3_BUCKET", "civic-os-files")

	// Thumbnail Worker Configuration
	thumbnailMaxWorkers := getEnvInt("THUMBNAIL_MAX_WORKERS", 3)

	// Notification Worker Configuration
	siteURL := getEnv("SITE_URL", "http://localhost:4200")
	notificationTimezone := getEnv("NOTIFICATION_TIMEZONE", "America/New_York")

	// SMTP Configuration
	smtpHost := getEnv("SMTP_HOST", "email-smtp.us-east-1.amazonaws.com")
	smtpPort := getEnv("SMTP_PORT", "587")
	smtpUsername := getEnv("SMTP_USERNAME", "")
	smtpPassword := getEnv("SMTP_PASSWORD", "")
	smtpFrom := getEnv("SMTP_FROM", "noreply@civic-os.org")

	// Connection Pool Configuration (CRITICAL for connection reduction)
	dbMaxConns := getEnvInt("DB_MAX_CONNS", 4)
	dbMinConns := getEnvInt("DB_MIN_CONNS", 1)

	log.Printf("[Init] Configuration loaded:")
	log.Printf("[Init]   Database: %s", maskPassword(databaseURL))
	log.Printf("[Init]   S3 Bucket: %s", s3Bucket)
	log.Printf("[Init]   Thumbnail Max Workers: %d", thumbnailMaxWorkers)
	log.Printf("[Init]   Site URL: %s", siteURL)
	log.Printf("[Init]   Notification Timezone: %s", notificationTimezone)
	log.Printf("[Init]   SMTP Host: %s:%s", smtpHost, smtpPort)
	log.Printf("[Init]   SMTP From: %s", smtpFrom)
	log.Printf("[Init]   SMTP Auth: %v", smtpUsername != "")
	log.Printf("[Init]   DB Max Connections: %d", dbMaxConns)
	log.Printf("[Init]   DB Min Connections: %d", dbMinConns)

	// Load timezone for notification worker
	timezone, err := time.LoadLocation(notificationTimezone)
	if err != nil {
		log.Fatalf("[Init] Invalid timezone '%s': %v", notificationTimezone, err)
	}

	// ===========================================================================
	// 2. Initialize PostgreSQL Connection Pool (SINGLE POOL FOR ALL WORKERS)
	// ===========================================================================
	log.Println("[Init] Configuring PostgreSQL connection pool...")

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		log.Fatalf("[Init] Failed to parse database URL: %v", err)
	}

	// CRITICAL: Explicit connection pool limits to reduce connections
	// Default pgxpool.New() would use 4 * runtime.NumCPU() = ~16 connections
	// With explicit limits, we use only 4 connections for ALL three workers
	poolConfig.MaxConns = int32(dbMaxConns)
	poolConfig.MinConns = int32(dbMinConns)
	poolConfig.MaxConnLifetime = 1 * time.Hour
	poolConfig.MaxConnIdleTime = 5 * time.Minute
	poolConfig.HealthCheckPeriod = 1 * time.Minute

	dbPool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		log.Fatalf("[Init] Failed to create database pool: %v", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(ctx); err != nil {
		log.Fatalf("[Init] Failed to ping database: %v", err)
	}
	log.Printf("[Init] ✓ Database connection pool established (max: %d, min: %d)", dbMaxConns, dbMinConns)

	// ===========================================================================
	// 3. Initialize S3 Clients (for S3 Signer and Thumbnail Worker)
	// ===========================================================================
	log.Println("[Init] Initializing S3 clients...")
	s3Clients := initializeS3Client(ctx)
	log.Println("[Init] ✓ S3 clients initialized")

	// ===========================================================================
	// 4. Verify Dependencies (Thumbnail Worker)
	// ===========================================================================
	log.Println("[Init] Checking dependencies...")

	// Check for pdftoppm (required for PDF thumbnail processing)
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		log.Fatal("[Init] pdftoppm not found - please install poppler-utils")
	}
	log.Println("[Init] ✓ pdftoppm found")

	// Check bimg/libvips (image processing library)
	log.Printf("[Init] ✓ bimg version: %s, libvips version: %s", bimg.Version, bimg.VipsVersion)

	// ===========================================================================
	// 5. Initialize Notification Worker Components
	// ===========================================================================
	log.Println("[Init] Initializing notification components...")

	// SMTP Configuration
	smtpConfig := &SMTPConfig{
		Host:     smtpHost,
		Port:     smtpPort,
		Username: smtpUsername,
		Password: smtpPassword,
		From:     smtpFrom,
	}
	log.Println("[Init] ✓ SMTP configuration loaded")

	// Template Renderer
	renderer := NewRenderer(siteURL, timezone)
	log.Println("[Init] ✓ Template renderer initialized")

	// ===========================================================================
	// 6. Register All River Workers
	// ===========================================================================
	log.Println("[Init] Registering River workers...")
	workers := river.NewWorkers()

	// S3 Presign Worker (s3_signer queue)
	river.AddWorker(workers, &S3PresignWorker{
		s3Client:        s3Clients.S3Client,
		s3PresignClient: s3Clients.S3PresignClient,
		dbPool:          dbPool,
	})
	log.Println("[Init] ✓ S3PresignWorker registered (queue: s3_signer)")

	// Thumbnail Worker (thumbnails queue)
	river.AddWorker(workers, &ThumbnailWorker{
		s3Client: s3Clients.S3Client,
		dbPool:   dbPool,
	})
	log.Println("[Init] ✓ ThumbnailWorker registered (queue: thumbnails)")

	// Notification Worker (notifications queue, priority 1)
	river.AddWorker(workers, &NotificationWorker{
		dbPool:     dbPool,
		renderer:   renderer,
		smtpConfig: smtpConfig,
	})
	log.Println("[Init] ✓ NotificationWorker registered (queue: notifications, priority 1)")

	// Validation Worker (notifications queue, priority 4)
	river.AddWorker(workers, &ValidationWorker{
		dbPool:   dbPool,
		renderer: renderer,
	})
	log.Println("[Init] ✓ ValidationWorker registered (queue: notifications, priority 4)")

	// Preview Worker (notifications queue, priority 4)
	river.AddWorker(workers, &PreviewWorker{
		dbPool:   dbPool,
		renderer: renderer,
		siteURL:  siteURL,
	})
	log.Println("[Init] ✓ PreviewWorker registered (queue: notifications, priority 4)")

	// ===========================================================================
	// 7. Create River Client (SINGLE CLIENT WITH MULTIPLE QUEUES)
	// ===========================================================================
	log.Println("[Init] Starting River client...")
	riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
		Queues: map[string]river.QueueConfig{
			"s3_signer":     {MaxWorkers: 20}, // I/O-bound, many workers
			"thumbnails":    {MaxWorkers: thumbnailMaxWorkers}, // CPU-bound, configurable
			"notifications": {MaxWorkers: 30}, // I/O-bound (SMTP), many workers
		},
		Workers: workers,
		Logger:  slog.Default(),
		Schema:  "metadata", // River tables in metadata schema
	})
	if err != nil {
		log.Fatalf("[Init] Failed to create River client: %v", err)
	}

	// ===========================================================================
	// 8. Start River Client
	// ===========================================================================
	if err := riverClient.Start(ctx); err != nil {
		log.Fatalf("[Init] Failed to start River client: %v", err)
	}
	log.Println("[Init] ✓ River client started")

	log.Println("")
	log.Println("========================================")
	log.Println("🚀 Consolidated Worker is running!")
	log.Println("========================================")
	log.Println("")
	log.Println("Registered job kinds:")
	log.Println("  - s3_presign (queue: s3_signer, 20 workers)")
	log.Println("  - thumbnail_generate (queue: thumbnails,", thumbnailMaxWorkers, "workers)")
	log.Println("  - send_notification (queue: notifications, 30 workers)")
	log.Println("  - validate_template_parts (queue: notifications)")
	log.Println("  - preview_template_parts (queue: notifications)")
	log.Println("")
	log.Printf("Database connections: %d max, %d min", dbMaxConns, dbMinConns)
	log.Println("Press Ctrl+C to shutdown gracefully...")
	log.Println("========================================")

	// ===========================================================================
	// 9. Graceful Shutdown
	// ===========================================================================
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("")
	log.Println("[Shutdown] Signal received, stopping gracefully...")

	// Use 30 second timeout (thumbnail jobs can be slow)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := riverClient.Stop(shutdownCtx); err != nil {
		log.Printf("[Shutdown] Error stopping River client: %v", err)
	}

	log.Println("[Shutdown] ✓ River client stopped")
	log.Println("[Shutdown] ✓ Shutdown complete")
}

// ============================================================================
// Utilities
// ============================================================================

// getEnv retrieves environment variable or returns default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
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
	// Simple masking for logging (e.g., postgres://user:****@host:port/db)
	return dbURL // Implement proper masking as needed
}
