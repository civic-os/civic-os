# Payment Processing POC - Implementation Summary

**Version:** 1.2
**Status:** Phase 2 Complete (Admin, Refunds, Generic Payments, Notifications)
**Date:** 2025-11-26
**Related Docs:** [PAYMENT_PROCESSING.md](./PAYMENT_PROCESSING.md) (Full Design), [PAYMENT_STATE_DIAGRAM.md](./PAYMENT_STATE_DIAGRAM.md)

---

## Overview

This document describes the **implemented** payment POC using the **Property Type pattern**, which is simpler than the full polymorphic design described in PAYMENT_PROCESSING.md. The POC was developed for the Community Center reservation system as a proof-of-concept.

### Key Difference from Full Design

- **Full Design**: Polymorphic payments with `entity_type` + `entity_id` pattern (any entity can have payments)
- **POC Implementation**: Direct foreign key pattern with `payment_transaction_id` column + `Payment` property type

The POC validates core payment processing mechanics while deferring metadata-driven configuration to future work.

---

## Architecture Implemented

### Core Components (v0.13.0 migration + community-center example)

```
┌──────────────────────────────────────────────────────────────┐
│                    Angular Frontend                          │
│  ┌────────────────┐  ┌──────────────────┐                   │
│  │ PaymentCheckout│  │ DetailPage       │                   │
│  │ Component      │  │ (Pay Now button) │                   │
│  └────────────────┘  └──────────────────┘                   │
│  ┌──────────────────────────────────────┐                   │
│  │ PaymentBadgeComponent (shared)       │                   │
│  │ - DisplayPropertyComponent           │                   │
│  │ - EditPropertyComponent              │                   │
│  └──────────────────────────────────────┘                   │
└───────────────┬──────────────────────────────────────────────┘
                │
                │ RPC Calls + PostgREST queries
                ▼
┌──────────────────────────────────────────────────────────────┐
│                      PostgREST API                            │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ RPC: initiate_reservation_request_payment(request_id)    ││
│  │   - Creates new transaction on retry (orphans old)       ││
│  │   - Returns payment_id (UUID)                             ││
│  │   - Updates reservation_requests.payment_transaction_id   ││
│  │                                                            ││
│  │ View: payment_transactions (RLS-enabled)                  ││
│  │   - Exposes payments.transactions via public view         ││
│  └──────────────────────────────────────────────────────────┘│
└───────────────┬──────────────────────────────────────────────┘
                │
                │ Triggers + Job Queue
                ▼
┌──────────────────────────────────────────────────────────────┐
│                   PostgreSQL Database                         │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Schema: payments (v0.13.0 migration)                      ││
│  │   - transactions table (id, user_id, amount, status, ...) ││
│  │   - Trigger: enqueue_create_intent_job → River job       ││
│  │                                                            ││
│  │ Schema: metadata                                          ││
│  │   - webhooks table (idempotency + audit)                 ││
│  │   - river_job table (job queue)                          ││
│  │                                                            ││
│  │ Schema: public (example-specific)                         ││
│  │   - reservation_requests.payment_transaction_id (FK)      ││
│  │   - RPC: initiate_reservation_request_payment()          ││
│  │   - RPC: calculate_reservation_cost()                    ││
│  └──────────────────────────────────────────────────────────┘│
└───────────────┬──────────────────────────────────────────────┘
                │
                │ Job Polling
                ▼
┌──────────────────────────────────────────────────────────────┐
│         Payment Worker (Go + River)                           │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Workers:                                                  ││
│  │   - CreateIntentWorker: Creates Stripe PaymentIntent     ││
│  │   - WebhookHandler: Processes Stripe webhooks            ││
│  │     * Gracefully ignores orphaned PaymentIntents         ││
│  │                                                            ││
│  │ Provider: StripeProvider                                  ││
│  │   - Uses Stripe Go SDK                                    ││
│  │   - Configured via STRIPE_SECRET_KEY env var             ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Database Schema (v0.13.0 Migration)

**Core tables in `payments` schema:**

```sql
-- payments.transactions (managed by migration)
CREATE TABLE payments.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id),
  amount NUMERIC(10,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(20) NOT NULL,  -- pending_intent, pending, succeeded, failed, canceled
  provider VARCHAR(20) NOT NULL DEFAULT 'stripe',
  provider_payment_id VARCHAR(255),  -- Stripe PaymentIntent ID
  provider_client_secret TEXT,       -- For frontend Stripe.js
  description TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS policies
ALTER TABLE payments.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own payments" ON payments.transactions
  FOR SELECT TO authenticated
  USING (user_id = current_user_id());
```

**Example entity integration (community-center specific):**

```sql
-- reservation_requests.payment_transaction_id (example-specific FK)
ALTER TABLE public.reservation_requests
  ADD COLUMN payment_transaction_id UUID
    REFERENCES payments.transactions(id) ON DELETE SET NULL;

-- Helper function (example-specific)
CREATE FUNCTION public.calculate_reservation_cost(
  p_resource_id INT,
  p_time_slot time_slot
) RETURNS NUMERIC(10,2);

-- Payment initiation RPC (example-specific)
CREATE FUNCTION public.initiate_reservation_request_payment(
  p_request_id BIGINT
) RETURNS UUID;
```

### 2. Payment Property Type

**SchemaService Detection:**

```typescript
// src/app/services/schema.service.ts
if (col.column_name.endsWith('_transaction_id') &&
    col.join_table === 'payment_transactions') {
  return EntityPropertyType.Payment;
}
```

**Display Component:**

Uses `PaymentBadgeComponent` to show status with colored badge:
- ✅ `succeeded` → Green badge with check icon
- ⏱️ `pending`/`pending_intent` → Yellow badge with clock icon
- ❌ `failed` → Red badge with error icon
- 🚫 `canceled` → Gray badge with cancel icon

**Edit Component:**

Payment is read-only on Edit pages - uses same `PaymentBadgeComponent` for consistent display.

### 3. Payment Flow

**User initiates payment:**

1. User creates `reservation_request` (unpaid, `payment_transaction_id` = NULL)
2. User views detail page, sees "Pay Now" button
3. Clicks "Pay Now" → calls `initiate_reservation_request_payment(request_id)`
4. RPC:
   - Calculates cost from `resource.hourly_rate` × `time_slot` duration
   - Creates new `payments.transactions` record (status='pending_intent')
   - Updates `reservation_requests.payment_transaction_id` = new payment ID
   - Returns payment ID to frontend
5. Trigger fires → enqueues River job `create_payment_intent`
6. Worker processes job:
   - Calls Stripe API to create PaymentIntent
   - Updates transaction with `provider_payment_id` and `provider_client_secret`
   - Sets status='pending'
7. Frontend polls `payment_transactions` view until `client_secret` available
8. Opens `PaymentCheckoutComponent` modal with Stripe Elements
9. User enters card details → confirms payment via Stripe.js
10. Stripe webhook arrives → webhook handler updates status='succeeded'
11. Frontend polls for status change → closes modal, refreshes detail page

**Retry Logic (NEW - 2025-11-22):**

If payment fails and user retries:
- RPC creates **NEW** transaction record
- Updates `reservation_requests.payment_transaction_id` to new ID
- Old transaction remains in DB as audit trail (status='failed')
- Webhook handler gracefully ignores webhooks for orphaned PaymentIntents

### 4. Frontend Components

**PaymentCheckoutComponent** (`src/app/components/payment-checkout/`)
- Standalone modal component
- Polls for `client_secret` (worker creates PaymentIntent async)
- Embeds Stripe Payment Element
- Handles payment confirmation
- Polls for webhook status update after Stripe confirms
- Emits `paymentSuccess` event to trigger parent refresh

**PaymentBadgeComponent** (`src/app/components/payment-badge/`) **NEW**
- Reusable status badge
- Used by both `DisplayPropertyComponent` and `EditPropertyComponent`
- Consistent payment status display across all pages

**DetailPage Integration:**
- `canInitiatePayment$` observable checks:
  - Entity has `payment_initiation_rpc` configured in metadata (generic, not hardcoded)
  - Record status allows payment (entity-specific logic)
  - Payment is null OR failed/canceled
- "Pay Now" button calls the RPC specified in `entity.payment_initiation_rpc`
- Modal opens on success, polls until client_secret ready
- Refreshes record when modal closes (successful or not)

### 5. Webhook Processing

**Idempotency Pattern:**

```go
// Insert webhook record (deduplicate by provider_event_id)
_, err = tx.Exec(ctx, `
  INSERT INTO metadata.webhooks (provider, provider_event_id, event_type, payload)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id
`, "stripe", event.ID, event.Type, eventJSON)

if err == pgx.ErrNoRows {
  // Duplicate - already processed
  return nil  // Return 200 to Stripe
}
```

**Orphaned PaymentIntent Handling:**

When user retries failed payment, old PaymentIntent may still complete (if user had form open). Webhook handler now gracefully handles this:

```go
// handlePaymentIntentSucceeded
result, err := tx.Exec(ctx, `
  UPDATE payments.transactions
  SET status = 'succeeded', updated_at = NOW()
  WHERE provider_payment_id = $1
`, paymentIntent.ID)

if result.RowsAffected() == 0 {
  // Payment not found - likely orphaned from retry
  log.Printf("[Webhook] ⚠ Payment %s not found (likely orphaned from retry)", paymentIntent.ID)
  return nil  // Return 200 to avoid Stripe retries
}
```

---

## What's Implemented vs Full Design

### ✅ Implemented (Phase 1 + Phase 2 Complete)

**Phase 1 (v0.13.0) - Core Payment Processing:**
- [x] Core `payments.transactions` table with RLS
- [x] `Payment` property type detection and display
- [x] `PaymentCheckoutComponent` with Stripe Elements
- [x] `PaymentBadgeComponent` for consistent status display
- [x] Payment initiation via domain-specific RPC
- [x] River-based job queue for Stripe API calls
- [x] Webhook processing with idempotency
- [x] Retry logic with new transaction creation
- [x] Orphaned PaymentIntent handling
- [x] Frontend polling for async operations
- [x] Edit page payment display (read-only)
- [x] Detail page "Pay Now" button with conditional logic

**Phase 2 (v0.14.0) - Admin, Refunds & Generic Payments:**
- [x] Polymorphic `entity_type` + `entity_id` pattern
- [x] Metadata-driven payment initiation (`payment_initiation_rpc` column)
- [x] Generic `canInitiatePayment$` logic (metadata-driven, not hardcoded)
- [x] Email notifications (`payment_succeeded`, `payment_refunded` templates)
- [x] Refund processing (1:M refund support with multiple partial refunds)
- [x] Admin payment management UI (`/admin/payments`)
- [x] Permission-based RLS for payment administration

### ❌ Not Implemented (Future Work)

- [ ] Automatic entity `payment_status` sync via triggers
- [ ] Capture timing configuration (immediate vs deferred)
- [ ] Multiple payment providers (only Stripe implemented)
- [ ] Recurring payments / subscriptions
- [ ] Multi-currency support

---

## Testing the POC

**Prerequisites:**
1. Stripe account with test mode API keys
2. Stripe CLI installed (`stripe listen --forward-to http://localhost:8081/webhooks/stripe`)
3. Community Center example running (`examples/community-center/`)

**Test Flow:**

```bash
# 1. Start services
cd examples/community-center
docker-compose up -d

# 2. Start Stripe webhook listener
stripe listen --forward-to http://localhost:8081/webhooks/stripe

# 3. Test payment flow
# - Create reservation request
# - Click "Pay Now"
# - Use test card: 4242 4242 4242 4242
# - Verify status updates to "succeeded"

# 4. Test failed payment retry
# - Use test card: 4000 0000 0000 0341 (declined)
# - Verify status = "failed"
# - Click "Pay Now" again
# - Verify NEW transaction created
# - Complete payment successfully
# - Check database: SELECT * FROM payments.transactions;
#   Should show 2 records (failed + succeeded)
```

**Database Verification:**

```sql
-- Check transactions
SELECT id, provider_payment_id, status, amount, created_at
FROM payments.transactions
ORDER BY created_at DESC;

-- Check entity link
SELECT id, display_name, payment_transaction_id
FROM reservation_requests
WHERE payment_transaction_id IS NOT NULL;

-- Check webhooks processed
SELECT provider_event_id, event_type, processed, created_at
FROM metadata.webhooks
ORDER BY created_at DESC;
```

---

## Key Files

### Core Framework (v0.13.0 Migration)

- `postgres/migrations/deploy/v0-13-0-add-payments-poc.sql` - Core payment schema
- `postgres/migrations/deploy/v0-13-0-add-payment-metadata.sql` - Payment metadata columns
- `services/payment-worker/` - Go microservice (CreateIntentWorker, WebhookHandler)

> **Architecture Note:** The `payment-worker` is intentionally separate from `consolidated-worker` (which handles files, thumbnails, and notifications). This separation provides:
> - Independent scaling based on payment volume
> - Clearer bounded context for payment processing
> - Optional deployment (only needed if accepting payments)

### Frontend Components

- `src/app/components/payment-checkout/payment-checkout.component.ts` - Stripe checkout modal
- `src/app/components/payment-badge/payment-badge.component.ts` - **NEW** - Reusable status badge
- `src/app/components/display-property/display-property.component.html` - Uses PaymentBadgeComponent
- `src/app/components/edit-property/edit-property.component.html` - Uses PaymentBadgeComponent
- `src/app/pages/detail/detail.page.ts` - "Pay Now" button logic

### Example Integration (Community Center)

- `examples/community-center/init-scripts/10_payment_integration.sql` - Example-specific setup
  - `reservation_requests.payment_transaction_id` FK
  - `calculate_reservation_cost()` function
  - `initiate_reservation_request_payment()` RPC
  - Sample hourly rates for resources

### Configuration

- `.env` files:
  - `STRIPE_SECRET_KEY` - Stripe API key (test mode)
  - `STRIPE_PUBLISHABLE_KEY` - Frontend Stripe.js key
  - `STRIPE_WEBHOOK_SECRET` - Webhook signature verification

---

## Known Limitations & Future Work

### ~~1. Hardcoded Logic~~ ✅ Implemented in Phase 2 (v0.14.0)

**Resolved:** `payment_initiation_rpc` column now exists in `metadata.entities`. DetailPage dynamically reads this metadata to determine if an entity supports payments, which RPC to call, and handles payment initiation generically.

### ~~2. Single Transaction Per Entity~~ ✅ Implemented in Phase 2 (v0.14.0)

**Resolved:** Polymorphic `entity_type` + `entity_id` pattern implemented. Multiple payments can reference the same entity. The `payment_transactions` view includes entity tracking, and the admin UI can navigate to any entity type.

### ~~3. No Refund UI~~ ✅ Implemented in Phase 2 (v0.14.0)

**Resolved:** Admin payments page with full refund capabilities:
- 1:M refund support (multiple partial refunds per transaction)
- Over-refund validation in RPC
- Refund history modal with Stripe IDs for cross-reference

### 4. Limited Error Handling

**Problem:** Payment failures don't provide detailed error messages to users.

**Future:** Surface Stripe decline codes and suggest next steps (try different card, contact bank, etc.).

### ~~5. No Email Notifications~~ ✅ Implemented in Phase 2 (v0.14.0)

**Resolved:** Notification templates exist for `payment_succeeded` and `payment_refunded`. Triggers automatically fire on payment/refund completion, sending email confirmations via the consolidated notification worker.

---

## Migration Path to Full Design

~~When ready to productionize:~~ **Most items completed in v0.14.0!**

1. ✅ **Add polymorphic columns** to `payments.transactions` - DONE (v0.14.0)
   - `entity_type` and `entity_id` columns added
   - `payment_transactions` view includes entity reference and display name

2. **Create generic RPC** `initiate_payment(entity_type, entity_id, amount, description)`:
   - ⏳ Deferred: Domain-specific RPCs still used (e.g., `initiate_reservation_request_payment`)
   - Generic RPC pattern available if needed for future entities

3. ✅ **Add metadata columns** to `metadata.entities` - DONE (v0.14.0)
   - `payment_initiation_rpc` - Custom RPC name (implemented)
   - `payment_capture_mode` - Deferred (immediate capture only for now)

4. **Implement entity sync trigger** `update_entity_payment_status()`:
   - ⏳ Deferred: Entities update their own status in domain-specific RPCs
   - Standardized trigger approach not yet implemented

5. ✅ **Build admin UI** - DONE (v0.14.0)
   - `/admin/payments` with search, filter, sort
   - Refund processing (1:M support)
   - Entity navigation and Stripe ID cross-reference

6. ✅ **Add email notifications** - DONE (v0.11.0 + v0.14.0)
   - `payment_succeeded` template
   - `payment_refunded` template
   - Triggers fire on transaction/refund completion

---

## Phase 2: Admin & Refunds (v0.14.0)

Phase 2 adds system-wide payment management with refund capabilities, resolving the "No Refund UI" limitation from Phase 1.

### New Features

#### 1. Admin Payments Page (`/admin/payments`)

System-wide payment management interface with:
- **Permission-based access**: Requires `payment_transactions:select` permission to view
- **Filterable by status**: pending, succeeded, failed, refunded, partially_refunded
- **Search**: By description, user email, or Stripe payment ID
- **Sortable columns**: Date, amount, status
- **User info display**: Shows user display name and email for each payment
- **Refund initiation**: Users with `payment_refunds:insert` permission can issue refunds

#### 2. Refund Processing

Complete refund workflow with:
- **RefundWorker**: Go worker processes `process_refund` River jobs
- **Stripe API integration**: `StripeProvider.CreateRefund()` method
- **Database tracking**: `payments.refunds` table tracks all refund operations
- **Webhook handling**: `charge.refunded` webhook confirms Stripe refund completion
- **Email notifications**: Refund confirmation email via notification worker

#### 3. Effective Status (Computed Field)

The `effective_status` field provides refund-aware status display:
- **Original status preserved**: `status` column maintains audit trail
- **Computed display**: `effective_status` returns 'refunded' or 'partially_refunded' when refund exists
- **PostgREST integration**: Available via computed field function `payments.effective_status()`
- **Filter support**: Can filter embedded payments by `column.effective_status=in.(...)` syntax

#### 4. Payment Type Filtering

FilterBar now supports Payment type properties:
- **Status checkboxes**: All payment statuses available as filter options
- **Embedded resource filtering**: Uses PostgREST `column.effective_status` syntax
- **URL persistence**: Filters persist in URL query params

### Database Schema (v0.14.0 Migration)

```sql
-- New permissions for payment management
INSERT INTO metadata.permissions (table_name, permission_type, description)
VALUES
  ('payment_transactions', 'select', 'View all payment transactions'),
  ('payment_refunds', 'select', 'View refund records'),
  ('payment_refunds', 'insert', 'Initiate payment refunds');

-- Refunds table
CREATE TABLE payments.refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES payments.transactions(id),
  amount NUMERIC(10,2) NOT NULL,
  reason TEXT,
  initiated_by UUID REFERENCES metadata.civic_os_users(id),
  provider_refund_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, succeeded, failed
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Computed field for refund-aware status
CREATE FUNCTION payments.effective_status(t payments.transactions)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM payments.refunds r
      WHERE r.transaction_id = t.id AND r.status = 'succeeded'
    ) THEN
      CASE WHEN (
        SELECT SUM(r.amount) FROM payments.refunds r
        WHERE r.transaction_id = t.id AND r.status = 'succeeded'
      ) >= t.amount THEN 'refunded' ELSE 'partially_refunded' END
    ELSE t.status
  END;
$$ LANGUAGE SQL STABLE;

-- Updated payment_transactions view includes effective_status
CREATE VIEW public.payment_transactions AS
SELECT
  t.*, u.display_name AS user_display_name, u.email AS user_email,
  payments.effective_status(t) AS effective_status,
  r.id AS refund_id, r.amount AS refund_amount, r.reason AS refund_reason
FROM payments.transactions t
LEFT JOIN metadata.civic_os_users u ON t.user_id = u.id
LEFT JOIN payments.refunds r ON t.id = r.transaction_id;
```

### Go Worker Updates

```
services/payment-worker/
├── main.go              # Updated to register RefundWorker
├── stripe_provider.go   # Added CreateRefund() method + RefundParams/RefundResult types
├── refund_worker.go     # NEW: RefundWorker processes 'process_refund' jobs
└── webhook_handler.go   # Added charge.refunded handler
```

**RefundWorker Flow:**
1. Fetch refund record from database
2. Validate status is 'pending' (idempotent)
3. Call `StripeProvider.CreateRefund()` with PaymentIntent ID and amount
4. Update refund record with Stripe refund ID and 'succeeded' status
5. Enqueue notification job for user email

### Frontend Updates

| Component | Changes |
|-----------|---------|
| `AdminPaymentsPage` | NEW: System-wide payment management at `/admin/payments` |
| `PaymentBadgeComponent` | Uses `effective_status` instead of `status` for display |
| `PaymentValue` interface | Added `effective_status` field |
| `SchemaService` | Select string includes `effective_status` and `error_message` |
| `FilterBarComponent` | Added Payment type with status checkboxes |

### Route

```typescript
{
  path: 'admin/payments',
  component: AdminPaymentsPage,
  canActivate: [schemaVersionGuard, authGuard]
}
```

---

## Changelog

- **v1.2 (2025-11-26)**: Documentation accuracy update
  - Corrected "Not Implemented" section - many features were already built in code but docs were outdated
  - Confirmed generic payment initiation is implemented (not hardcoded to reservation_requests)
  - Updated "Known Limitations" section - 4 of 5 items now resolved
  - Updated "Migration Path" section - most items completed in v0.14.0
  - Payment system is now fully metadata-driven via `payment_initiation_rpc`
- **v1.1 (2025-11-25)**: Phase 2 - Admin & Refunds implementation
  - Admin payments page (`/admin/payments`) with permission-based access
  - RefundWorker for async Stripe refund processing
  - `effective_status` computed field for refund-aware display
  - `charge.refunded` webhook handler
  - FilterBar support for Payment type properties
  - PaymentBadge uses effective_status
  - Permission-based RLS (payment_transactions:select, payment_refunds:select/insert)
- **v1.0 (2025-11-22)**: Initial POC implementation summary
  - Property Type approach with direct FK pattern
  - Core payment flow working (create → pay → webhook → status update)
  - Retry logic with new transaction creation
  - Orphaned PaymentIntent handling in webhooks
  - PaymentBadgeComponent refactoring for code reuse
  - Edit page payment display (read-only)
