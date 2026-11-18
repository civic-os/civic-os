package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/riverqueue/river"
)

type refundRow struct {
	Status       string
	ProviderID   *string
	ErrorMessage *string
	ProcessedAt  *time.Time
}

func loadRefund(t *testing.T, id string) refundRow {
	t.Helper()
	var r refundRow
	err := testPool(t).QueryRow(context.Background(),
		`SELECT status, provider_refund_id, error_message, processed_at
		   FROM payments.refunds WHERE id = $1::uuid`, id).
		Scan(&r.Status, &r.ProviderID, &r.ErrorMessage, &r.ProcessedAt)
	if err != nil {
		t.Fatalf("load refund %s: %v", id, err)
	}
	return r
}

func runRefund(w *RefundWorker, args RefundWorkerArgs) error {
	return w.Work(context.Background(), &river.Job[RefundWorkerArgs]{Args: args})
}

func countRefundNotifications(t *testing.T, userID string) int {
	t.Helper()
	var n int
	err := testPool(t).QueryRow(context.Background(),
		`SELECT count(*) FROM metadata.notifications
		  WHERE user_id = $1::uuid AND template_name = 'payment_refunded'`, userID).Scan(&n)
	if err != nil {
		t.Fatalf("count notifications: %v", err)
	}
	return n
}

