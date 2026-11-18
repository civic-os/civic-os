package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

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

	// Insert webhook with idempotency check. A row that already exists is
	// reprocessed only while processed = FALSE, which happens only when an
	// earlier delivery failed and recordWebhookError saved its error; a
	// processed event returns no row and is skipped as a duplicate. A concurrent
	// delivery of the same event waits on this row until this transaction ends.
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
		ON CONFLICT (provider, provider_event_id) DO UPDATE
			SET payload = EXCLUDED.payload, signature_verified = TRUE
			WHERE metadata.webhooks.processed = FALSE
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
	case "charge.refunded":
		processingErr = h.handleChargeRefunded(ctx, tx, event)
	default:
		// Unknown event type - just mark as processed
		log.Printf("[Webhook] Unknown event type '%s', marking as processed", event.Type)
		processingErr = nil
	}

	if processingErr != nil {
		// Roll back the handler's partial work, then save the error outside the
		// transaction so it survives. The row stays processed = FALSE, so
		// Stripe's retry (we return 500) reprocesses the event.
		if err := tx.Rollback(ctx); err != nil {
			log.Printf("[Webhook] Rollback failed for event %s: %v", event.ID, err)
		}
		h.recordWebhookError(ctx, event, eventJSON, processingErr.Error())
		return processingErr
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

// handleChargeRefunded updates refund status based on Stripe webhook
// This serves as confirmation that Stripe processed the refund
//
// Design note: With 1:M refund support, there could be multiple refunds per payment.
// However, the initiate_payment_refund RPC blocks concurrent refunds (only one pending
// at a time), so this handler should only ever update one refund per webhook.
// The RefundWorker is the primary mechanism for updating refund status; this webhook
// is belt-and-suspenders confirmation.
func (h *WebhookHandler) handleChargeRefunded(ctx context.Context, tx pgx.Tx, event stripe.Event) error {
	var charge stripe.Charge
	if err := json.Unmarshal(event.Data.Raw, &charge); err != nil {
		return fmt.Errorf("unmarshal charge: %w", err)
	}

	// Get the payment intent ID from the charge
	paymentIntentID := ""
	if charge.PaymentIntent != nil {
		paymentIntentID = charge.PaymentIntent.ID
	}

	log.Printf("[Webhook] Processing refund for charge %s (payment_intent=%s)", charge.ID, paymentIntentID)

	if paymentIntentID == "" {
		log.Printf("[Webhook] ⚠ Charge %s has no payment_intent, skipping", charge.ID)
		return nil
	}

	// Update any pending refunds for this payment to succeeded
	// With the concurrent refund block in the RPC, there should be at most one pending refund
	result, err := tx.Exec(ctx, `
		UPDATE payments.refunds r
		SET
			status = 'succeeded',
			processed_at = COALESCE(r.processed_at, NOW())
		FROM payments.transactions t
		WHERE r.transaction_id = t.id
		AND t.provider_payment_id = $1
		AND r.status = 'pending'
	`, paymentIntentID)

	if err != nil {
		return fmt.Errorf("update refund status: %w", err)
	}

	rowsAffected := result.RowsAffected()
	if rowsAffected > 0 {
		log.Printf("[Webhook] ✓ Updated %d pending refund(s) to succeeded for payment %s", rowsAffected, paymentIntentID)
		if rowsAffected > 1 {
			// This shouldn't happen with the RPC's concurrent refund block
			log.Printf("[Webhook] ⚠ WARNING: Multiple pending refunds updated. This indicates a possible race condition.")
		}
	} else {
		// No pending refunds found - either already processed by RefundWorker or refund initiated externally
		log.Printf("[Webhook] No pending refunds found for payment %s (already processed or refund initiated externally)", paymentIntentID)
	}

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

// recordWebhookError saves a processing error on the event's webhook row,
// creating the row if the rolled-back transaction removed it. It runs outside
// that transaction and ignores the request's cancellation, so the error is kept
// even when the HTTP request has ended. It never overwrites a row another
// delivery has since processed. Failures are logged only: the caller already
// returns the processing error.
func (h *WebhookHandler) recordWebhookError(ctx context.Context, event stripe.Event, eventJSON []byte, errorMsg string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := h.dbPool.Exec(ctx, `
		INSERT INTO metadata.webhooks (
			provider,
			provider_event_id,
			event_type,
			payload,
			signature_verified,
			processed,
			error_message
		) VALUES ($1, $2, $3, $4, TRUE, FALSE, $5)
		ON CONFLICT (provider, provider_event_id) DO UPDATE
			SET error_message = EXCLUDED.error_message
			WHERE metadata.webhooks.processed = FALSE
	`, "stripe", event.ID, event.Type, eventJSON, errorMsg)
	if err != nil {
		log.Printf("[Webhook] Failed to record error for event %s: %v", event.ID, err)
	}
}
