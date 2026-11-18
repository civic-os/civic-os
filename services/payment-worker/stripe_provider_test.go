package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/stripe/stripe-go/v81"
)

// stripeRecordedRequest captures one request seen by the fake Stripe server.
type stripeRecordedRequest struct {
	Method         string
	Path           string
	Form           url.Values
	IdempotencyKey string
}

// stripeFakeServer is an httptest server that records requests and replies
// with a canned status and JSON body.
type stripeFakeServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []stripeRecordedRequest
}

func (f *stripeFakeServer) recorded() []stripeRecordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]stripeRecordedRequest(nil), f.requests...)
}

// newStripeFake starts a fake server and points the stripe-go global backend
// and key at it. Globals are restored on cleanup, so callers must not use
// t.Parallel.
func newStripeFake(t *testing.T, status int, body string) *stripeFakeServer {
	t.Helper()
	f := &stripeFakeServer{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.requests = append(f.requests, stripeRecordedRequest{
			Method: r.Method, Path: r.URL.Path, Form: r.PostForm,
			IdempotencyKey: r.Header.Get("Idempotency-Key"),
		})
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))

	prevBackend := stripe.GetBackend(stripe.APIBackend)
	prevKey := stripe.Key
	stripe.Key = "sk_test_unit_test_key_1234"
	stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
		URL:               stripe.String(f.Server.URL),
		LeveledLogger:     &stripe.LeveledLogger{Level: stripe.LevelNull},
		MaxNetworkRetries: stripe.Int64(0),
	}))
	t.Cleanup(func() {
		stripe.SetBackend(stripe.APIBackend, prevBackend)
		stripe.Key = prevKey
		f.Server.Close()
	})
	return f
}

const stripeIntentOK = `{"id":"pi_123","object":"payment_intent","client_secret":"pi_123_secret_x","status":"requires_payment_method"}`
const stripeRefundOK = `{"id":"re_123","object":"refund","status":"succeeded"}`
const stripeCardError = `{"error":{"type":"card_error","code":"card_declined","message":"Your card was declined."}}`

