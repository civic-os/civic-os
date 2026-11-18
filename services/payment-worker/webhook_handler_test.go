package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stripe/stripe-go/v81"
)

// newStripeEvent builds a stripe.Event whose Data.Raw carries the given
// object JSON, the way the handler reads it after signature verification.
func newStripeEvent(id string, eventType stripe.EventType, objectJSON string) stripe.Event {
	return stripe.Event{
		ID:   id,
		Type: eventType,
		Data: &stripe.EventData{Raw: json.RawMessage(objectJSON)},
	}
}

func paymentIntentJSON(id string) string {
	return `{"id":"` + id + `","object":"payment_intent"}`
}

func chargeJSON(chargeID, piID string) string {
	if piID == "" {
		return `{"id":"` + chargeID + `","object":"charge"}`
	}
	return `{"id":"` + chargeID + `","object":"charge","payment_intent":{"id":"` + piID + `"}}`
}

func txStatus(t *testing.T, pool *pgxpool.Pool, txID string) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM payments.transactions WHERE id = $1::uuid`, txID).Scan(&s); err != nil {
		t.Fatalf("read transaction status: %v", err)
	}
	return s
}

func refundStatus(t *testing.T, pool *pgxpool.Pool, refundID string) (status string, processed bool) {
	t.Helper()
	if err := pool.QueryRow(context.Background(),
		`SELECT status, processed_at IS NOT NULL FROM payments.refunds WHERE id = $1::uuid`,
		refundID).Scan(&status, &processed); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	return
}

type webhookRow struct {
	Count        int
	Processed    bool
	EventType    string
	ErrorMessage *string
}

func webhookRows(t *testing.T, pool *pgxpool.Pool, eventID string) webhookRow {
	t.Helper()
	var r webhookRow
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM metadata.webhooks WHERE provider = 'stripe' AND provider_event_id = $1`,
		eventID).Scan(&r.Count); err != nil {
		t.Fatalf("count webhooks: %v", err)
	}
	if r.Count > 0 {
		if err := pool.QueryRow(context.Background(),
			`SELECT processed, event_type, error_message FROM metadata.webhooks WHERE provider = 'stripe' AND provider_event_id = $1`,
			eventID).Scan(&r.Processed, &r.EventType, &r.ErrorMessage); err != nil {
			t.Fatalf("read webhook: %v", err)
		}
	}
	return r
}

func TestWebhookPaymentIntentEventsUpdateStatus(t *testing.T) {
	pool := testPool(t)
	h := NewWebhookHandler(pool)

	cases := []struct {
		name      string
		eventType stripe.EventType
		initial   string
		want      string
	}{
		{"succeeded", "payment_intent.succeeded", "pending", "succeeded"},
		{"failed", "payment_intent.payment_failed", "pending", "failed"},
		{"canceled", "payment_intent.canceled", "pending", "canceled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			user := newTestUser(t, pool)
			piID := "pi_test_" + randomSuffix()
			txID := insertTransaction(t, pool, user, txFixture{Status: tc.initial, ProviderPaymentID: piID})
			eventID := "evt_test_" + randomSuffix()
			cleanupWebhook(t, pool, eventID)

			ev := newStripeEvent(eventID, tc.eventType, paymentIntentJSON(piID))
			if err := h.ProcessStripeWebhook(context.Background(), ev); err != nil {
				t.Fatalf("ProcessStripeWebhook: %v", err)
			}
			if got := txStatus(t, pool, txID); got != tc.want {
				t.Errorf("status = %q, want %q", got, tc.want)
			}
			row := webhookRows(t, pool, eventID)
			if row.Count != 1 || !row.Processed || row.EventType != string(tc.eventType) {
				t.Errorf("webhook row = %+v, want one processed %s row", row, tc.eventType)
			}
		})
	}
}

func TestWebhookDuplicateEventIsIdempotent(t *testing.T) {
	pool := testPool(t)
	h := NewWebhookHandler(pool)
	ctx := context.Background()

	user := newTestUser(t, pool)
	piID := "pi_test_" + randomSuffix()
	txID := insertTransaction(t, pool, user, txFixture{Status: "pending", ProviderPaymentID: piID})
	eventID := "evt_test_" + randomSuffix()
	cleanupWebhook(t, pool, eventID)

	ev := newStripeEvent(eventID, "payment_intent.succeeded", paymentIntentJSON(piID))
	if err := h.ProcessStripeWebhook(ctx, ev); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if got := txStatus(t, pool, txID); got != "succeeded" {
		t.Fatalf("status after first call = %q", got)
	}

	// Move the row to a sentinel state; a reprocessed duplicate would
	// overwrite it with 'succeeded' again.
	if _, err := pool.Exec(ctx,
		`UPDATE payments.transactions SET status = 'failed' WHERE id = $1::uuid`, txID); err != nil {
		t.Fatal(err)
	}
	if err := h.ProcessStripeWebhook(ctx, ev); err != nil {
		t.Fatalf("duplicate call: %v", err)
	}
	if got := txStatus(t, pool, txID); got != "failed" {
		t.Errorf("duplicate event was reprocessed: status = %q, want failed (untouched)", got)
	}
	if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed {
		t.Errorf("webhook row = %+v, want exactly one processed row", row)
	}
}

