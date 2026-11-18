package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stripe/stripe-go/v81/webhook"
)

const testWebhookSecret = "whsec_test_secret"

func signedRequest(t *testing.T, method string, payload []byte, secret string) *http.Request {
	t.Helper()
	signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{
		Payload:   payload,
		Secret:    secret,
		Timestamp: time.Now(),
	})
	req := httptest.NewRequest(method, "/webhooks/stripe", strings.NewReader(string(payload)))
	req.Header.Set("Stripe-Signature", signed.Header)
	return req
}

func eventPayload(eventID, eventType, objectJSON string) []byte {
	return []byte(`{"id":"` + eventID + `","object":"event","type":"` + eventType +
		`","data":{"object":` + objectJSON + `}}`)
}

// unreachablePool is a lazily connecting pool whose Begin fails, so the
// processing-failure path runs without a database.
func unreachablePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://u:p@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// The handler is never reached on these paths, so a nil pool is safe.
func TestWebhookHTTPRejectsBeforeProcessing(t *testing.T) {
	s := NewWebhookHTTPServer(NewWebhookHandler(nil), testWebhookSecret, "0")
	payload := eventPayload("evt_test_"+randomSuffix(), "customer.created", `{"id":"cus_x"}`)

	cases := []struct {
		name string
		req  func() *http.Request
		want int
	}{
		{"GET not allowed", func() *http.Request { return signedRequest(t, http.MethodGet, payload, testWebhookSecret) }, http.StatusMethodNotAllowed},
		{"PUT not allowed", func() *http.Request { return signedRequest(t, http.MethodPut, payload, testWebhookSecret) }, http.StatusMethodNotAllowed},
		{"missing signature", func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/webhooks/stripe", strings.NewReader(string(payload)))
		}, http.StatusBadRequest},
		{"garbage signature", func() *http.Request {
			r := httptest.NewRequest(http.MethodPost, "/webhooks/stripe", strings.NewReader(string(payload)))
			r.Header.Set("Stripe-Signature", "t=1,v1=deadbeef")
			return r
		}, http.StatusBadRequest},
		{"wrong secret", func() *http.Request { return signedRequest(t, http.MethodPost, payload, "whsec_other") }, http.StatusBadRequest},
		{"tampered body", func() *http.Request {
			r := signedRequest(t, http.MethodPost, payload, testWebhookSecret)
			r.Body = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(payload)+" ")).Body
			return r
		}, http.StatusBadRequest},
		{"oversized body", func() *http.Request {
			big := []byte(`{"id":"evt_big","pad":"` + strings.Repeat("a", 70000) + `"}`)
			return signedRequest(t, http.MethodPost, big, testWebhookSecret)
		}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			s.HandleStripeWebhook(rec, tc.req())
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d (body %q)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestWebhookHTTPProcessingFailureReturns500(t *testing.T) {
	s := NewWebhookHTTPServer(NewWebhookHandler(unreachablePool(t)), testWebhookSecret, "0")
	payload := eventPayload("evt_test_"+randomSuffix(), "payment_intent.succeeded", `{"id":"pi_x"}`)
	rec := httptest.NewRecorder()
	s.HandleStripeWebhook(rec, signedRequest(t, http.MethodPost, payload, testWebhookSecret))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestWebhookHTTPSuccessUpdatesPayment(t *testing.T) {
	pool := testPool(t)
	s := NewWebhookHTTPServer(NewWebhookHandler(pool), testWebhookSecret, "0")

	user := newTestUser(t, pool)
	piID := "pi_test_" + randomSuffix()
	txID := insertTransaction(t, pool, user, txFixture{Status: "pending", ProviderPaymentID: piID})
	eventID := "evt_test_" + randomSuffix()
	cleanupWebhook(t, pool, eventID)

	payload := eventPayload(eventID, "payment_intent.succeeded", paymentIntentJSON(piID))
	for i := 0; i < 2; i++ { // second delivery is a duplicate and still 200
		rec := httptest.NewRecorder()
		s.HandleStripeWebhook(rec, signedRequest(t, http.MethodPost, payload, testWebhookSecret))
		if rec.Code != http.StatusOK {
			t.Fatalf("delivery %d: status = %d, body %q", i, rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q", ct)
		}
		var body map[string]bool
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !body["received"] {
			t.Errorf("body = %q, want {\"received\":true}", rec.Body.String())
		}
	}
	if got := txStatus(t, pool, txID); got != "succeeded" {
		t.Errorf("status = %q, want succeeded", got)
	}
	if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed {
		t.Errorf("webhook row = %+v", row)
	}
}

func TestWebhookHTTPHandlerErrorReturns500AndRetrySucceeds(t *testing.T) {
	pool := testPool(t)
	s := NewWebhookHTTPServer(NewWebhookHandler(pool), testWebhookSecret, "0")

	eventID := "evt_test_" + randomSuffix()
	cleanupWebhook(t, pool, eventID)

	bad := eventPayload(eventID, "payment_intent.succeeded", `{"id":123}`)
	rec := httptest.NewRecorder()
	s.HandleStripeWebhook(rec, signedRequest(t, http.MethodPost, bad, testWebhookSecret))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if row := webhookRows(t, pool, eventID); row.Count != 1 || row.Processed || row.ErrorMessage == nil {
		t.Errorf("webhook row after 500 = %+v, want unprocessed with error_message", row)
	}

	good := eventPayload(eventID, "payment_intent.succeeded", paymentIntentJSON("pi_orphan_"+randomSuffix()))
	rec = httptest.NewRecorder()
	s.HandleStripeWebhook(rec, signedRequest(t, http.MethodPost, good, testWebhookSecret))
	if rec.Code != http.StatusOK {
		t.Errorf("retry status = %d, want 200", rec.Code)
	}
	if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed || row.ErrorMessage != nil {
		t.Errorf("webhook row after retry = %+v, want processed with error cleared", row)
	}
}

func TestWebhookHealth(t *testing.T) {
	s := NewWebhookHTTPServer(NewWebhookHandler(nil), testWebhookSecret, "0")
	rec := httptest.NewRecorder()
	s.HandleHealth(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["status"] != "healthy" {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestWebhookHTTPRouting(t *testing.T) {
	s := NewWebhookHTTPServer(NewWebhookHandler(nil), testWebhookSecret, "0")
	srv := httptest.NewServer(s.server.Handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("/health = %d", resp.StatusCode)
	}
	resp, err = http.Get(srv.URL + "/webhooks/stripe")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET /webhooks/stripe = %d, want 405", resp.StatusCode)
	}
	resp, err = http.Get(srv.URL + "/nope")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("/nope = %d, want 404", resp.StatusCode)
	}
}
