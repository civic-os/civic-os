package main

import (
	"fmt"
	"log"
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

// intentMetadata builds the reserved keys for a PaymentIntent. It is a pure
// function of the row, the fee and the worker setting, so a River retry sends
// the same metadata and its idempotency key stays valid.
func intentMetadata(id paymentIdentity, instanceKey string, baseCents, feeCents int64) map[string]string {
	m := identityMetadata(id, instanceKey)
	putMetadata(m, metaBaseCents, strconv.FormatInt(baseCents, 10))
	putMetadata(m, metaFeeCents, strconv.FormatInt(feeCents, 10))
	return m
}

// refundMetadata builds the reserved keys for a Refund. Stripe does not copy
// PaymentIntent metadata to refunds, so the identity keys are repeated here.
func refundMetadata(id paymentIdentity, refundID, instanceKey string) map[string]string {
	m := identityMetadata(id, instanceKey)
	putMetadata(m, metaRefundID, refundID)
	return m
}

func identityMetadata(id paymentIdentity, instanceKey string) map[string]string {
	m := make(map[string]string, 7)
	putMetadata(m, metaTransactionID, id.TransactionID)
	putMetadata(m, metaEntityType, deref(id.EntityType))
	putMetadata(m, metaEntityID, deref(id.EntityID))
	putMetadata(m, metaInstance, instanceKey)
	return m
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

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// checkInstanceKey validates PAYMENT_INSTANCE_KEY at startup. It returns an
// error for a value Stripe would refuse, and a warning when a live-mode
// Stripe key runs without one: several instances can share one Stripe
// account, and their payments are then told apart only by this key.
func checkInstanceKey(stripeAPIKey, instanceKey string) (warning string, err error) {
	if n := utf8.RuneCountInString(instanceKey); n > stripeMetadataValueMax {
		return "", fmt.Errorf("PAYMENT_INSTANCE_KEY is %d characters; Stripe accepts at most %d", n, stripeMetadataValueMax)
	}
	live := strings.HasPrefix(stripeAPIKey, "sk_live_") || strings.HasPrefix(stripeAPIKey, "rk_live_")
	if live && instanceKey == "" {
		return "PAYMENT_INSTANCE_KEY is not set with a live Stripe key: Stripe objects will not say which Civic OS instance created them", nil
	}
	return "", nil
}
