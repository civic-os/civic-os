package main

import (
	"fmt"
	"log"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Reserved metadata keys the worker sends with every PaymentIntent and Refund,
// so a Stripe admin or a payout report can tell which Civic OS transaction,
// record and instance a Stripe object belongs to. They identify a payment and
// never classify it (no account, program or funding source): see
// docs/notes/STRIPE_METADATA_DESIGN.md, section 1.
const (
	metaTransactionID = "civic_os_transaction_id"
	metaEntityType    = "civic_os_entity_type"
	metaEntityID      = "civic_os_entity_id"
	metaInstance      = "civic_os_instance"
	metaRecordURL     = "civic_os_record_url" // Detail page of the paid record; needs SITE_URL
	metaBaseCents     = "civic_os_base_cents" // PaymentIntent only; Stripe's amount is base plus fee
	metaFeeCents      = "civic_os_fee_cents"  // PaymentIntent only; "0" when fees are disabled
	metaRefundID      = "civic_os_refund_id"  // Refund only
)

// stripeMetadataValueMax is Stripe's limit on a metadata value, in characters.
const stripeMetadataValueMax = 500

// paymentIdentity is what the workers read from payments.transactions to
// identify a payment. EntityType and EntityID are NULL when the integrator
// inserted the row without payments.create_and_link_payment().
type paymentIdentity struct {
	TransactionID string
	EntityType    *string
	EntityID      *string
}

// metadataSettings are the worker settings that go into Stripe metadata, both
// resolved once at startup. Each is empty when unset, and its key is then left
// out.
type metadataSettings struct {
	InstanceKey string // PAYMENT_INSTANCE_KEY, sent as civic_os_instance
	SiteURL     string // SITE_URL without a trailing slash, the base of civic_os_record_url
}

// intentMetadata builds the reserved keys for a PaymentIntent. It is a pure
// function of the row, the fee and the worker settings, so a River retry sends
// the same metadata and its idempotency key stays valid.
func intentMetadata(id paymentIdentity, s metadataSettings, baseCents, feeCents int64) map[string]string {
	m := identityMetadata(id, s)
	putMetadata(m, metaBaseCents, strconv.FormatInt(baseCents, 10))
	putMetadata(m, metaFeeCents, strconv.FormatInt(feeCents, 10))
	return m
}

// refundMetadata builds the reserved keys for a Refund. Stripe does not copy
// PaymentIntent metadata to refunds, so the identity keys are repeated here.
func refundMetadata(id paymentIdentity, refundID string, s metadataSettings) map[string]string {
	m := identityMetadata(id, s)
	putMetadata(m, metaRefundID, refundID)
	return m
}

func identityMetadata(id paymentIdentity, s metadataSettings) map[string]string {
	entityType, entityID := deref(id.EntityType), deref(id.EntityID)
	m := make(map[string]string, 8)
	putMetadata(m, metaTransactionID, id.TransactionID)
	putMetadata(m, metaEntityType, entityType)
	putMetadata(m, metaEntityID, entityID)
	putMetadata(m, metaInstance, s.InstanceKey)
	putMetadata(m, metaRecordURL, recordURL(s.SiteURL, entityType, entityID))
	return m
}

// recordURL is the paid record's Detail page, /view/<entity_type>/<entity_id>
// under SITE_URL (entity_type is the table name the route takes). It is ""
// unless all three are set. Each path segment is escaped, because entity_id is
// any primary key as text.
func recordURL(siteURL, entityType, entityID string) string {
	if siteURL == "" || entityType == "" || entityID == "" {
		return ""
	}
	return siteURL + "/view/" + url.PathEscape(entityType) + "/" + url.PathEscape(entityID)
}

// putMetadata sets a key unless its value is empty, because Stripe reads an
// empty value as "delete this key", or longer than Stripe accepts, because a
// truncated identifier would point at the wrong record. A dropped value is
// logged; the payment goes ahead without it.
func putMetadata(m map[string]string, key, value string) {
	if value == "" {
		return
	}
	if utf8.RuneCountInString(value) > stripeMetadataValueMax {
		log.Printf("[Metadata] ⚠ %s is longer than %d characters; not sent", key, stripeMetadataValueMax)
		return
	}
	m[key] = value
}

// truncateRunes cuts s to at most n characters, never inside a character.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// resolveInstanceKey turns the raw PAYMENT_INSTANCE_KEY value into the key the
// workers send, trimmed of surrounding whitespace (a stray space in an .env
// file would otherwise split one instance's Stripe history in two). It returns
// an error for a value Stripe would refuse, and a warning when a live-mode
// Stripe key runs without one: several instances can share one Stripe
// account, and their payments are then told apart only by this key.
func resolveInstanceKey(stripeAPIKey, raw string) (key, warning string, err error) {
	key = strings.TrimSpace(raw)
	if n := utf8.RuneCountInString(key); n > stripeMetadataValueMax {
		return "", "", fmt.Errorf("PAYMENT_INSTANCE_KEY is %d characters; Stripe accepts at most %d", n, stripeMetadataValueMax)
	}
	live := strings.HasPrefix(stripeAPIKey, "sk_live_") || strings.HasPrefix(stripeAPIKey, "rk_live_")
	if live && key == "" {
		return key, "PAYMENT_INSTANCE_KEY is not set with a live Stripe key: Stripe objects will not say which Civic OS instance created them", nil
	}
	return key, "", nil
}

// resolveSiteURL turns the raw SITE_URL value into the base of
// civic_os_record_url: trimmed, without a trailing slash, "" when unset. It
// refuses a value that would build broken links, one that is not an absolute
// http(s) URL or that carries a query or fragment. A path is kept, for a
// frontend served under one.
func resolveSiteURL(raw string) (string, error) {
	s := strings.TrimRight(strings.TrimSpace(raw), "/")
	if s == "" {
		return "", nil
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("SITE_URL %q is not a URL: %w", s, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("SITE_URL %q must be an absolute http or https URL", s)
	}
	if u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(s, "?") || strings.HasSuffix(s, "#") {
		return "", fmt.Errorf("SITE_URL %q must not have a query or fragment", s)
	}
	return s, nil
}