func TestWebhookUnknownEventTypeMarkedProcessed(t *testing.T) {
	pool := testPool(t)
	h := NewWebhookHandler(pool)

	eventID := "evt_test_" + randomSuffix()
	cleanupWebhook(t, pool, eventID)

	ev := newStripeEvent(eventID, "customer.created", `{"id":"cus_x","object":"customer"}`)
	if err := h.ProcessStripeWebhook(context.Background(), ev); err != nil {
		t.Fatalf("ProcessStripeWebhook: %v", err)
	}
	row := webhookRows(t, pool, eventID)
	if row.Count != 1 || !row.Processed || row.EventType != "customer.created" {
		t.Errorf("webhook row = %+v, want one processed customer.created row", row)
	}
}

func TestWebhookOrphanPaymentIntentIsIgnored(t *testing.T) {
	pool := testPool(t)
	h := NewWebhookHandler(pool)

	for _, et := range []stripe.EventType{
		"payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled",
	} {
		t.Run(string(et), func(t *testing.T) {
			t.Parallel()
			// A transaction with a different PaymentIntent must stay untouched.
			user := newTestUser(t, pool)
			otherTx := insertTransaction(t, pool, user, txFixture{Status: "pending", ProviderPaymentID: "pi_test_" + randomSuffix()})
			eventID := "evt_test_" + randomSuffix()
			cleanupWebhook(t, pool, eventID)

			ev := newStripeEvent(eventID, et, paymentIntentJSON("pi_orphan_"+randomSuffix()))
			if err := h.ProcessStripeWebhook(context.Background(), ev); err != nil {
				t.Fatalf("orphan event should succeed (no Stripe retry): %v", err)
			}
			if got := txStatus(t, pool, otherTx); got != "pending" {
				t.Errorf("unrelated transaction changed to %q", got)
			}
			if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed {
				t.Errorf("webhook row = %+v, want one processed row", row)
			}
		})
	}
}

func TestWebhookChargeRefunded(t *testing.T) {
	pool := testPool(t)
	h := NewWebhookHandler(pool)
	ctx := context.Background()

	t.Run("pending refund becomes succeeded", func(t *testing.T) {
		t.Parallel()
		user := newTestUser(t, pool)
		piID := "pi_test_" + randomSuffix()
		txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: piID})
		pending := insertRefund(t, pool, txID, user, refundFixture{Status: "pending"})
		failed := insertRefund(t, pool, txID, user, refundFixture{Status: "failed", Amount: "1.00"})
		eventID := "evt_test_" + randomSuffix()
		cleanupWebhook(t, pool, eventID)

		ev := newStripeEvent(eventID, "charge.refunded", chargeJSON("ch_test_"+randomSuffix(), piID))
		if err := h.ProcessStripeWebhook(ctx, ev); err != nil {
			t.Fatalf("ProcessStripeWebhook: %v", err)
		}
		if st, processed := refundStatus(t, pool, pending); st != "succeeded" || !processed {
			t.Errorf("pending refund = (%s, processed_at set=%v), want (succeeded, true)", st, processed)
		}
		if st, _ := refundStatus(t, pool, failed); st != "failed" {
			t.Errorf("non-pending refund changed to %q", st)
		}
		if got := txStatus(t, pool, txID); got != "succeeded" {
			t.Errorf("transaction status = %q, want unchanged succeeded", got)
		}
		if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed {
			t.Errorf("webhook row = %+v", row)
		}
	})

	t.Run("existing processed_at is preserved", func(t *testing.T) {
		t.Parallel()
		user := newTestUser(t, pool)
		piID := "pi_test_" + randomSuffix()
		txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: piID})
		refundID := insertRefund(t, pool, txID, user, refundFixture{Status: "pending"})
		if _, err := pool.Exec(ctx,
			`UPDATE payments.refunds SET processed_at = '2020-01-01T00:00:00Z' WHERE id = $1::uuid`, refundID); err != nil {
			t.Fatal(err)
		}
		eventID := "evt_test_" + randomSuffix()
		cleanupWebhook(t, pool, eventID)

		ev := newStripeEvent(eventID, "charge.refunded", chargeJSON("ch_test_"+randomSuffix(), piID))
		if err := h.ProcessStripeWebhook(ctx, ev); err != nil {
			t.Fatalf("ProcessStripeWebhook: %v", err)
		}
		var year int
		if err := pool.QueryRow(ctx,
			`SELECT extract(year FROM processed_at)::int FROM payments.refunds WHERE id = $1::uuid`,
			refundID).Scan(&year); err != nil {
			t.Fatal(err)
		}
		if year != 2020 {
			t.Errorf("processed_at year = %d, want 2020 (COALESCE keeps existing)", year)
		}
	})

	t.Run("charge without payment_intent is skipped", func(t *testing.T) {
		t.Parallel()
		user := newTestUser(t, pool)
		txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: "pi_test_" + randomSuffix()})
		refundID := insertRefund(t, pool, txID, user, refundFixture{Status: "pending"})
		eventID := "evt_test_" + randomSuffix()
		cleanupWebhook(t, pool, eventID)

		ev := newStripeEvent(eventID, "charge.refunded", chargeJSON("ch_test_"+randomSuffix(), ""))
		if err := h.ProcessStripeWebhook(ctx, ev); err != nil {
			t.Fatalf("ProcessStripeWebhook: %v", err)
		}
		if st, _ := refundStatus(t, pool, refundID); st != "pending" {
			t.Errorf("refund = %q, want pending (event had no payment_intent)", st)
		}
		if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed {
			t.Errorf("webhook row = %+v", row)
		}
	})

	t.Run("unknown payment_intent is a no-op success", func(t *testing.T) {
		t.Parallel()
		eventID := "evt_test_" + randomSuffix()
		cleanupWebhook(t, pool, eventID)
		ev := newStripeEvent(eventID, "charge.refunded", chargeJSON("ch_test_"+randomSuffix(), "pi_orphan_"+randomSuffix()))
		if err := h.ProcessStripeWebhook(ctx, ev); err != nil {
			t.Fatalf("ProcessStripeWebhook: %v", err)
		}
		if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed {
			t.Errorf("webhook row = %+v", row)
		}
	})
}

