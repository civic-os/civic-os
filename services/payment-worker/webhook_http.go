package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v81/webhook"
)

// WebhookHTTPServer handles HTTP webhook requests
type WebhookHTTPServer struct {
	handler       *WebhookHandler
	webhookSecret string
	server        *http.Server
}

func NewWebhookHTTPServer(handler *WebhookHandler, webhookSecret string, port string) *WebhookHTTPServer {
	mux := http.NewServeMux()

	s := &WebhookHTTPServer{
		handler:       handler,
		webhookSecret: webhookSecret,
	}

	// Register routes
	mux.HandleFunc("/webhooks/stripe", s.HandleStripeWebhook)
	mux.HandleFunc("/health", s.HandleHealth)

	// Create HTTP server with security settings
	s.server = &http.Server{
		Addr:           ":" + port,
		Handler:        mux,
		ReadTimeout:    10 * time.Second,
		WriteTimeout:   10 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20, // 1 MB
	}

	return s
}

// Start begins listening for HTTP requests
func (s *WebhookHTTPServer) Start() error {
	log.Printf("[HTTP] Starting webhook server on %s", s.server.Addr)
	log.Printf("[HTTP] Webhook endpoint: http://localhost%s/webhooks/stripe", s.server.Addr)
	return s.server.ListenAndServe()
}

// Shutdown gracefully stops the HTTP server
func (s *WebhookHTTPServer) Shutdown(ctx context.Context) error {
	log.Println("[HTTP] Shutting down webhook server...")
	return s.server.Shutdown(ctx)
}

// HandleStripeWebhook processes incoming Stripe webhook requests
func (s *WebhookHTTPServer) HandleStripeWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit request body size (64KB max)
	const MaxBodyBytes = 65536
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)

	// Read request body
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[Webhook] Failed to read body: %v", err)
		http.Error(w, "Request body too large", http.StatusBadRequest)
		return
	}

	// Get Stripe signature header
	signature := r.Header.Get("Stripe-Signature")
	if signature == "" {
		log.Printf("[Webhook] Missing Stripe-Signature header")
		http.Error(w, "Missing Stripe-Signature header", http.StatusBadRequest)
		return
	}

	// Verify signature and construct event
	// Note: IgnoreAPIVersionMismatch allows Stripe CLI to work with newer SDK versions
	event, err := webhook.ConstructEventWithOptions(
		payload,
		signature,
		s.webhookSecret,
		webhook.ConstructEventOptions{
			IgnoreAPIVersionMismatch: true,
		},
	)
	if err != nil {
		log.Printf("[Webhook] Signature verification failed: %v", err)
		http.Error(w, "Invalid signature", http.StatusBadRequest)
		return
	}

	log.Printf("[Webhook] Received verified event: id=%s, type=%s", event.ID, event.Type)

	// Process webhook with timeout context
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := s.handler.ProcessStripeWebhook(ctx, event); err != nil {
		log.Printf("[Webhook] Processing failed: %v", err)
		http.Error(w, "Webhook processing failed", http.StatusInternalServerError)
		return
	}

	// Return success response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"received": true})
}

// HandleHealth provides a health check endpoint
func (s *WebhookHTTPServer) HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}
