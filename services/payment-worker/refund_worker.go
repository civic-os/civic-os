package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// RefundWorkerArgs contains the arguments for RefundWorker
// This matches the JSON args inserted by the initiate_payment_refund RPC
type RefundWorkerArgs struct {
	RefundID        string `json:"refund_id"`
	PaymentIntentID string `json:"payment_intent_id"`
	AmountCents     int64  `json:"amount_cents"`
}

// Kind returns the job kind identifier for River
func (RefundWorkerArgs) Kind() string {
	return "process_refund"
}

// RefundWorker processes refund jobs
type RefundWorker struct {
	river.WorkerDefaults[RefundWorkerArgs]
	dbPool   *pgxpool.Pool
	provider PaymentProvider
}

// NewRefundWorker creates a new RefundWorker
func NewRefundWorker(dbPool *pgxpool.Pool, provider PaymentProvider) *RefundWorker {
	return &RefundWorker{
		dbPool:   dbPool,
		provider: provider,
	}
}

// Work processes a single refund job
func (w *RefundWorker) Work(ctx context.Context, job *river.Job[RefundWorkerArgs]) error {
	refundID := job.Args.RefundID
	paymentIntentID := job.Args.PaymentIntentID
	amountCents := job.Args.AmountCents

	log.Printf("[Refund] Processing job for refund %s (payment_intent=%s, amount=%d cents)",
		refundID, paymentIntentID, amountCents)

	// 1. Fetch refund record to verify it's still pending
	var refund struct {
		ID            string
		TransactionID string
		Status        string
		Reason        string
		UserID        string
	}

	query := `
		SELECT
			r.id,
			r.transaction_id,
			r.status,
			r.reason,
			t.user_id
		FROM payments.refunds r
		JOIN payments.transactions t ON r.transaction_id = t.id
		WHERE r.id = $1
	`

	err := w.dbPool.QueryRow(ctx, query, refundID).Scan(
		&refund.ID,
		&refund.TransactionID,
		&refund.Status,
		&refund.Reason,
		&refund.UserID,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			log.Printf("[Refund] Refund %s not found", refundID)
			return fmt.Errorf("refund not found: %s", refundID)
		}
		log.Printf("[Refund] Error fetching refund %s: %v", refundID, err)
		return fmt.Errorf("database error: %w", err)
	}

	log.Printf("[Refund] Fetched refund: id=%s, status=%s, transaction_id=%s",
		refund.ID, refund.Status, refund.TransactionID)

	// 2. Validate refund is in correct state (idempotent - skip if already processed)
	if refund.Status != "pending" {
		log.Printf("[Refund] Refund %s already processed (status=%s), skipping", refundID, refund.Status)
		return nil // Not an error - refund was already processed
	}

	// 3. Call Stripe to create refund
	result, err := w.provider.CreateRefund(ctx, RefundParams{
		PaymentIntentID: paymentIntentID,
		AmountCents:     amountCents,
		Reason:          refund.Reason,
	})
	if err != nil {
		log.Printf("[Refund] Error creating Stripe refund for %s: %v", refundID, err)

		// Update refund with error (don't retry Stripe errors - they're typically permanent)
		updateErr := w.updateRefundError(ctx, refundID, err.Error())
		if updateErr != nil {
			log.Printf("[Refund] Failed to update refund error: %v", updateErr)
		}

		// Return nil to not retry - Stripe errors are usually permanent (invalid payment, etc.)
		// The refund is marked as failed and admin can investigate
		return nil
	}

	log.Printf("[Refund] ✓ Stripe Refund created: %s", result.RefundID)

	// 4. Update refund record with Stripe details
	err = w.updateRefundSuccess(ctx, refundID, result)
	if err != nil {
		log.Printf("[Refund] Error updating refund %s: %v", refundID, err)
		return fmt.Errorf("database update error: %w", err)
	}

	// 5. Enqueue notification job for user
	err = w.enqueueNotification(ctx, refund.UserID, refund.TransactionID, refundID)
	if err != nil {
		// Log but don't fail - notification is secondary
		log.Printf("[Refund] Warning: Failed to enqueue notification: %v", err)
	}

	log.Printf("[Refund] ✓ Refund %s completed successfully", refundID)
	return nil
}

// updateRefundSuccess updates the refund record with Stripe details
func (w *RefundWorker) updateRefundSuccess(ctx context.Context, refundID string, result *RefundResult) error {
	query := `
		UPDATE payments.refunds
		SET
			provider_refund_id = $1,
			status = 'succeeded',
			error_message = NULL,
			processed_at = NOW()
		WHERE id = $2
	`

	_, err := w.dbPool.Exec(ctx, query, result.RefundID, refundID)
	return err
}

// updateRefundError updates the refund record with error details
func (w *RefundWorker) updateRefundError(ctx context.Context, refundID string, errorMsg string) error {
	query := `
		UPDATE payments.refunds
		SET
			status = 'failed',
			error_message = $1,
			processed_at = NOW()
		WHERE id = $2
	`

	_, err := w.dbPool.Exec(ctx, query, errorMsg, refundID)
	return err
}

// enqueueNotification enqueues a notification job for the refund
func (w *RefundWorker) enqueueNotification(ctx context.Context, userID, transactionID, refundID string) error {
	// Build entity data for the notification template
	entityData := map[string]interface{}{
		"transaction_id": transactionID,
		"refund_id":      refundID,
	}

	// Fetch additional data for the notification
	var amount, refundAmount float64
	var description, reason string

	query := `
		SELECT
			t.amount,
			t.description,
			r.amount AS refund_amount,
			r.reason
		FROM payments.transactions t
		JOIN payments.refunds r ON r.transaction_id = t.id
		WHERE r.id = $1
	`

	err := w.dbPool.QueryRow(ctx, query, refundID).Scan(
		&amount, &description, &refundAmount, &reason,
	)
	if err != nil {
		return fmt.Errorf("failed to fetch notification data: %w", err)
	}

	entityData["amount"] = amount
	entityData["description"] = description
	entityData["refund_amount"] = refundAmount
	entityData["reason"] = reason

	// Build notification args
	entityDataJSON, _ := json.Marshal(entityData)
	notificationArgs := map[string]interface{}{
		"user_id":       userID,
		"template_name": "payment_refunded",
		"entity_type":   "payments.transactions",
		"entity_id":     transactionID,
		"entity_data":   json.RawMessage(entityDataJSON),
		"channels":      []string{"email"},
	}

	argsJSON, err := json.Marshal(notificationArgs)
	if err != nil {
		return fmt.Errorf("failed to marshal notification args: %w", err)
	}

	// Enqueue notification job
	insertQuery := `
		INSERT INTO metadata.river_job (
			kind,
			args,
			priority,
			queue,
			max_attempts,
			scheduled_at,
			state
		) VALUES (
			'send_notification',
			$1,
			2,
			'default',
			3,
			NOW(),
			'available'
		)
	`

	_, err = w.dbPool.Exec(ctx, insertQuery, argsJSON)
	if err != nil {
		return fmt.Errorf("failed to enqueue notification: %w", err)
	}

	log.Printf("[Refund] ✓ Notification job enqueued for user %s", userID)
	return nil
}

// MarshalJSON implements custom JSON marshaling for logging
func (a RefundWorkerArgs) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]interface{}{
		"refund_id":         a.RefundID,
		"payment_intent_id": a.PaymentIntentID,
		"amount_cents":      a.AmountCents,
	})
}
