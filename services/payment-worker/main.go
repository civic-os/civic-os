package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

var (
	// version is set at compile time via -ldflags -X
	version = "dev"
)

func main() {
	log.Println("========================================")
	log.Println("  Civic OS - Payment Worker")
	log.Printf("  Version: %s", version)
	log.Println("========================================")
	log.Println("  POC: Stripe Payment Intent Creation")
	log.Println("========================================")

	ctx := context.Background()

	// ===========================================================================
	// 1. Load Configuration from Environment
	// ===========================================================================
	databaseURL := getEnv("DATABASE_URL", "postgres://authenticator:password@localhost:5432/civic_os")
	stripeAPIKey := getEnv("STRIPE_API_KEY", "")
	stripeWebhookSecret := getEnv("STRIPE_WEBHOOK_SECRET", "")
	currency := getEnv("PAYMENT_CURRENCY", "USD")
	workerCount := getEnvInt("RIVER_WORKER_COUNT", 1)
	webhookPort := getEnv("WEBHOOK_PORT", "8080")

	// Connection Pool Configuration
	dbMaxConns := getEnvInt("DB_MAX_CONNS", 4)
	dbMinConns := getEnvInt("DB_MIN_CONNS", 1)

	// Processing Fee Configuration
	feeEnabled := getEnvBool("PROCESSING_FEE_ENABLED", false)
	feePercent := getEnvFloat("PROCESSING_FEE_PERCENT", 0.0)
	feeFlatCents := getEnvInt("PROCESSING_FEE_FLAT_CENTS", 0)
	feeRefundable := getEnvBool("PROCESSING_FEE_REFUNDABLE", false)

	log.Printf("[Init] Configuration loaded:")
	log.Printf("[Init]   Database: %s", maskPassword(databaseURL))
	log.Printf("[Init]   Stripe API Key: %s", maskAPIKey(stripeAPIKey))
	log.Printf("[Init]   Stripe Webhook Secret: %s", maskAPIKey(stripeWebhookSecret))
	log.Printf("[Init]   Payment Currency: %s", currency)
	log.Printf("[Init]   River Worker Count: %d", workerCount)
	log.Printf("[Init]   Webhook HTTP Port: %s", webhookPort)
	log.Printf("[Init]   DB Max Connections: %d", dbMaxConns)
	log.Printf("[Init]   DB Min Connections: %d", dbMinConns)
	log.Printf("[Init]   Processing Fee Enabled: %v", feeEnabled)
	if feeEnabled {
		log.Printf("[Init]   Processing Fee: %.2f%% + %d cents", feePercent, feeFlatCents)
		log.Printf("[Init]   Processing Fee Refundable: %v", feeRefundable)
	}

	// Validate required configuration
	if stripeAPIKey == "" {
		log.Fatal("[Init] STRIPE_API_KEY environment variable is required")
	}
	if stripeWebhookSecret == "" {
		log.Fatal("[Init] STRIPE_WEBHOOK_SECRET environment variable is required")
	}

	// ===========================================================================
	// 2. Initialize PostgreSQL Connection Pool
	// ===========================================================================
	log.Println("[Init] Configuring PostgreSQL connection pool...")

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		log.Fatalf("[Init] Failed to parse database URL: %v", err)
	}

	// Set application name for PostgreSQL connection identification
	poolConfig.ConnConfig.RuntimeParams["application_name"] = "CivicOS-PaymentWorker " + version

	// Set search_path to find River tables in metadata schema
	poolConfig.ConnConfig.RuntimeParams["search_path"] = "metadata, public"

	// Configure connection pool limits
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
	// 3. Initialize Stripe Provider
	// ===========================================================================
	log.Println("[Init] Initializing Stripe provider...")
	stripeProvider := NewStripeProvider(stripeAPIKey)
	log.Println("[Init] ✓ Stripe provider initialized")

	// ===========================================================================
	// 4. Initialize River Client and Workers
	// ===========================================================================
	log.Println("[Init] Initializing River job queue...")

	workers := river.NewWorkers()

	// Create fee configuration for workers
	feeConfig := &FeeConfig{
		Enabled:    feeEnabled,
		Percent:    feePercent,
		FlatCents:  feeFlatCents,
		Refundable: feeRefundable,
	}

	// Register CreateIntentWorker (for async payment intent creation)
	createIntentWorker := NewCreateIntentWorker(dbPool, stripeProvider, feeConfig)
	river.AddWorker(workers, createIntentWorker)
	log.Println("[Init] ✓ Registered CreateIntentWorker")

	// Register RefundWorker (for async refund processing)
	refundWorker := NewRefundWorker(dbPool, stripeProvider)
	river.AddWorker(workers, refundWorker)
	log.Println("[Init] ✓ Registered RefundWorker")

	// Create River client
	riverClient, err := river.NewClient(riverpgxv5.New(dbPool), &river.Config{
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: workerCount},
		},
		Workers: workers,
	})
	if err != nil {
		log.Fatalf("[Init] Failed to create River client: %v", err)
	}
	defer riverClient.Stop(ctx)

	log.Printf("[Init] ✓ River client initialized (queue: default, workers: %d)", workerCount)

	// ===========================================================================
	// 4b. Initialize HTTP Webhook Server
	// ===========================================================================
	log.Println("[Init] Initializing HTTP webhook server...")

	webhookHandler := NewWebhookHandler(dbPool)
	webhookServer := NewWebhookHTTPServer(webhookHandler, stripeWebhookSecret, webhookPort)

	log.Println("[Init] ✓ Webhook server initialized")

	// ===========================================================================
	// 5. Start River Client and HTTP Server Concurrently
	// ===========================================================================
	log.Println("[Init] Starting River client...")

	if err := riverClient.Start(ctx); err != nil {
		log.Fatalf("[Init] Failed to start River client: %v", err)
	}

	// Start HTTP server in goroutine
	go func() {
		log.Println("[Init] Starting HTTP webhook server...")
		if err := webhookServer.Start(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[Init] Failed to start HTTP server: %v", err)
		}
	}()

	log.Println("========================================")
	log.Println("  ✓ Payment Worker Running")
	log.Println("========================================")
	log.Println("River Worker: Listening for jobs:")
	log.Println("  - create_payment_intent")
	log.Println("  - process_refund")
	log.Printf("HTTP Server: Listening on :%s/webhooks/stripe", webhookPort)
	log.Println("Press Ctrl+C to shutdown")
	log.Println("")

	// ===========================================================================
	// 6. Wait for Shutdown Signal
	// ===========================================================================
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	<-sigChan
	log.Println("")
	log.Println("[Shutdown] Received shutdown signal")

	// Graceful shutdown with timeout
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	// Stop HTTP server
	log.Println("[Shutdown] Stopping HTTP webhook server...")
	if err := webhookServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("[Shutdown] Error stopping HTTP server: %v", err)
	}

	// Stop River client
	log.Println("[Shutdown] Stopping River client...")
	if err := riverClient.Stop(shutdownCtx); err != nil {
		log.Printf("[Shutdown] Error stopping River client: %v", err)
	}

	log.Println("[Shutdown] Closing database connections...")
	dbPool.Close()

	log.Println("[Shutdown] ✓ Shutdown complete")
}

// ===========================================================================
// Helper Functions
// ===========================================================================

// getEnv gets an environment variable with a default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt gets an integer environment variable with a default value
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

// getEnvBool gets a boolean environment variable with a default value
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if boolValue, err := strconv.ParseBool(value); err == nil {
			return boolValue
		}
	}
	return defaultValue
}

// getEnvFloat gets a float64 environment variable with a default value
func getEnvFloat(key string, defaultValue float64) float64 {
	if value := os.Getenv(key); value != "" {
		if floatValue, err := strconv.ParseFloat(value, 64); err == nil {
			return floatValue
		}
	}
	return defaultValue
}

// maskPassword masks the password in a database URL for logging
func maskPassword(dbURL string) string {
	u, err := url.Parse(dbURL)
	if err != nil {
		return "***"
	}

	if u.User != nil {
		u.User = url.UserPassword(u.User.Username(), "***")
	}

	return u.String()
}