func TestRefundWorker_Success(t *testing.T) {
	pool := testPool(t)
	user := newTestUser(t, pool)
	piID := "pi_test_" + randomSuffix()
	txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: piID})
	reason := "Duplicate charge " + randomSuffix()
	refundID := insertRefund(t, pool, txID, user, refundFixture{Amount: "5.00", Reason: reason})

	reID := "re_test_" + randomSuffix()
	prov := &fakeProvider{refundResult: &RefundResult{RefundID: reID, Status: "succeeded"}}
	w := NewRefundWorker(pool, prov)

	before := time.Now().Add(-time.Minute)
	if err := runRefund(w, RefundWorkerArgs{RefundID: refundID, PaymentIntentID: piID, AmountCents: 500}); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if len(prov.refundCalls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(prov.refundCalls))
	}
	want := RefundParams{PaymentIntentID: piID, AmountCents: 500, Reason: reason,
		IdempotencyKey: "civic-os:refund:" + refundID}
	if prov.refundCalls[0] != want {
		t.Errorf("provider params = %+v, want %+v", prov.refundCalls[0], want)
	}

	row := loadRefund(t, refundID)
	if row.Status != "succeeded" {
		t.Errorf("status = %q, want succeeded", row.Status)
	}
	if row.ProviderID == nil || *row.ProviderID != reID {
		t.Errorf("provider_refund_id = %v, want %q", row.ProviderID, reID)
	}
	if row.ErrorMessage != nil {
		t.Errorf("error_message = %q, want NULL", *row.ErrorMessage)
	}
	if row.ProcessedAt == nil || row.ProcessedAt.Before(before) {
		t.Errorf("processed_at = %v, want recent timestamp", row.ProcessedAt)
	}

	// The DB trigger refund_succeeded_notification creates the user's
	// 'payment_refunded' notification when the status flips to succeeded, and
	// that notification's trigger queues the one send_notification job (queue
	// 'notifications'). The worker queues no notification job of its own.
	if n := countRefundNotifications(t, user); n != 1 {
		t.Errorf("payment_refunded notifications = %d, want 1", n)
	}
	var jobs, outsideQueue int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*), count(*) FILTER (WHERE queue <> 'notifications')
		   FROM metadata.river_job WHERE kind = 'send_notification' AND args->>'user_id' = $1`,
		user).Scan(&jobs, &outsideQueue); err != nil {
		t.Fatalf("count send_notification jobs: %v", err)
	}
	if jobs != 1 || outsideQueue != 0 {
		t.Errorf("send_notification jobs = %d (%d outside the notifications queue), want 1 (0)", jobs, outsideQueue)
	}
}

func TestRefundWorker_ProviderErrorMarksFailedAndDoesNotRetry(t *testing.T) {
	pool := testPool(t)
	user := newTestUser(t, pool)
	piID := "pi_test_" + randomSuffix()
	txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: piID})
	refundID := insertRefund(t, pool, txID, user, refundFixture{})

	provErr := errors.New("charge already refunded " + randomSuffix())
	prov := &fakeProvider{refundErr: provErr}
	w := NewRefundWorker(pool, prov)

	// Deliberately nil: Stripe refund errors are treated as permanent, so River must not retry.
	if err := runRefund(w, RefundWorkerArgs{RefundID: refundID, PaymentIntentID: piID, AmountCents: 500}); err != nil {
		t.Fatalf("Work returned %v, want nil (no retry)", err)
	}
	if len(prov.refundCalls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(prov.refundCalls))
	}

	row := loadRefund(t, refundID)
	if row.Status != "failed" {
		t.Errorf("status = %q, want failed", row.Status)
	}
	if row.ErrorMessage == nil || !strings.Contains(*row.ErrorMessage, provErr.Error()) {
		t.Errorf("error_message = %v, want it to contain %q", row.ErrorMessage, provErr.Error())
	}
	if row.ProviderID != nil {
		t.Errorf("provider_refund_id = %q, want NULL", *row.ProviderID)
	}
	if n := countRefundNotifications(t, user); n != 0 {
		t.Errorf("payment_refunded notifications = %d, want 0 on failure", n)
	}
}

func TestRefundWorker_NotFound(t *testing.T) {
	pool := testPool(t)
	prov := &fakeProvider{}
	w := NewRefundWorker(pool, prov)

	err := runRefund(w, RefundWorkerArgs{
		RefundID:        "00000000-0000-4000-8000-" + randomSuffix()[:12],
		PaymentIntentID: "pi_x",
		AmountCents:     100,
	})
	if err == nil || !strings.Contains(err.Error(), "refund not found") {
		t.Fatalf("error = %v, want refund not found", err)
	}
	if len(prov.refundCalls) != 0 {
		t.Errorf("provider called %d times, want 0", len(prov.refundCalls))
	}
}

func TestRefundWorker_SkipsWhenNotPending(t *testing.T) {
	pool := testPool(t)
	for _, status := range []string{"succeeded", "failed"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			user := newTestUser(t, pool)
			txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: "pi_test_" + randomSuffix()})
			refundID := insertRefund(t, pool, txID, user, refundFixture{Status: status})
			prov := &fakeProvider{}
			w := NewRefundWorker(pool, prov)

			if err := runRefund(w, RefundWorkerArgs{RefundID: refundID, PaymentIntentID: "pi_x", AmountCents: 500}); err != nil {
				t.Fatalf("Work: %v", err)
			}
			if len(prov.refundCalls) != 0 {
				t.Errorf("provider called %d times, want 0", len(prov.refundCalls))
			}
			if row := loadRefund(t, refundID); row.Status != status || row.ProviderID != nil {
				t.Errorf("refund modified while skipped: %+v", row)
			}
		})
	}
}

// A NULL transaction description makes enqueueNotification's scan into a Go
// string fail. Work still succeeds (the failure is logged) and the DB trigger
// still creates the notification, so this checks only that the refund is
// unaffected.
func TestRefundWorker_NullTransactionDescription(t *testing.T) {
	pool := testPool(t)
	user := newTestUser(t, pool)
	piID := "pi_test_" + randomSuffix()
	txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: piID})
	if _, err := pool.Exec(context.Background(),
		`UPDATE payments.transactions SET description = NULL WHERE id = $1::uuid`, txID); err != nil {
		t.Fatal(err)
	}
	refundID := insertRefund(t, pool, txID, user, refundFixture{})

	prov := &fakeProvider{}
	w := NewRefundWorker(pool, prov)
	if err := runRefund(w, RefundWorkerArgs{RefundID: refundID, PaymentIntentID: piID, AmountCents: 500}); err != nil {
		t.Fatalf("Work: %v", err)
	}
	if row := loadRefund(t, refundID); row.Status != "succeeded" {
		t.Errorf("status = %q, want succeeded", row.Status)
	}
}
