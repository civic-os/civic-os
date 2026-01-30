package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

// FeeConfig holds processing fee configuration
type FeeConfig struct {
	Enabled    bool    // Whether processing fees are enabled
	Percent    float64 // Fee percentage (e.g., 2.9 for 2.9%)
	FlatCents  int     // Flat fee in cents (e.g., 30 for $0.30)
	Refundable bool    // Whether the fee is refundable (default: false)
}

// CalculateFee calculates the processing fee needed to ensure the recipient
// receives exactly baseAmountCents after Stripe takes its cut.
//
// The "gross-up" formula accounts for Stripe charging its percentage on the
// total amount (including the fee itself):
//
//	totalCharge = (base + flat) / (1 - percent)
//	fee = totalCharge - base
//
// Example: $150 base with 2.9% + $0.30 flat
//   - Naive formula: $150 × 2.9% + $0.30 = $4.65 → user pays $154.65
//   - Stripe takes: $154.65 × 2.9% + $0.30 = $4.78 → recipient gets $149.87 ✗
//   - Gross-up formula: ($150 + $0.30) / (1 - 0.029) = $154.79 → fee = $4.79
//   - Stripe takes: $154.79 × 2.9% + $0.30 = $4.79 → recipient gets $150.00 ✓
//
// Returns fee in cents, rounded UP to ensure full coverage (never short recipient).
func (fc *FeeConfig) CalculateFee(baseAmountCents int64) int64 {
	if !fc.Enabled {
		return 0
	}

	// Convert to float for precision
	base := float64(baseAmountCents)
	flat := float64(fc.FlatCents)
	percent := fc.Percent / 100.0

	// Gross-up formula: what we need to charge so recipient gets exactly 'base'
	// after Stripe takes its cut of the total
	totalToCharge := (base + flat) / (1.0 - percent)

	// Fee is the difference between what we charge and what recipient needs
	feeCents := totalToCharge - base

	// Round UP to ensure we always cover the full amount (never short recipient by a penny)
	return int64(math.Ceil(feeCents))
}

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
	dbPool    *pgxpool.Pool
	provider  PaymentProvider
	feeConfig *FeeConfig
}

// NewCreateIntentWorker creates a new CreateIntentWorker
func NewCreateIntentWorker(dbPool *pgxpool.Pool, provider PaymentProvider, feeConfig *FeeConfig) *CreateIntentWorker {
	return &CreateIntentWorker{
		dbPool:    dbPool,
		provider:  provider,
		feeConfig: feeConfig,
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

	// 3. Convert base amount to cents (Stripe uses smallest currency unit)
	baseAmountCents := int64(payment.Amount * 100)

	// 4. Calculate processing fee
	feeCents := w.feeConfig.CalculateFee(baseAmountCents)
	totalAmountCents := baseAmountCents + feeCents

	if feeCents > 0 {
		log.Printf("[CreateIntent] Fee calculation: base=%d cents, fee=%d cents (%.2f%% + %d flat), total=%d cents",
			baseAmountCents, feeCents, w.feeConfig.Percent, w.feeConfig.FlatCents, totalAmountCents)
	}

	// 5. Update payment record with fee details BEFORE calling Stripe
	if err := w.updatePaymentFee(ctx, paymentID, feeCents); err != nil {
		log.Printf("[CreateIntent] Error updating fee for payment %s: %v", paymentID, err)
		return fmt.Errorf("failed to update fee: %w", err)
	}

	description := ""
	if payment.Description != nil {
		description = *payment.Description
	}

	// 6. Call Stripe to create PaymentIntent with TOTAL amount (base + fee)
	result, err := w.provider.CreateIntent(ctx, CreateIntentParams{
		Amount:      totalAmountCents,
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

	// 7. Update payment record with Stripe details
	err = w.updatePaymentSuccess(ctx, paymentID, result)
	if err != nil {
		log.Printf("[CreateIntent] Error updating payment %s: %v", paymentID, err)
		return fmt.Errorf("database update error: %w", err)
	}

	log.Printf("[CreateIntent] ✓ Payment %s updated successfully", paymentID)
	return nil
}

// updatePaymentFee updates the payment record with fee details
// This is called BEFORE calling Stripe so we have an audit trail
func (w *CreateIntentWorker) updatePaymentFee(ctx context.Context, paymentID string, feeCents int64) error {
	// Convert fee cents to dollars for storage
	feeDollars := float64(feeCents) / 100.0

	// Store fee configuration at time of payment for auditing
	// fee_percent and fee_flat_cents are only set if fees are enabled
	var feePercent *float64
	var feeFlatCents *int

	if w.feeConfig.Enabled {
		feePercent = &w.feeConfig.Percent
		feeFlatCents = &w.feeConfig.FlatCents
	}

	query := `
		UPDATE payments.transactions
		SET
			processing_fee = $1,
			fee_percent = $2,
			fee_flat_cents = $3,
			fee_refundable = $4,
			updated_at = NOW()
		WHERE id = $5
	`

	_, err := w.dbPool.Exec(ctx, query,
		feeDollars,
		feePercent,
		feeFlatCents,
		w.feeConfig.Refundable,
		paymentID,
	)

	return err
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
