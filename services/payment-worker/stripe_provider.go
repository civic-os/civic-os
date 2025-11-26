package main

import (
	"context"
	"fmt"
	"log"

	"github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/paymentintent"
	"github.com/stripe/stripe-go/v81/refund"
)

// PaymentProvider defines the interface for payment processors
type PaymentProvider interface {
	CreateIntent(ctx context.Context, params CreateIntentParams) (*PaymentIntentResult, error)
	CreateRefund(ctx context.Context, params RefundParams) (*RefundResult, error)
}

// CreateIntentParams contains parameters for creating a payment intent
type CreateIntentParams struct {
	Amount      int64  // Amount in cents (e.g., 1000 = $10.00)
	Currency    string // Currency code (e.g., "usd")
	Description string // Payment description
	// POC: No metadata, customer ID, or other fields yet
}

// PaymentIntentResult contains the result of creating a payment intent
type PaymentIntentResult struct {
	PaymentIntentID string // Stripe PaymentIntent ID (pi_...)
	ClientSecret    string // client_secret for Stripe Elements
	Status          string // Payment intent status (e.g., "requires_payment_method")
}

// RefundParams contains parameters for creating a refund
type RefundParams struct {
	PaymentIntentID string // Stripe PaymentIntent ID to refund (pi_...)
	AmountCents     int64  // Amount to refund in cents (partial refunds supported)
	Reason          string // Reason for refund (shown in Stripe dashboard)
}

// RefundResult contains the result of creating a refund
type RefundResult struct {
	RefundID string // Stripe Refund ID (re_...)
	Status   string // Refund status (e.g., "succeeded", "pending")
}

// StripeProvider implements PaymentProvider for Stripe
type StripeProvider struct {
	apiKey string
}

// NewStripeProvider creates a new Stripe payment provider
func NewStripeProvider(apiKey string) *StripeProvider {
	if apiKey == "" {
		log.Fatal("[Stripe] STRIPE_API_KEY is required")
	}

	// Set global API key for Stripe SDK
	stripe.Key = apiKey

	log.Printf("[Stripe] Provider initialized (key: %s...)", maskAPIKey(apiKey))

	return &StripeProvider{
		apiKey: apiKey,
	}
}

// CreateIntent creates a Stripe PaymentIntent
func (s *StripeProvider) CreateIntent(ctx context.Context, params CreateIntentParams) (*PaymentIntentResult, error) {
	log.Printf("[Stripe] Creating PaymentIntent: amount=%d %s, description=%q",
		params.Amount, params.Currency, params.Description)

	// Validate params
	if params.Amount <= 0 {
		return nil, fmt.Errorf("invalid amount: %d (must be > 0)", params.Amount)
	}
	if params.Currency == "" {
		params.Currency = "usd"
	}

	// Create Stripe PaymentIntent
	intentParams := &stripe.PaymentIntentParams{
		Amount:      stripe.Int64(params.Amount),
		Currency:    stripe.String(params.Currency),
		Description: stripe.String(params.Description),

		// POC: Immediate capture (default)
		// Future: Support deferred capture with CaptureMethod: manual
		CaptureMethod: stripe.String("automatic"),

		// Enable automatic payment methods (cards, etc.)
		AutomaticPaymentMethods: &stripe.PaymentIntentAutomaticPaymentMethodsParams{
			Enabled: stripe.Bool(true),
		},
	}

	// Call Stripe API
	intent, err := paymentintent.New(intentParams)
	if err != nil {
		log.Printf("[Stripe] Error creating PaymentIntent: %v", err)
		return nil, fmt.Errorf("stripe API error: %w", err)
	}

	log.Printf("[Stripe] ✓ PaymentIntent created: id=%s, status=%s, client_secret=%s...",
		intent.ID, intent.Status, maskSecret(intent.ClientSecret))

	// Return result
	return &PaymentIntentResult{
		PaymentIntentID: intent.ID,
		ClientSecret:    intent.ClientSecret,
		Status:          string(intent.Status),
	}, nil
}

// maskAPIKey masks API key for logging (show first 7 chars + ...)
func maskAPIKey(apiKey string) string {
	if len(apiKey) <= 10 {
		return "***"
	}
	return apiKey[:7] + "..." + apiKey[len(apiKey)-4:]
}

// maskSecret masks client_secret for logging (show first 12 chars + ...)
func maskSecret(secret string) string {
	if len(secret) <= 15 {
		return "***"
	}
	return secret[:12] + "..."
}

// CreateRefund creates a Stripe Refund for a PaymentIntent
func (s *StripeProvider) CreateRefund(ctx context.Context, params RefundParams) (*RefundResult, error) {
	log.Printf("[Stripe] Creating Refund: payment_intent=%s, amount=%d cents",
		params.PaymentIntentID, params.AmountCents)

	// Validate params
	if params.PaymentIntentID == "" {
		return nil, fmt.Errorf("payment_intent_id is required")
	}
	if params.AmountCents <= 0 {
		return nil, fmt.Errorf("invalid amount: %d (must be > 0)", params.AmountCents)
	}

	// Create Stripe Refund
	refundParams := &stripe.RefundParams{
		PaymentIntent: stripe.String(params.PaymentIntentID),
		Amount:        stripe.Int64(params.AmountCents),
	}

	// Add reason as metadata if provided
	if params.Reason != "" {
		refundParams.Reason = stripe.String("requested_by_customer")
		refundParams.AddMetadata("reason", params.Reason)
	}

	// Call Stripe API
	stripeRefund, err := refund.New(refundParams)
	if err != nil {
		log.Printf("[Stripe] Error creating Refund: %v", err)
		return nil, fmt.Errorf("stripe API error: %w", err)
	}

	log.Printf("[Stripe] ✓ Refund created: id=%s, status=%s",
		stripeRefund.ID, stripeRefund.Status)

	return &RefundResult{
		RefundID: stripeRefund.ID,
		Status:   string(stripeRefund.Status),
	}, nil
}
