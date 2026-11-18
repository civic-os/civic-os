package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Database-backed tests run against a migrated Civic OS database named by
// PAYMENT_TEST_DATABASE_URL and skip when it is unset, so `go test ./...`
// stays runnable without Postgres. Each test creates its own user and rows
// with unique ids and deletes them in t.Cleanup, so tests can share one
// database and run in parallel.

const testDBEnv = "PAYMENT_TEST_DATABASE_URL"

var (
	sharedPoolOnce sync.Once
	sharedPool     *pgxpool.Pool
	sharedPoolErr  error
)

// randomSuffix returns 16 hex characters for unique test identifiers.
func randomSuffix() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// testPool returns a pool shared by every test in the package, or skips the
// test when no test database is configured.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv(testDBEnv)
	if url == "" {
		t.Skipf("%s not set; skipping database test", testDBEnv)
	}
	sharedPoolOnce.Do(func() {
		ctx := context.Background()
		sharedPool, sharedPoolErr = pgxpool.New(ctx, url)
		if sharedPoolErr == nil {
			sharedPoolErr = sharedPool.Ping(ctx)
		}
	})
	if sharedPoolErr != nil {
		t.Fatalf("connect to test database: %v", sharedPoolErr)
	}
	return sharedPool
}

// newTestUser inserts a civic_os_users row and registers a cleanup that
// removes everything the test created for that user: River jobs (create-intent
// jobs keyed by payment_id, notification jobs keyed by notification_id, and
// the refund worker's send_notification jobs keyed by user_id), refunds,
// transactions, and the user itself (notifications cascade).
func newTestUser(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var userID string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO metadata.civic_os_users (id, display_name)
		 VALUES (gen_random_uuid(), $1) RETURNING id::text`,
		"payment-test-"+randomSuffix(),
	).Scan(&userID)
	if err != nil {
		t.Fatalf("insert test user: %v", err)
	}

	t.Cleanup(func() {
		ctx := context.Background()
		stmts := []string{
			`DELETE FROM metadata.river_job
			  WHERE args->>'user_id' = $1
			     OR args->>'payment_id' IN (SELECT id::text FROM payments.transactions WHERE user_id = $1::uuid)
			     OR args->>'notification_id' IN (SELECT id::text FROM metadata.notifications WHERE user_id = $1::uuid)`,
			`DELETE FROM payments.refunds
			  WHERE initiated_by = $1::uuid
			     OR transaction_id IN (SELECT id FROM payments.transactions WHERE user_id = $1::uuid)`,
			`DELETE FROM payments.transactions WHERE user_id = $1::uuid`,
			`DELETE FROM metadata.civic_os_users WHERE id = $1::uuid`,
		}
		for _, s := range stmts {
			if _, err := pool.Exec(ctx, s, userID); err != nil {
				t.Errorf("cleanup for user %s: %v", userID, err)
			}
		}
	})
	return userID
}

// txFixture describes a payments.transactions row. Amount is a decimal
// string so fixtures never pass through float64.
type txFixture struct {
	Amount            string // default "10.00"
	Currency          string // default "USD"
	Status            string // default "pending_intent"
	Description       string // default "Test payment"
	ProviderPaymentID string // optional
}

// insertTransaction inserts a transaction owned by userID and returns its id.
// Cleanup is handled by newTestUser. Inserting with status pending_intent
// fires enqueue_create_intent_job_trigger, which queues a create_payment_intent
// River job; that job is deleted in cleanup too.
func insertTransaction(t *testing.T, pool *pgxpool.Pool, userID string, f txFixture) string {
	t.Helper()
	if f.Amount == "" {
		f.Amount = "10.00"
	}
	if f.Currency == "" {
		f.Currency = "USD"
	}
	if f.Status == "" {
		f.Status = "pending_intent"
	}
	if f.Description == "" {
		f.Description = "Test payment"
	}
	var providerID *string
	if f.ProviderPaymentID != "" {
		providerID = &f.ProviderPaymentID
	}
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO payments.transactions (user_id, amount, currency, status, description, provider_payment_id)
		 VALUES ($1::uuid, $2::numeric, $3, $4, $5, $6) RETURNING id::text`,
		userID, f.Amount, f.Currency, f.Status, f.Description, providerID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert transaction: %v", err)
	}
	return id
}

// refundFixture describes a payments.refunds row.
type refundFixture struct {
	Amount string // default "5.00"
	Reason string // default "Customer requested refund" (>= 10 chars)
	Status string // default "pending"
}

// insertRefund inserts a refund on transactionID, initiated by initiatedBy,
// and returns its id. Cleanup is handled by newTestUser.
func insertRefund(t *testing.T, pool *pgxpool.Pool, transactionID, initiatedBy string, f refundFixture) string {
	t.Helper()
	if f.Amount == "" {
		f.Amount = "5.00"
	}
	if f.Reason == "" {
		f.Reason = "Customer requested refund"
	}
	if f.Status == "" {
		f.Status = "pending"
	}
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO payments.refunds (transaction_id, amount, reason, initiated_by, status)
		 VALUES ($1::uuid, $2::numeric, $3, $4::uuid, $5) RETURNING id::text`,
		transactionID, f.Amount, f.Reason, initiatedBy, f.Status,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert refund: %v", err)
	}
	return id
}

// cleanupWebhook deletes the metadata.webhooks row for a provider event id
// when the test ends.
func cleanupWebhook(t *testing.T, pool *pgxpool.Pool, eventID string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM metadata.webhooks WHERE provider_event_id = $1`, eventID); err != nil {
			t.Errorf("cleanup webhook %s: %v", eventID, err)
		}
	})
}

// TestHarnessFixtures checks the fixtures themselves against the schema.
func TestHarnessFixtures(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	user := newTestUser(t, pool)
	txID := insertTransaction(t, pool, user, txFixture{Status: "succeeded", ProviderPaymentID: "pi_test_" + randomSuffix()})
	refundID := insertRefund(t, pool, txID, user, refundFixture{})

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM payments.refunds WHERE id = $1::uuid AND transaction_id = $2::uuid`,
		refundID, txID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("refund fixture not found: n=%d err=%v", n, err)
	}

	pendingID := insertTransaction(t, pool, user, txFixture{})
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM metadata.river_job WHERE kind = 'create_payment_intent' AND args->>'payment_id' = $1`,
		pendingID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("expected one create_payment_intent job for pending_intent insert: n=%d err=%v", n, err)
	}
}
