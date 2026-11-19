package main

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestIntentMetadata(t *testing.T) {
	permit, rec := "permits", "42"
	full := paymentIdentity{TransactionID: "tx-1", EntityType: &permit, EntityID: &rec}
	springfield := metadataSettings{InstanceKey: "springfield", SiteURL: "https://civic.example.org"}

	tests := []struct {
		name     string
		id       paymentIdentity
		settings metadataSettings
		base     int64
		fee      int64
		want     map[string]string
	}{
		{
			name: "every key set", id: full, settings: springfield, base: 1000, fee: 61,
			want: map[string]string{
				"civic_os_transaction_id": "tx-1",
				"civic_os_entity_type":    "permits",
				"civic_os_entity_id":      "42",
				"civic_os_instance":       "springfield",
				"civic_os_record_url":     "https://civic.example.org/view/permits/42",
				"civic_os_base_cents":     "1000",
				"civic_os_fee_cents":      "61",
			},
		},
		{
			name: "fees disabled send fee 0", id: full, settings: springfield, base: 2550, fee: 0,
			want: map[string]string{
				"civic_os_transaction_id": "tx-1",
				"civic_os_entity_type":    "permits",
				"civic_os_entity_id":      "42",
				"civic_os_instance":       "springfield",
				"civic_os_record_url":     "https://civic.example.org/view/permits/42",
				"civic_os_base_cents":     "2550",
				"civic_os_fee_cents":      "0",
			},
		},
		{
			name: "NULL entity leaves out entity keys and the link", id: paymentIdentity{TransactionID: "tx-2"},
			settings: metadataSettings{SiteURL: "https://civic.example.org"}, base: 29, fee: 0,
			want: map[string]string{
				"civic_os_transaction_id": "tx-2",
				"civic_os_base_cents":     "29",
				"civic_os_fee_cents":      "0",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := intentMetadata(tt.id, tt.settings, tt.base, tt.fee)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("intentMetadata = %v, want %v", got, tt.want)
			}
			// Deterministic: a River retry must send the same parameters, or
			// Stripe refuses the reused idempotency key.
			if again := intentMetadata(tt.id, tt.settings, tt.base, tt.fee); !reflect.DeepEqual(got, again) {
				t.Errorf("second call = %v, want %v", again, got)
			}
		})
	}
}

func TestRefundMetadata(t *testing.T) {
	res, rec := "reservations", "7"
	got := refundMetadata(paymentIdentity{TransactionID: "tx-1", EntityType: &res, EntityID: &rec}, "rf-1",
		metadataSettings{InstanceKey: "springfield", SiteURL: "https://civic.example.org"})
	want := map[string]string{
		"civic_os_transaction_id": "tx-1",
		"civic_os_entity_type":    "reservations",
		"civic_os_entity_id":      "7",
		"civic_os_instance":       "springfield",
		"civic_os_record_url":     "https://civic.example.org/view/reservations/7",
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
		"intent": intentMetadata(id, metadataSettings{SiteURL: "https://civic.example.org"}, 100, 0),
		"refund": refundMetadata(id, "rf-1", metadataSettings{SiteURL: "https://civic.example.org"}),
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
	got := intentMetadata(paymentIdentity{TransactionID: "tx-1", EntityID: &long, EntityType: &exact}, metadataSettings{}, 1, 0)
	if _, ok := got["civic_os_entity_id"]; ok {
		t.Error("value over 500 characters was sent; Stripe would refuse the request")
	}
	if got["civic_os_entity_type"] != exact {
		t.Error("a 500-character value was dropped; Stripe counts characters, not bytes")
	}
}

func TestMetadataKeysFitStripeLimits(t *testing.T) {
	for _, k := range []string{metaTransactionID, metaEntityType, metaEntityID, metaInstance,
		metaRecordURL, metaBaseCents, metaFeeCents, metaRefundID} {
		if len(k) > 40 || strings.ContainsAny(k, "[]") || !strings.HasPrefix(k, "civic_os_") {
			t.Errorf("key %q breaks Stripe's key rules or the civic_os_ prefix", k)
		}
	}
}

func TestResolveInstanceKey(t *testing.T) {
	exact := strings.Repeat("x", stripeMetadataValueMax)
	tests := []struct {
		name, apiKey, raw string
		wantKey           string
		wantWarn, wantErr bool
	}{
		{name: "live secret key without instance warns", apiKey: "sk_live_abc", wantWarn: true},
		{name: "live restricted key without instance warns", apiKey: "rk_live_abc", wantWarn: true},
		{name: "live key with instance is quiet", apiKey: "sk_live_abc", raw: "springfield", wantKey: "springfield"},
		{name: "test key without instance is quiet", apiKey: "sk_test_abc"},
		{name: "surrounding whitespace is trimmed", apiKey: "sk_test_abc", raw: " springfield\t\n", wantKey: "springfield"},
		{name: "inner whitespace is kept", apiKey: "sk_test_abc", raw: "city of springfield", wantKey: "city of springfield"},
		{name: "whitespace-only counts as unset", apiKey: "sk_live_abc", raw: "   ", wantWarn: true},
		{name: "over-long instance is refused", apiKey: "sk_test_abc",
			raw: strings.Repeat("x", stripeMetadataValueMax+1), wantErr: true},
		{name: "length is measured after trimming", apiKey: "sk_test_abc", raw: "  " + exact + "  ", wantKey: exact},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key, warn, err := resolveInstanceKey(tt.apiKey, tt.raw)
			if (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if key != tt.wantKey {
				t.Errorf("key = %q, want %q", key, tt.wantKey)
			}
			if (warn != "") != tt.wantWarn {
				t.Errorf("warning = %q, wantWarn %v", warn, tt.wantWarn)
			}
		})
	}
}