func TestStripeCreateIntent_Success(t *testing.T) {
	f := newStripeFake(t, http.StatusOK, stripeIntentOK)
	p := &StripeProvider{apiKey: "k"}

	res, err := p.CreateIntent(context.Background(), CreateIntentParams{Amount: 1050, Currency: "usd", Description: "Room rental",
		Metadata: map[string]string{"civic_os_transaction_id": "tx-1", "civic_os_fee_cents": "0"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.PaymentIntentID != "pi_123" || res.ClientSecret != "pi_123_secret_x" || res.Status != "requires_payment_method" {
		t.Errorf("unexpected result: %+v", res)
	}

	reqs := f.recorded()
	if len(reqs) != 1 {
		t.Fatalf("expected 1 request, got %d", len(reqs))
	}
	r := reqs[0]
	if r.Method != http.MethodPost || r.Path != "/v1/payment_intents" {
		t.Errorf("unexpected request: %s %s", r.Method, r.Path)
	}
	want := map[string]string{
		"amount":                             "1050",
		"currency":                           "usd",
		"description":                        "Room rental",
		"capture_method":                     "automatic",
		"automatic_payment_methods[enabled]": "true",
		"metadata[civic_os_transaction_id]":  "tx-1",
		"metadata[civic_os_fee_cents]":       "0",
	}
	for k, v := range want {
		if got := r.Form.Get(k); got != v {
			t.Errorf("form[%s] = %q, want %q", k, got, v)
		}
	}
}

func TestStripeCreateIntent_CurrencySentAsGiven(t *testing.T) {
	f := newStripeFake(t, http.StatusOK, stripeIntentOK)
	p := &StripeProvider{}

	// The adapter does not normalize casing; document that behavior.
	if _, err := p.CreateIntent(context.Background(), CreateIntentParams{Amount: 100, Currency: "EUR"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := f.recorded()[0].Form.Get("currency"); got != "EUR" {
		t.Errorf("currency = %q, want it passed through unchanged as EUR", got)
	}
}

func TestStripeCreateIntent_DefaultCurrencyUSD(t *testing.T) {
	f := newStripeFake(t, http.StatusOK, stripeIntentOK)
	p := &StripeProvider{}

	if _, err := p.CreateIntent(context.Background(), CreateIntentParams{Amount: 100}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := f.recorded()[0].Form.Get("currency"); got != "usd" {
		t.Errorf("currency = %q, want usd default", got)
	}
}

func TestStripeCreateIntent_InvalidAmount(t *testing.T) {
	for _, amount := range []int64{0, -1, -1000} {
		f := newStripeFake(t, http.StatusOK, stripeIntentOK)
		p := &StripeProvider{}
		res, err := p.CreateIntent(context.Background(), CreateIntentParams{Amount: amount, Currency: "usd"})
		if err == nil || res != nil {
			t.Errorf("amount %d: expected error and nil result, got res=%v err=%v", amount, res, err)
		}
		if n := len(f.recorded()); n != 0 {
			t.Errorf("amount %d: expected no request, got %d", amount, n)
		}
	}
}

func TestStripeCreateIntent_APIError(t *testing.T) {
	f := newStripeFake(t, http.StatusPaymentRequired, stripeCardError)
	p := &StripeProvider{}

	res, err := p.CreateIntent(context.Background(), CreateIntentParams{Amount: 500, Currency: "usd"})
	if err == nil {
		t.Fatal("expected error")
	}
	if res != nil {
		t.Errorf("expected nil result, got %+v", res)
	}
	if !strings.Contains(err.Error(), "stripe API error") || !strings.Contains(err.Error(), "Your card was declined.") {
		t.Errorf("error should wrap Stripe message, got %q", err.Error())
	}
	var se *stripe.Error
	if !errorsAs(err, &se) || se.Type != stripe.ErrorTypeCard {
		t.Errorf("expected wrapped *stripe.Error of type card_error, got %v", err)
	}
	if len(f.recorded()) != 1 {
		t.Errorf("expected exactly 1 request, got %d", len(f.recorded()))
	}
}

func TestStripeCreateRefund_Validation(t *testing.T) {
	cases := []struct {
		name   string
		params RefundParams
	}{
		{"empty payment intent", RefundParams{PaymentIntentID: "", AmountCents: 500}},
		{"zero amount", RefundParams{PaymentIntentID: "pi_1", AmountCents: 0}},
		{"negative amount", RefundParams{PaymentIntentID: "pi_1", AmountCents: -5}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newStripeFake(t, http.StatusOK, stripeRefundOK)
			p := &StripeProvider{}
			res, err := p.CreateRefund(context.Background(), tc.params)
			if err == nil || res != nil {
				t.Errorf("expected error and nil result, got res=%v err=%v", res, err)
			}
			if n := len(f.recorded()); n != 0 {
				t.Errorf("expected no request, got %d", n)
			}
		})
	}
}

func TestStripeCreateRefund_SuccessWithReason(t *testing.T) {
	f := newStripeFake(t, http.StatusOK, stripeRefundOK)
	p := &StripeProvider{}

	res, err := p.CreateRefund(context.Background(), RefundParams{PaymentIntentID: "pi_abc", AmountCents: 750, Reason: "Event canceled by venue",
		Metadata: map[string]string{"civic_os_refund_id": "rf-1", "civic_os_instance": "springfield"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.RefundID != "re_123" || res.Status != "succeeded" {
		t.Errorf("unexpected result: %+v", res)
	}
	reqs := f.recorded()
	if len(reqs) != 1 {
		t.Fatalf("expected 1 request, got %d", len(reqs))
	}
	r := reqs[0]
	if r.Method != http.MethodPost || r.Path != "/v1/refunds" {
		t.Errorf("unexpected request: %s %s", r.Method, r.Path)
	}
	want := map[string]string{
		"payment_intent":               "pi_abc",
		"amount":                       "750",
		"reason":                       "requested_by_customer",
		"metadata[reason]":             "Event canceled by venue",
		"metadata[civic_os_refund_id]": "rf-1",
		"metadata[civic_os_instance]":  "springfield",
	}
	for k, v := range want {
		if got := r.Form.Get(k); got != v {
			t.Errorf("form[%s] = %q, want %q", k, got, v)
		}
	}
}

func TestStripeCreateRefund_NoReason(t *testing.T) {
	f := newStripeFake(t, http.StatusOK, stripeRefundOK)
	p := &StripeProvider{}

	if _, err := p.CreateRefund(context.Background(), RefundParams{PaymentIntentID: "pi_abc", AmountCents: 100}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r := f.recorded()[0]
	if r.Form.Get("payment_intent") != "pi_abc" || r.Form.Get("amount") != "100" {
		t.Errorf("missing core fields: %v", r.Form)
	}
	for k := range r.Form {
		if strings.HasPrefix(k, "metadata[") {
			t.Errorf("form has %s with no reason and no metadata", k)
		}
	}
	if _, ok := r.Form["reason"]; ok {
		t.Errorf("reason should not be sent: %v", r.Form)
	}
	if _, ok := r.Form["metadata[reason]"]; ok {
		t.Errorf("metadata[reason] should not be sent: %v", r.Form)
	}
}

func TestStripeCreateRefund_APIError(t *testing.T) {
	f := newStripeFake(t, http.StatusBadRequest,
		`{"error":{"type":"invalid_request_error","code":"charge_already_refunded","message":"Charge has already been refunded."}}`)
	p := &StripeProvider{}

	res, err := p.CreateRefund(context.Background(), RefundParams{PaymentIntentID: "pi_abc", AmountCents: 100})
	if err == nil || res != nil {
		t.Fatalf("expected error and nil result, got res=%v err=%v", res, err)
	}
	if !strings.Contains(err.Error(), "stripe API error") || !strings.Contains(err.Error(), "already been refunded") {
		t.Errorf("unexpected error text: %q", err.Error())
	}
	if len(f.recorded()) != 1 {
		t.Errorf("expected exactly 1 request, got %d", len(f.recorded()))
	}
}

func TestStripeNewProvider_SetsKey(t *testing.T) {
	prev := stripe.Key
	t.Cleanup(func() { stripe.Key = prev })

	p := NewStripeProvider("sk_test_abcdefghijklmnop")
	if p == nil || p.apiKey != "sk_test_abcdefghijklmnop" {
		t.Fatalf("unexpected provider: %+v", p)
	}
	if stripe.Key != "sk_test_abcdefghijklmnop" {
		t.Errorf("stripe.Key not set, got %q", stripe.Key)
	}
}

// Re-exec the test binary: NewStripeProvider("") calls log.Fatal, which exits.
func TestStripeNewProvider_EmptyKeyExits(t *testing.T) {
	if os.Getenv("STRIPE_TEST_EMPTY_KEY_CHILD") == "1" {
		NewStripeProvider("")
		return // not reached
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestStripeNewProvider_EmptyKeyExits$")
	cmd.Env = append(os.Environ(), "STRIPE_TEST_EMPTY_KEY_CHILD=1")
	out, err := cmd.CombinedOutput()
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() == 0 {
		t.Fatalf("expected non-zero exit, got err=%v output=%s", err, out)
	}
	if !strings.Contains(string(out), "STRIPE_API_KEY is required") {
		t.Errorf("expected fatal message, got %s", out)
	}
}

func TestMaskAPIKey(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "***"},
		{"short", "***"},
		{"1234567890", "***"},             // length 10: boundary
		{"12345678901", "1234567...8901"}, // length 11: boundary
		{"sk_test_abcdefghijklmnop", "sk_test...mnop"},
	}
	for _, tc := range cases {
		if got := maskAPIKey(tc.in); got != tc.want {
			t.Errorf("maskAPIKey(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestMaskSecret(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "***"},
		{"abc", "***"},
		{"123456789012345", "***"},              // length 15: boundary
		{"1234567890123456", "123456789012..."}, // length 16: boundary
		{"pi_123_secret_abcdef", "pi_123_secre..."},
	}
	for _, tc := range cases {
		if got := maskSecret(tc.in); got != tc.want {
			t.Errorf("maskSecret(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Compile-time check that StripeProvider satisfies the interface.
var _ PaymentProvider = (*StripeProvider)(nil)

// errorsAs avoids importing errors under a name that could collide with other
// test files' helpers.
func errorsAs(err error, target **stripe.Error) bool {
	for err != nil {
		if se, ok := err.(*stripe.Error); ok {
			*target = se
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// stripe-go sends a random Idempotency-Key on every POST, which only covers
// its own network retries. The workers pass a key derived from the row id so
// that a River retry of the same job reuses it and Stripe returns the
// original object instead of creating a second one.
func TestStripeIdempotencyKeyIsSent(t *testing.T) {
	t.Run("create intent", func(t *testing.T) {
		f := newStripeFake(t, http.StatusOK, stripeIntentOK)
		p := &StripeProvider{}
		params := CreateIntentParams{Amount: 100, Currency: "usd", IdempotencyKey: "civic-os:create-intent:abc"}
		if _, err := p.CreateIntent(context.Background(), params); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got := f.recorded()[0].IdempotencyKey; got != params.IdempotencyKey {
			t.Errorf("Idempotency-Key = %q, want %q", got, params.IdempotencyKey)
		}
	})
	t.Run("refund", func(t *testing.T) {
		f := newStripeFake(t, http.StatusOK, stripeRefundOK)
		p := &StripeProvider{}
		params := RefundParams{PaymentIntentID: "pi_abc", AmountCents: 100, IdempotencyKey: "civic-os:refund:abc"}
		if _, err := p.CreateRefund(context.Background(), params); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got := f.recorded()[0].IdempotencyKey; got != params.IdempotencyKey {
			t.Errorf("Idempotency-Key = %q, want %q", got, params.IdempotencyKey)
		}
	})
}
