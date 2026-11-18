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
	dbPool      *pgxpool.Pool
	provider    PaymentProvider
	instanceKey string // PAYMENT_INSTANCE_KEY, sent as civic_os_instance when set
}

// NewRefundWorker creates a new RefundWorker
func NewRefundWorker(dbPool *pgxpool.Pool, provider PaymentProvider, instanceKey string) *RefundWorker {
	return &RefundWorker{
		dbPool:      dbPool,
		provider:    provider,
		instanceKey: instanceKey,
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
		EntityType    *string
		EntityID      *string
	}

	query := `
		SELECT
			r.id,
			r.transaction_id,
			r.status,
			r.reason,
			t.entity_type,
			t.entity_id
		FROM payments.refunds r
		JOIN payments.transactions t ON t.id = r.transaction_id
		WHERE r.id = $1
	`

	err := w.dbPool.QueryRow(ctx, query, refundID).Scan(
		&refund.ID,
		&refund.TransactionID,
		&refund.Status,
		&refund.Reason,
		&refund.EntityType,
		&refund.EntityID,
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

	// 3. Call Stripe to create refund. The idempotency key makes a River retry
	// after a failed DB update (step 4) get the same Refund back instead of
	// refunding twice.
	result, err := w.provider.CreateRefund(ctx, RefundParams{
		PaymentIntentID: paymentIntentID,
		AmountCents:     amountCents,
		Reason:          refund.Reason,
		IdempotencyKey:  "civic-os:refund:" + refundID,
		Metadata: refundMetadata(paymentIdentity{
			TransactionID: refund.TransactionID,
			EntityType:    refund.EntityType,
			EntityID:      refund.EntityID,
		}, refund.ID, w.instanceKey),
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

	// The user's refund notification comes from the refund_succeeded_notification
	// trigger on payments.refunds, which fires on the status change above.

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

// MarshalJSON implements custom JSON marshaling for logging
func (a RefundWorkerArgs) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]interface{}{
		"refund_id":         a.RefundID,
		"payment_intent_id": a.PaymentIntentID,
		"amount_cents":      a.AmountCents,
	})
}
