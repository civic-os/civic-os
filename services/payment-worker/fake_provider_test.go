package main

import (
	"context"
	"sync"
)

// fakeProvider is a PaymentProvider that records calls and returns canned
// results, so worker tests never reach Stripe.
type fakeProvider struct {
	mu sync.Mutex

	intentCalls []CreateIntentParams
	refundCalls []RefundParams

	intentResult *PaymentIntentResult
	intentErr    error
	refundResult *RefundResult
	refundErr    error
}

func (f *fakeProvider) CreateIntent(_ context.Context, params CreateIntentParams) (*PaymentIntentResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.intentCalls = append(f.intentCalls, params)
	if f.intentErr != nil {
		return nil, f.intentErr
	}
	if f.intentResult != nil {
		return f.intentResult, nil
	}
	return &PaymentIntentResult{
		PaymentIntentID: "pi_fake_" + randomSuffix(),
		ClientSecret:    "pi_fake_secret_" + randomSuffix(),
		Status:          "requires_payment_method",
	}, nil
}

func (f *fakeProvider) CreateRefund(_ context.Context, params RefundParams) (*RefundResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refundCalls = append(f.refundCalls, params)
	if f.refundErr != nil {
		return nil, f.refundErr
	}
	if f.refundResult != nil {
		return f.refundResult, nil
	}
	return &RefundResult{RefundID: "re_fake_" + randomSuffix(), Status: "succeeded"}, nil
}