func TestRecordURL(t *testing.T) {
	tests := []struct {
		name, site, entityType, entityID, want string
	}{
		{name: "builds the Detail route", site: "https://civic.example.org",
			entityType: "permits", entityID: "42", want: "https://civic.example.org/view/permits/42"},
		{name: "keeps a base path", site: "https://example.org/civic",
			entityType: "permits", entityID: "42", want: "https://example.org/civic/view/permits/42"},
		{name: "UUID id", site: "https://civic.example.org", entityType: "reservations",
			entityID: "6f1c2e9a-0b7d-4a51-9c3e-2d8f4b6a1e07",
			want:     "https://civic.example.org/view/reservations/6f1c2e9a-0b7d-4a51-9c3e-2d8f4b6a1e07"},
		{name: "escapes a text key", site: "https://civic.example.org",
			entityType: "permits", entityID: "A/B 7?x#y",
			want: "https://civic.example.org/view/permits/A%2FB%207%3Fx%23y"},
		{name: "no SITE_URL, no link", entityType: "permits", entityID: "42"},
		{name: "no entity_type, no link", site: "https://civic.example.org", entityID: "42"},
		{name: "no entity_id, no link", site: "https://civic.example.org", entityType: "permits"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := recordURL(tt.site, tt.entityType, tt.entityID); got != tt.want {
				t.Errorf("recordURL = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestMetadataDropsOverlongRecordURL(t *testing.T) {
	permit, long := "permits", strings.Repeat("x", stripeMetadataValueMax-10)
	got := intentMetadata(paymentIdentity{TransactionID: "tx-1", EntityType: &permit, EntityID: &long},
		metadataSettings{SiteURL: "https://civic.example.org"}, 1, 0)
	if _, ok := got[metaRecordURL]; ok {
		t.Error("record URL over 500 characters was sent; Stripe would refuse the request")
	}
	if got[metaEntityID] != long {
		t.Error("entity_id was dropped along with the over-long link")
	}
}

func TestResolveSiteURL(t *testing.T) {
	tests := []struct {
		name, raw, want string
		wantErr         bool
	}{
		{name: "unset", raw: ""},
		{name: "whitespace only counts as unset", raw: "  "},
		{name: "plain origin", raw: "https://civic.example.org", want: "https://civic.example.org"},
		{name: "trailing slashes and whitespace trimmed", raw: " https://civic.example.org// \n", want: "https://civic.example.org"},
		{name: "http with port for local dev", raw: "http://localhost:4200", want: "http://localhost:4200"},
		{name: "base path kept", raw: "https://example.org/civic/", want: "https://example.org/civic"},
		{name: "no scheme refused", raw: "civic.example.org", wantErr: true},
		{name: "other scheme refused", raw: "ftp://civic.example.org", wantErr: true},
		{name: "no host refused", raw: "https://", wantErr: true},
		{name: "query refused", raw: "https://civic.example.org?x=1", wantErr: true},
		{name: "fragment refused", raw: "https://civic.example.org/#/", wantErr: true},
		{name: "bare question mark refused", raw: "https://civic.example.org?", wantErr: true},
		{name: "unparseable refused", raw: "https://civic example.org", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveSiteURL(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("resolveSiteURL = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes("héllo", 3); got != "hél" {
		t.Errorf("truncateRunes = %q, want %q", got, "hél")
	}
	if got := truncateRunes("abc", 5); got != "abc" {
		t.Errorf("short string changed: %q", got)
	}
	if got := truncateRunes(strings.Repeat("é", 600), 500); utf8.RuneCountInString(got) != 500 || !utf8.ValidString(got) {
		t.Errorf("cut is %d characters or invalid UTF-8", utf8.RuneCountInString(got))
	}
}
