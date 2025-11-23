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

// CreateIntentWorkerArgs contains the arguments for CreateIntentWorker
// This matches the JSON args inserted by the PostgreSQL trigger
type CreateIntentWorkerArgs struct {
	PaymentID string `json:"payment_id"`
}

// Kind returns the job kind identifier for River
func (CreateIntentWorkerArgs) Kind() string {
	return "create_payment_intent"
}

// CreateIntentWorker processes payment intent creation jobs
type CreateIntentWorker struct {
	river.WorkerDefaults[CreateIntentWorkerArgs]
	dbPool   *pgxpool.Pool
	provider PaymentProvider
}

// NewCreateIntentWorker creates a new CreateIntentWorker
func NewCreateIntentWorker(dbPool *pgxpool.Pool, provider PaymentProvider) *CreateIntentWorker {
	return &CreateIntentWorker{
		dbPool:   dbPool,
		provider: provider,
	}
}

// Work processes a single payment intent creation job
func (w *CreateIntentWorker) Work(ctx context.Context, job *river.Job[CreateIntentWorkerArgs]) error {
	paymentID := job.Args.PaymentID

	log.Printf("[CreateIntent] Processing job for payment %s", paymentID)

	// 1. Fetch payment record from database
	var payment struct {
		ID          string
		UserID      string
		Amount      float64
		Currency    string
		Description *string
		Status      string
	}

	query := `
		SELECT
			id,
			user_id,
			amount,
			currency,
			description,
			status
		FROM payments.transactions
		WHERE id = $1
	`

	err := w.dbPool.QueryRow(ctx, query, paymentID).Scan(
		&payment.ID,
		&payment.UserID,
		&payment.Amount,
		&payment.Currency,
		&payment.Description,
		&payment.Status,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			log.Printf("[CreateIntent] Payment %s not found", paymentID)
			return fmt.Errorf("payment not found: %s", paymentID)
		}
		log.Printf("[CreateIntent] Error fetching payment %s: %v", paymentID, err)
		return fmt.Errorf("database error: %w", err)
	}

	log.Printf("[CreateIntent] Fetched payment: id=%s, amount=%.2f %s, status=%s",
		payment.ID, payment.Amount, payment.Currency, payment.Status)

	// 2. Validate payment is in correct state
	if payment.Status != "pending_intent" {
		log.Printf("[CreateIntent] Payment %s already processed (status=%s), skipping", paymentID, payment.Status)
		return nil // Not an error - payment was already processed
	}

	// 3. Convert amount to cents (Stripe uses smallest currency unit)
	amountCents := int64(payment.Amount * 100)

	description := ""
	if payment.Description != nil {
		description = *payment.Description
	}

	// 4. Call Stripe to create PaymentIntent
	result, err := w.provider.CreateIntent(ctx, CreateIntentParams{
		Amount:      amountCents,
		Currency:    payment.Currency,
		Description: description,
	})
	if err != nil {
		log.Printf("[CreateIntent] Error creating Stripe intent for payment %s: %v", paymentID, err)

		// Update payment with error
		updateErr := w.updatePaymentError(ctx, paymentID, err.Error())
		if updateErr != nil {
			log.Printf("[CreateIntent] Failed to update payment error: %v", updateErr)
		}

		// Return error to trigger River retry
		return fmt.Errorf("stripe error: %w", err)
	}

	log.Printf("[CreateIntent] ✓ Stripe PaymentIntent created: %s", result.PaymentIntentID)

	// 5. Update payment record with Stripe details
	err = w.updatePaymentSuccess(ctx, paymentID, result)
	if err != nil {
		log.Printf("[CreateIntent] Error updating payment %s: %v", paymentID, err)
		return fmt.Errorf("database update error: %w", err)
	}

	log.Printf("[CreateIntent] ✓ Payment %s updated successfully", paymentID)
	return nil
}

// updatePaymentSuccess updates the payment record with Stripe details
func (w *CreateIntentWorker) updatePaymentSuccess(ctx context.Context, paymentID string, result *PaymentIntentResult) error {
	query := `
		UPDATE payments.transactions
		SET
			provider_payment_id = $1,
			provider_client_secret = $2,
			status = 'pending',
			error_message = NULL,
			updated_at = NOW()
		WHERE id = $3
	`

	_, err := w.dbPool.Exec(ctx, query,
		result.PaymentIntentID,
		result.ClientSecret,
		paymentID,
	)

	return err
}

// updatePaymentError updates the payment record with error details
func (w *CreateIntentWorker) updatePaymentError(ctx context.Context, paymentID string, errorMsg string) error {
	query := `
		UPDATE payments.transactions
		SET
			status = 'failed',
			error_message = $1,
			updated_at = NOW()
		WHERE id = $2
	`

	_, err := w.dbPool.Exec(ctx, query, errorMsg, paymentID)
	return err
}

// MarshalJSON implements custom JSON marshaling for logging
func (a CreateIntentWorkerArgs) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]interface{}{
		"payment_id": a.PaymentID,
	})
}