// A handler error rolls the handler's work back but keeps the error on an
// unprocessed webhook row, so operators can see it and Stripe's retry still
// reprocesses the event, clearing the error once it succeeds.
func TestWebhookHandlerErrorRecordedAndRetryReprocesses(t *testing.T) {
	pool := testPool(t)
	h := NewWebhookHandler(pool)
	ctx := context.Background()

	routed := []struct {
		name      string
		eventType stripe.EventType
		badRaw    string
	}{
		{"succeeded", "payment_intent.succeeded", `{"id":123}`},
		{"failed", "payment_intent.payment_failed", `{"id":123}`},
		{"canceled", "payment_intent.canceled", `{"id":123}`},
		{"refunded", "charge.refunded", `{"id":123}`},
	}
	for _, tc := range routed {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			eventID := "evt_test_" + randomSuffix()
			cleanupWebhook(t, pool, eventID)

			bad := newStripeEvent(eventID, tc.eventType, tc.badRaw)
			if err := h.ProcessStripeWebhook(ctx, bad); err == nil {
				t.Fatal("expected error for malformed event object")
			}
			row := webhookRows(t, pool, eventID)
			if row.Count != 1 || row.Processed || row.ErrorMessage == nil || *row.ErrorMessage == "" {
				t.Fatalf("webhook row = %+v, want one unprocessed row with error_message", row)
			}
		})
	}

	t.Run("retry with good payload is processed", func(t *testing.T) {
		t.Parallel()
		user := newTestUser(t, pool)
		piID := "pi_test_" + randomSuffix()
		txID := insertTransaction(t, pool, user, txFixture{Status: "pending", ProviderPaymentID: piID})
		eventID := "evt_test_" + randomSuffix()
		cleanupWebhook(t, pool, eventID)

		if err := h.ProcessStripeWebhook(ctx, newStripeEvent(eventID, "payment_intent.succeeded", `{"id":123}`)); err == nil {
			t.Fatal("expected error on first delivery")
		}
		if got := txStatus(t, pool, txID); got != "pending" {
			t.Errorf("status after failed delivery = %q, want pending (rolled back)", got)
		}
		good := newStripeEvent(eventID, "payment_intent.succeeded", paymentIntentJSON(piID))
		if err := h.ProcessStripeWebhook(ctx, good); err != nil {
			t.Fatalf("retry: %v", err)
		}
		if got := txStatus(t, pool, txID); got != "succeeded" {
			t.Errorf("status after retry = %q, want succeeded", got)
		}
		if row := webhookRows(t, pool, eventID); row.Count != 1 || !row.Processed || row.ErrorMessage != nil {
			t.Errorf("webhook row = %+v, want processed with error cleared", row)
		}
		// A further delivery of the processed event is a duplicate.
		if err := h.ProcessStripeWebhook(ctx, good); err != nil {
			t.Fatalf("duplicate after success: %v", err)
		}
	})
}

func TestWebhookBeginFailureReturnsError(t *testing.T) {
	// Lazy pool pointing at a closed port: Begin fails without any database.
	pool, err := pgxpool.New(context.Background(), "postgres://u:p@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	h := NewWebhookHandler(pool)
	ev := newStripeEvent("evt_test_"+randomSuffix(), "payment_intent.succeeded", paymentIntentJSON("pi_x"))
	if err := h.ProcessStripeWebhook(context.Background(), ev); err == nil {
		t.Fatal("expected begin-transaction error")
	}
}
