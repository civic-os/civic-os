package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestIntentMetadata(t *testing.T) {
	permit, rec := "permits", "42"
	full := paymentIdentity{TransactionID: "tx-1", EntityType: &permit, EntityID: &rec}

	tests := []struct {
		name     string
		id       paymentIdentity
		instance string
		base     int64
		fee      int64
		want     map[string]string
	}{
		{
			name: "every key set", id: full, instance: "springfield", base: 1000, fee: 61,
			want: map[string]string{
				"civic_os_transaction_id": "tx-1",
				"civic_os_entity_type":    "permits",
				"civic_os_entity_id":      "42",
				"civic_os_instance":       "springfield",
				"civic_os_base_cents":     "1000",
				"civic_os_fee_cents":      "61",
			},
		},
		{
			name: "fees disabled send fee 0", id: full, instance: "springfield", base: 2550, fee: 0,
			want: map[string]string{
				"civic_os_transaction_id": "tx-1",
				"civic_os_entity_type":    "permits",
				"civic_os_entity_id":      "42",
				"civic_os_instance":       "springfield",
				"civic_os_base_cents":     "2550",
				"civic_os_fee_cents":      "0",
			},
		},
		{
			name: "NULL entity and no instance are left out", id: paymentIdentity{TransactionID: "tx-2"},
			base: 29, fee: 0,
			want: map[string]string{
				"civic_os_transaction_id": "tx-2",
				"civic_os_base_cents":     "29",
				"civic_os_fee_cents":      "0",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := intentMetadata(tt.id, tt.instance, tt.base, tt.fee)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("intentMetadata = %v, want %v", got, tt.want)
			}
			// Deterministic: a River retry must send the same parameters, or
			// Stripe refuses the reused idempotency key.
			if again := intentMetadata(tt.id, tt.instance, tt.base, tt.fee); !reflect.DeepEqual(got, again) {
				t.Errorf("second call = %v, want %v", again, got)
			}
		})
	}
}

func TestRefundMetadata(t *testing.T) {
	res, rec := "reservations", "7"
	got := refundMetadata(paymentIdentity{TransactionID: "tx-1", EntityType: &res, EntityID: &rec}, "rf-1", "springfield")
	want := map[string]string{
		"civic_os_transaction_id": "tx-1",
		"civic_os_entity_type":    "reservations",
		"civic_os_entity_id":      "7",
		"civic_os_instance":       "springfield",
		"civic_os_refund_id":      "rf-1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("refundMetadata = %v, want %v", got, want)
	}
	if _, ok := got["civic_os_base_cents"]; ok {
		t.Error("refund metadata carries PaymentIntent-only key civic_os_base_cents")
	}
}

func TestMetadataNeverSendsEmptyValues(t *testing.T) {
	empty := ""
	id := paymentIdentity{TransactionID: "tx-1", EntityType: &empty, EntityID: &empty}
	for name, m := range map[string]map[string]string{
		"intent": intentMetadata(id, "", 100, 0),
		"refund": refundMetadata(id, "rf-1", ""),
	} {
		for k, v := range m {
			if v == "" {
				t.Errorf("%s metadata %s is empty; Stripe reads that as delete", name, k)
			}
		}
		if _, ok := m["civic_os_entity_type"]; ok {
			t.Errorf("%s metadata has civic_os_entity_type for an empty entity_type", name)
		}
	}
}

func TestMetadataDropsOverlongValues(t *testing.T) {
	long := strings.Repeat("x", stripeMetadataValueMax+1)
	exact := strings.Repeat("é", stripeMetadataValueMax) // 500 characters, 1000 bytes
	got := intentMetadata(paymentIdentity{TransactionID: "tx-1", EntityID: &long, EntityType: &exact}, "", 1, 0)
	if _, ok := got["civic_os_entity_id"]; ok {
		t.Error("value over 500 characters was sent; Stripe would refuse the request")
	}
	if got["civic_os_entity_type"] != exact {
		t.Error("a 500-character value was dropped; Stripe counts characters, not bytes")
	}
}

func TestMetadataKeysFitStripeLimits(t *testing.T) {
	for _, k := range []string{metaTransactionID, metaEntityType, metaEntityID, metaInstance,
		metaBaseCents, metaFeeCents, metaRefundID} {
		if len(k) > 40 || strings.ContainsAny(k, "[]") || !strings.HasPrefix(k, "civic_os_") {
			t.Errorf("key %q breaks Stripe's key rules or the civic_os_ prefix", k)
		}
	}
}

func TestCheckInstanceKey(t *testing.T) {
	tests := []struct {
		name, apiKey, instance string
		wantWarn, wantErr      bool
	}{
		{name: "live secret key without instance warns", apiKey: "sk_live_abc", wantWarn: true},
		{name: "live restricted key without instance warns", apiKey: "rk_live_abc", wantWarn: true},
		{name: "live key with instance is quiet", apiKey: "sk_live_abc", instance: "springfield"},
		{name: "test key without instance is quiet", apiKey: "sk_test_abc"},
		{name: "over-long instance is refused", apiKey: "sk_test_abc",
			instance: strings.Repeat("x", stripeMetadataValueMax+1), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			warn, err := checkInstanceKey(tt.apiKey, tt.instance)
			if (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if (warn != "") != tt.wantWarn {
				t.Errorf("warning = %q, wantWarn %v", warn, tt.wantWarn)
			}
		})
	}
}
