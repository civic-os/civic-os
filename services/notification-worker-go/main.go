package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func main() {
	log.Println("========================================")
	log.Println("  Civic OS Notification Worker")
	log.Println("  Version: 0.11.0")
	log.Println("========================================")

	ctx := context.Background()

	// ===========================================================================
	// 1. Load Configuration from Environment
	// ===========================================================================
	databaseURL := getEnv("DATABASE_URL", "postgres://authenticator:password@localhost:5432/civic_os")
	siteURL := getEnv("SITE_URL", "http://localhost:4200")
	notificationTimezone := getEnv("NOTIFICATION_TIMEZONE", "America/New_York")

	// SMTP Configuration
	smtpHost := getEnv("SMTP_HOST", "email-smtp.us-east-1.amazonaws.com")
	smtpPort := getEnv("SMTP_PORT", "587")
	smtpUsername := getEnv("SMTP_USERNAME", "")
	smtpPassword := getEnv("SMTP_PASSWORD", "")
	smtpFrom := getEnv("SMTP_FROM", "noreply@civic-os.org")

	// Load timezone
	timezone, err := time.LoadLocation(notificationTimezone)
	if err != nil {
		log.Fatalf("[Init] Invalid timezone '%s': %v", notificationTimezone, err)
	}

	log.Printf("[Init] Configuration loaded:")
	log.Printf("[Init]   Site URL: %s", siteURL)
	log.Printf("[Init]   Notification Timezone: %s", notificationTimezone)
	log.Printf("[Init]   SMTP Host: %s:%s", smtpHost, smtpPort)
	log.Printf("[Init]   SMTP From: %s", smtpFrom)
	log.Printf("[Init]   SMTP Auth: %v", smtpUsername != "")

	// ===========================================================================
	// 2. Connect to PostgreSQL
	// ===========================================================================
	dbPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("[Init] Failed to create database pool: %v", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(ctx); err != nil {
		log.Fatalf("[Init] Failed to ping database: %v", err)
	}
	log.Println("[Init] ✓ Database connection established")

	// ===========================================================================
	// 3. Create SMTP Configuration
	// ===========================================================================
	smtpConfig := &SMTPConfig{
		Host:     smtpHost,
		Port:     smtpPort,
		Username: smtpUsername,
		Password: smtpPassword,
		From:     smtpFrom,
	}
	log.Println("[Init] ✓ SMTP configuration loaded")

	// ===========================================================================
	// 4. Create Renderer
	// ===========================================================================
	renderer := NewRenderer(siteURL, timezone)
	log.Println("[Init] ✓ Template renderer initialized")

	// ===========================================================================
	// 5. Register River Workers
	// ===========================================================================
	workers := river.NewWorkers()

	// NotificationWorker: Sends notifications (priority 1)
	river.AddWorker(workers, &NotificationWorker{
		dbPool:     dbPool,
		renderer:   renderer,
		smtpConfig: smtpConfig,
	})
	log.Println("[Init] ✓ NotificationWorker registered (priority 1)")

	// ValidationWorker: Validates templates (priority 4)
	river.AddWorker(workers, &ValidationWorker{
		dbPool:   dbPool,
		renderer: renderer,
	})
	log.Println("[Init] ✓ ValidationWorker registered (priority 4)")

	// PreviewWorker: Renders templates with sample data (priority 4)
	river.AddWorker(workers, &PreviewWorker{
		dbPool:   dbPool,
		renderer: renderer,
		siteURL:  siteURL,
	})
	log.Println("[Init] ✓ PreviewWorker registered (priority 4)")

	// ===========================================================================
	// 6. Create River Client
	// ===========================================================================
	riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
		Queues: map[string]river.QueueConfig{
			"notifications": {MaxWorkers: 30}, // I/O-bound, SMTP connections
		},
		Workers: workers,
		Logger:  slog.Default(),
		Schema:  "metadata", // River tables in metadata schema
	})
	if err != nil {
		log.Fatalf("[Init] Failed to create River client: %v", err)
	}

	// ===========================================================================
	// 7. Start River Client
	// ===========================================================================
	if err := riverClient.Start(ctx); err != nil {
		log.Fatalf("[Init] Failed to start River client: %v", err)
	}
	log.Println("[Init] ✓ River client started")
	log.Println("[Init] ✓ Queue: notifications (30 workers)")
	log.Println("")
	log.Println("========================================")
	log.Println("🚀 Notification worker is running!")
	log.Println("========================================")
	log.Println("")
	log.Println("Registered job kinds:")
	log.Println("  - send_notification (priority 1)")
	log.Println("  - validate_template_parts (priority 4)")
	log.Println("  - preview_template_parts (priority 4)")
	log.Println("")
	log.Println("Press Ctrl+C to shutdown gracefully...")

	// ===========================================================================
	// 8. Graceful Shutdown
	// ===========================================================================
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("")
	log.Println("[Shutdown] Signal received, stopping gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := riverClient.Stop(shutdownCtx); err != nil {
		log.Printf("[Shutdown] Error stopping River client: %v", err)
	}

	log.Println("[Shutdown] ✓ River client stopped")
	log.Println("[Shutdown] ✓ Shutdown complete")
}

// getEnv retrieves environment variable or returns default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
