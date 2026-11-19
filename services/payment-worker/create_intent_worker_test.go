package main

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/riverqueue/river"
)

// txRow is the subset of payments.transactions the create-intent tests assert on.
type txRow struct {
	Status        string
	ProcessingFee string
	FeePercent    *float64
	FeeFlatCents  *int
	FeeRefundable bool
	ProviderID    *string
	ClientSecret  *string
	ErrorMessage  *string
}

func loadTx(t *testing.T, id string) txRow {
	t.Helper()
	pool := testPool(t)
	var r txRow
	err := pool.QueryRow(context.Background(),
		`SELECT status, processing_fee::text, fee_percent::float8, fee_flat_cents, fee_refundable,
		        provider_payment_id, provider_client_secret, error_message
		   FROM payments.transactions WHERE id = $1::uuid`, id).
		Scan(&r.Status, &r.ProcessingFee, &r.FeePercent, &r.FeeFlatCents, &r.FeeRefundable,
			&r.ProviderID, &r.ClientSecret, &r.ErrorMessage)
	if err != nil {
		t.Fatalf("load transaction %s: %v", id, err)
	}
	return r
}

func runCreateIntent(w *CreateIntentWorker, paymentID string) error {
	return w.Work(context.Background(), &river.Job[CreateIntentWorkerArgs]{
		Args: CreateIntentWorkerArgs{PaymentID: paymentID},
	})
}

func TestCreateIntentWorker_Success(t *testing.T) {
	pool := testPool(t)

	tests := []struct {
		name        string
		amount      string
		fee         FeeConfig
		wantCents   int64
		wantFee     string
		wantPercent *float64
		wantFlat    *int
		wantRefund  bool
	}{
		{
			name:       "fees disabled sends base amount and stores NULL fee config",
			amount:     "10.00",
			fee:        FeeConfig{Enabled: false, Percent: 2.9, FlatCents: 30},
			wantCents:  1000,
			wantFee:    "0.00",
			wantRefund: false,
		},
		{
			name:       "fees disabled keeps the refundable flag",
			amount:     "10.00",
			fee:        FeeConfig{Enabled: false, Refundable: true},
			wantCents:  1000,
			wantFee:    "0.00",
			wantRefund: true,
		},
		{
			name:        "percent plus flat fee is grossed up and added to the charge",
			amount:      "10.00",
			fee:         FeeConfig{Enabled: true, Percent: 2.9, FlatCents: 30},
			wantCents:   1061, // base 1000 + ceil((1000+30)/0.971 - 1000) = 61
			wantFee:     "0.61",
			wantPercent: ptr(2.9),
			wantFlat:    ptr(30),
		},
		{
			name:        "fractional dollars with refundable fee",
			amount:      "25.50",
			fee:         FeeConfig{Enabled: true, Percent: 2.9, FlatCents: 30, Refundable: true},
			wantCents:   2658, // base 2550 + 108
			wantFee:     "1.08",
			wantPercent: ptr(2.9),
			wantFlat:    ptr(30),
			wantRefund:  true,
		},
		{
			name:        "percent only",
			amount:      "10.00",
			fee:         FeeConfig{Enabled: true, Percent: 2.5},
			wantCents:   1026, // base 1000 + ceil(1000/0.975 - 1000) = 26
			wantFee:     "0.26",
			wantPercent: ptr(2.5),
			wantFlat:    ptr(0),
		},
		{
			name:        "flat only",
			amount:      "10.00",
			fee:         FeeConfig{Enabled: true, FlatCents: 30},
			wantCents:   1030,
			wantFee:     "0.30",
			wantPercent: ptr(0.0),
			wantFlat:    ptr(30),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			user := newTestUser(t, pool)
			desc := "Permit fee " + randomSuffix()
			entityID := randomSuffix()
			id := insertTransaction(t, pool, user, txFixture{Amount: tt.amount, Description: desc,
				EntityType: "permits", EntityID: entityID})

			piID := "pi_test_" + randomSuffix()
			secret := "secret_" + randomSuffix()
			prov := &fakeProvider{intentResult: &PaymentIntentResult{PaymentIntentID: piID, ClientSecret: secret}}
			fee := tt.fee
			w := NewCreateIntentWorker(pool, prov, &fee, metadataSettings{InstanceKey: "test-instance", SiteURL: "https://civic.example.org"})

			if err := runCreateIntent(w, id); err != nil {
				t.Fatalf("Work: %v", err)
			}

			if len(prov.intentCalls) != 1 {
				t.Fatalf("provider calls = %d, want 1", len(prov.intentCalls))
			}
			got := prov.intentCalls[0]
			feeCents := decimalCents(t, tt.wantFee)
			want := CreateIntentParams{Amount: tt.wantCents, Currency: "USD", Description: desc,
				IdempotencyKey: "civic-os:create-intent:" + id,
				Metadata: map[string]string{
					"civic_os_transaction_id": id,
					"civic_os_entity_type":    "permits",
					"civic_os_entity_id":      entityID,
					"civic_os_instance":       "test-instance",
					"civic_os_record_url":     "https://civic.example.org/view/permits/" + entityID,
					"civic_os_base_cents":     strconv.FormatInt(tt.wantCents-feeCents, 10),
					"civic_os_fee_cents":      strconv.FormatInt(feeCents, 10),
				}}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("provider params = %+v, want %+v", got, want)
			}

			row := loadTx(t, id)
			if row.Status != "pending" {
				t.Errorf("status = %q, want pending", row.Status)
			}
			if row.ProviderID == nil || *row.ProviderID != piID {
				t.Errorf("provider_payment_id = %v, want %q", row.ProviderID, piID)
			}
			if row.ClientSecret == nil || *row.ClientSecret != secret {
				t.Errorf("provider_client_secret = %v, want %q", row.ClientSecret, secret)
			}
			if row.ErrorMessage != nil {
				t.Errorf("error_message = %q, want NULL", *row.ErrorMessage)
			}
			if row.ProcessingFee != tt.wantFee {
				t.Errorf("processing_fee = %s, want %s", row.ProcessingFee, tt.wantFee)
			}
			if row.FeeRefundable != tt.wantRefund {
				t.Errorf("fee_refundable = %v, want %v", row.FeeRefundable, tt.wantRefund)
			}
			if !floatPtrEq(row.FeePercent, tt.wantPercent) {
				t.Errorf("fee_percent = %v, want %v", derefF(row.FeePercent), derefF(tt.wantPercent))
			}
			if (row.FeeFlatCents == nil) != (tt.wantFlat == nil) ||
				(row.FeeFlatCents != nil && *row.FeeFlatCents != *tt.wantFlat) {
				t.Errorf("fee_flat_cents = %v, want %v", row.FeeFlatCents, tt.wantFlat)
			}
		})
	}
}

