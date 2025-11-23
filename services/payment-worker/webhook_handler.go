package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stripe/stripe-go/v81"
)

// WebhookHandler processes Stripe webhook events with database transactions
type WebhookHandler struct {
	dbPool *pgxpool.Pool
}

func NewWebhookHandler(dbPool *pgxpool.Pool) *WebhookHandler {
	return &WebhookHandler{dbPool: dbPool}
}

// ProcessStripeWebhook handles a verified Stripe webhook event
// Returns nil on success (including duplicates), error triggers HTTP 500
func (h *WebhookHandler) ProcessStripeWebhook(ctx context.Context, event stripe.Event) error {
	log.Printf("[Webhook] Processing event: id=%s, type=%s", event.ID, event.Type)

	// Begin transaction
	tx, err := h.dbPool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx) // Auto-rollback if not committed

	// Serialize event to JSONB
	eventJSON, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	// Insert webhook with idempotency check
	var webhookID string
	err = tx.QueryRow(ctx, `
		INSERT INTO metadata.webhooks (
			provider,
			provider_event_id,
			event_type,
			payload,
			signature_verified,
			processed
		) VALUES ($1, $2, $3, $4, TRUE, FALSE)
		ON CONFLICT (provider, provider_event_id) DO NOTHING
		RETURNING id
	`, "stripe", event.ID, event.Type, eventJSON).Scan(&webhookID)

	if err == pgx.ErrNoRows {
		// Duplicate webhook - already processed
		log.Printf("[Webhook] Duplicate event %s, skipping", event.ID)
		return nil // Return success (200 OK to Stripe)
	}
	if err != nil {
		return fmt.Errorf("insert webhook: %w", err)
	}

	log.Printf("[Webhook] Created webhook record: %s", webhookID)

	// Route to handler based on event type
	var processingErr error
	switch event.Type {
	case "payment_intent.succeeded":
		processingErr = h.handlePaymentIntentSucceeded(ctx, tx, event)
	case "payment_intent.payment_failed":
		processingErr = h.handlePaymentIntentFailed(ctx, tx, event)
	case "payment_intent.canceled":
		processingErr = h.handlePaymentIntentCanceled(ctx, tx, event)
	default:
		// Unknown event type - just mark as processed
		log.Printf("[Webhook] Unknown event type '%s', marking as processed", event.Type)
		processingErr = nil
	}

	if processingErr != nil {
		// Mark webhook with error
		h.markWebhookError(ctx, tx, webhookID, processingErr.Error())
		return processingErr // Rollback transaction, return 500 to Stripe
	}

	// Mark webhook as processed
	if err := h.markWebhookProcessed(ctx, tx, webhookID); err != nil {
		return err
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}

	log.Printf("[Webhook] ✓ Event %s processed successfully", event.ID)
	return nil
}

// handlePaymentIntentSucceeded updates payment status to 'succeeded'
func (h *WebhookHandler) handlePaymentIntentSucceeded(ctx context.Context, tx pgx.Tx, event stripe.Event) error {
	var paymentIntent stripe.PaymentIntent
	if err := json.Unmarshal(event.Data.Raw, &paymentIntent); err != nil {
		return fmt.Errorf("unmarshal payment_intent: %w", err)
	}

	log.Printf("[Webhook] Marking payment %s as succeeded", paymentIntent.ID)

	result, err := tx.Exec(ctx, `
		UPDATE payments.transactions
		SET status = 'succeeded', updated_at = NOW()
		WHERE provider_payment_id = $1
	`, paymentIntent.ID)

	if err != nil {
		return fmt.Errorf("update payment: %w", err)
	}

	if result.RowsAffected() == 0 {
		// Payment not found - likely an orphaned PaymentIntent from a retry
		// When users retry failed payments, we create a new transaction and new PaymentIntent
		// Old PaymentIntents may still complete if user had the form open
		// This is safe to ignore - the new transaction is what matters
		log.Printf("[Webhook] ⚠ Payment %s not found (likely orphaned from retry), marking webhook as processed", paymentIntent.ID)
		return nil // Return success to avoid Stripe retries
	}

	log.Printf("[Webhook] ✓ Payment %s marked as succeeded", paymentIntent.ID)
	return nil
}

// handlePaymentIntentFailed updates payment status to 'failed'
func (h *WebhookHandler) handlePaymentIntentFailed(ctx context.Context, tx pgx.Tx, event stripe.Event) error {
	var paymentIntent stripe.PaymentIntent
	if err := json.Unmarshal(event.Data.Raw, &paymentIntent); err != nil {
		return fmt.Errorf("unmarshal payment_intent: %w", err)
	}

	log.Printf("[Webhook] Marking payment %s as failed", paymentIntent.ID)

	result, err := tx.Exec(ctx, `
		UPDATE payments.transactions
		SET status = 'failed', updated_at = NOW()
		WHERE provider_payment_id = $1
	`, paymentIntent.ID)

	if err != nil {
		return fmt.Errorf("update payment: %w", err)
	}

	if result.RowsAffected() == 0 {
		// Payment not found - likely an orphaned PaymentIntent from a retry
		log.Printf("[Webhook] ⚠ Payment %s not found (likely orphaned from retry), marking webhook as processed", paymentIntent.ID)
		return nil // Return success to avoid Stripe retries
	}

	log.Printf("[Webhook] ✓ Payment %s marked as failed", paymentIntent.ID)
	return nil
}

// handlePaymentIntentCanceled updates payment status to 'canceled'
func (h *WebhookHandler) handlePaymentIntentCanceled(ctx context.Context, tx pgx.Tx, event stripe.Event) error {
	var paymentIntent stripe.PaymentIntent
	if err := json.Unmarshal(event.Data.Raw, &paymentIntent); err != nil {
		return fmt.Errorf("unmarshal payment_intent: %w", err)
	}

	log.Printf("[Webhook] Marking payment %s as canceled", paymentIntent.ID)

	result, err := tx.Exec(ctx, `
		UPDATE payments.transactions
		SET status = 'canceled', updated_at = NOW()
		WHERE provider_payment_id = $1
	`, paymentIntent.ID)

	if err != nil {
		return fmt.Errorf("update payment: %w", err)
	}

	if result.RowsAffected() == 0 {
		// Payment not found - likely an orphaned PaymentIntent from a retry
		log.Printf("[Webhook] ⚠ Payment %s not found (likely orphaned from retry), marking webhook as processed", paymentIntent.ID)
		return nil // Return success to avoid Stripe retries
	}

	log.Printf("[Webhook] ✓ Payment %s marked as canceled", paymentIntent.ID)
	return nil
}

// markWebhookProcessed marks webhook as successfully processed
func (h *WebhookHandler) markWebhookProcessed(ctx context.Context, tx pgx.Tx, webhookID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE metadata.webhooks
		SET processed = TRUE, processed_at = NOW(), error_message = NULL
		WHERE id = $1
	`, webhookID)
	return err
}

// markWebhookError marks webhook with error message
func (h *WebhookHandler) markWebhookError(ctx context.Context, tx pgx.Tx, webhookID string, errorMsg string) error {
	_, err := tx.Exec(ctx, `
		UPDATE metadata.webhooks
		SET error_message = $1, processed_at = NOW()
		WHERE id = $2
	`, errorMsg, webhookID)
	if err != nil {
		log.Printf("[Webhook] Failed to mark webhook error: %v", err)
	}
	return err
}