// A row inserted without payments.create_and_link_payment() has no entity, and
// an instance without PAYMENT_INSTANCE_KEY has no instance name: those keys are
// left out, never sent as "" (which Stripe reads as "delete this key").
func TestCreateIntentWorker_MetadataOmitsMissingValues(t *testing.T) {
	pool := testPool(t)
	user := newTestUser(t, pool)
	id := insertTransaction(t, pool, user, txFixture{Amount: "12.34"})
	prov := &fakeProvider{}
	// SITE_URL is set, but with a NULL entity there is no record to link to.
	w := NewCreateIntentWorker(pool, prov, &FeeConfig{}, metadataSettings{SiteURL: "https://civic.example.org"})
	if err := runCreateIntent(w, id); err != nil {
		t.Fatalf("Work: %v", err)
	}
	if len(prov.intentCalls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(prov.intentCalls))
	}
	want := map[string]string{
		"civic_os_transaction_id": id,
		"civic_os_base_cents":     "1234",
		"civic_os_fee_cents":      "0",
	}
	if got := prov.intentCalls[0].Metadata; !reflect.DeepEqual(got, want) {
		t.Errorf("metadata = %v, want %v", got, want)
	}
}

func TestCreateIntentWorker_NullDescriptionSendsEmptyString(t *testing.T) {
	pool := testPool(t)
	user := newTestUser(t, pool)
	id := insertTransaction(t, pool, user, txFixture{})
	if _, err := pool.Exec(context.Background(),
		`UPDATE payments.transactions SET description = NULL WHERE id = $1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	prov := &fakeProvider{}
	w := NewCreateIntentWorker(pool, prov, &FeeConfig{}, metadataSettings{})
	if err := runCreateIntent(w, id); err != nil {
		t.Fatalf("Work: %v", err)
	}
	if len(prov.intentCalls) != 1 || prov.intentCalls[0].Description != "" {
		t.Errorf("provider calls = %+v, want one call with empty description", prov.intentCalls)
	}
}

func TestCreateIntentWorker_ProviderError(t *testing.T) {
	pool := testPool(t)
	user := newTestUser(t, pool)
	id := insertTransaction(t, pool, user, txFixture{Amount: "10.00"})

	provErr := errors.New("stripe down " + randomSuffix())
	prov := &fakeProvider{intentErr: provErr}
	w := NewCreateIntentWorker(pool, prov, &FeeConfig{Enabled: true, Percent: 2.9, FlatCents: 30, Refundable: true}, metadataSettings{})

	err := runCreateIntent(w, id)
	if err == nil {
		t.Fatal("Work returned nil, want error so River retries")
	}
	if !errors.Is(err, provErr) {
		t.Errorf("error %v does not wrap provider error", err)
	}

	row := loadTx(t, id)
	if row.Status != "failed" {
		t.Errorf("status = %q, want failed", row.Status)
	}
	if row.ErrorMessage == nil || !strings.Contains(*row.ErrorMessage, provErr.Error()) {
		t.Errorf("error_message = %v, want it to contain %q", row.ErrorMessage, provErr.Error())
	}
	if row.ProviderID != nil || row.ClientSecret != nil {
		t.Errorf("provider fields set on failure: %v %v", row.ProviderID, row.ClientSecret)
	}
	// Fee audit trail is written before the provider call, so it survives failure.
	if row.ProcessingFee != "0.61" || !row.FeeRefundable || row.FeePercent == nil || *row.FeePercent != 2.9 {
		t.Errorf("fee audit trail lost on failure: %+v", row)
	}
}

func TestCreateIntentWorker_NotFound(t *testing.T) {
	pool := testPool(t)
	prov := &fakeProvider{}
	w := NewCreateIntentWorker(pool, prov, &FeeConfig{}, metadataSettings{})

	err := runCreateIntent(w, "00000000-0000-4000-8000-"+randomSuffix()[:12])
	if err == nil || !strings.Contains(err.Error(), "payment not found") {
		t.Fatalf("error = %v, want payment not found", err)
	}
	if len(prov.intentCalls) != 0 {
		t.Errorf("provider called %d times, want 0", len(prov.intentCalls))
	}
}

func TestCreateIntentWorker_SkipsWhenNotPendingIntent(t *testing.T) {
	pool := testPool(t)
	for _, status := range []string{"pending", "succeeded", "failed", "canceled"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			user := newTestUser(t, pool)
			id := insertTransaction(t, pool, user, txFixture{Status: status})
			prov := &fakeProvider{}
			w := NewCreateIntentWorker(pool, prov, &FeeConfig{Enabled: true, Percent: 2.9, FlatCents: 30}, metadataSettings{})

			if err := runCreateIntent(w, id); err != nil {
				t.Fatalf("Work: %v", err)
			}
			if len(prov.intentCalls) != 0 {
				t.Errorf("provider called %d times, want 0", len(prov.intentCalls))
			}
			row := loadTx(t, id)
			if row.Status != status || row.ProcessingFee != "0.00" || row.ProviderID != nil {
				t.Errorf("row modified for skipped payment: %+v", row)
			}
		})
	}
}

// $0.29 is 29 cents. Converting through float64 (int64(0.29*100)) yields 28,
// so the worker converts to cents in SQL.
func TestCreateIntentWorker_FractionalCentsAmounts(t *testing.T) {
	pool := testPool(t)
	tests := []struct {
		amount string
		cents  int64
	}{
		{"0.29", 29},
		{"0.57", 57},
		{"1.13", 113},
		{"2.01", 201},
	}
	for _, tt := range tests {
		t.Run(tt.amount, func(t *testing.T) {
			user := newTestUser(t, pool)
			id := insertTransaction(t, pool, user, txFixture{Amount: tt.amount})
			prov := &fakeProvider{}
			w := NewCreateIntentWorker(pool, prov, &FeeConfig{}, metadataSettings{})
			if err := runCreateIntent(w, id); err != nil {
				t.Fatalf("Work: %v", err)
			}
			if len(prov.intentCalls) != 1 || prov.intentCalls[0].Amount != tt.cents {
				t.Errorf("provider calls = %+v, want amount %d", prov.intentCalls, tt.cents)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

// decimalCents converts a NUMERIC(10,2) text value such as "0.61" to cents.
func decimalCents(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(strings.Replace(s, ".", "", 1), 10, 64)
	if err != nil {
		t.Fatalf("decimalCents(%q): %v", s, err)
	}
	return n
}

func floatPtrEq(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func derefF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
