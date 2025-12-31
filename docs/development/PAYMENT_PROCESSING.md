# Payment Processing System

**Version:** 3.0
**Status:** Production Ready (v0.13.0 Core, v0.14.0 Admin/Refunds)
**Author:** Civic OS Development Team
**Last Updated:** 2025-12-31

**📋 Quick Links:**
- 📊 **[Payment State Diagram](./PAYMENT_STATE_DIAGRAM.md)** - Status flow visualization
- 📘 **This Document** - Complete payment system documentation

## Implementation Status

| Feature | Status | Version | Notes |
|---------|--------|---------|-------|
| Core payment processing | ✅ Implemented | v0.13.0 | Stripe PaymentIntent, webhooks, River jobs |
| Payment property type | ✅ Implemented | v0.13.0 | Auto-detected from FK to `payments.transactions` |
| PaymentBadgeComponent | ✅ Implemented | v0.13.0 | Reusable status display |
| PaymentCheckoutComponent | ✅ Implemented | v0.13.0 | Stripe Elements modal with polling |
| Webhook idempotency | ✅ Implemented | v0.13.0 | Dedupe via `metadata.webhooks` table |
| Retry with new transaction | ✅ Implemented | v0.13.0 | Failed payments create new records on retry |
| Admin payments page | ✅ Implemented | v0.14.0 | `/admin/payments` with search, filter, sort |
| Refund processing | ✅ Implemented | v0.14.0 | 1:M partial refunds, Stripe API integration |
| Processing fees | ✅ Implemented | v0.14.0 | Configurable fee % + flat rate |
| Email notifications | ✅ Implemented | v0.14.0 | `payment_succeeded`, `payment_refunded` templates |
| Metadata-driven initiation | ✅ Implemented | v0.14.0 | `payment_initiation_rpc` column in `metadata.entities` |
| Generic entity sync trigger | 🔜 Planned | — | Currently requires domain-specific triggers |
| Deferred capture mode | 🔜 Planned | — | Only immediate capture implemented |
| Conditional payment button | 🔜 Planned | — | `payment_show_condition` (like action buttons) |
| PayPal integration | 🔜 Planned | — | Only Stripe implemented |
| Multi-currency support | 🔜 Planned | — | Single currency per instance |

> **Note on Entity Sync:** The generic `update_entity_payment_status()` trigger described in this document is not yet implemented. You must create domain-specific trigger functions to sync payment status to your entities. See `examples/mottpark/init-scripts/09_mpra_payment_status_sync.sql` for a working pattern.

**Changelog:**
- v3.0 (2025-12-31): Documentation consolidation
  - Merged POC implementation summary into this document
  - Added Implementation Status table with ✅/🔜 markers
  - Added Processing Fees section (was undocumented)
  - Clarified async payment intent creation (frontend polling, not sync RPC)
  - Clarified entity sync requires domain-specific triggers
  - Added Conditional Payment Button Visibility to Future Enhancements
- v2.3 (2025-11-22): POC completion status update
  - Property Type approach implemented (direct FK pattern)
  - Core payment flow working (create → pay → webhook → status update)
  - PaymentBadgeComponent for consistent UI display
  - Retry logic with new transaction creation + orphaned PaymentIntent handling
- v2.2 (2025-11-21): Schema and service architecture revision
  - Moved payment tables to separate `payments` schema (prevents metadata pollution)
  - Separated payment-worker from consolidated-worker (optionality, bounded context)
  - Updated all table references: metadata.payment_* → payments.*
  - Updated PostgREST config to expose payments schema
  - Added architectural rationale for separate service
- v2.1 (2025-11-21): Incorporated patterns from Supabase Stripe Sync Engine analysis
  - Added webhook event tracking table for deduplication
  - Enhanced idempotency with timestamp-based WHERE clause pattern
  - Replaced switch statement with handler registry pattern
  - Clarified webhook acceptance pattern (always return 200)
  - Added fixture-based testing strategy
  - Improved schema design (indexes, proper PostgreSQL types)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [Entity Integration Pattern](#entity-integration-pattern)
5. [Processing Fees](#processing-fees) ✅ NEW
6. [Configurable Capture Timing](#configurable-capture-timing)
7. [Go Microservice Design](#go-microservice-design)
8. [Email Service Integration](#email-service-integration)
9. [RPC Functions](#rpc-functions)
10. [Webhook Architecture](#webhook-architecture)
11. [Frontend Components](#frontend-components)
12. [Security & Permissions](#security--permissions)
13. [Configuration](#configuration)
14. [Stripe Account Setup Guide](#stripe-account-setup-guide)
15. [Testing the Payment System](#testing-the-payment-system) ✅ NEW
16. [Design Patterns from Production Systems](#design-patterns-from-production-systems)
17. [Implementation Roadmap](#implementation-roadmap)
18. [Testing Strategy](#testing-strategy)
19. [Integration Examples](#integration-examples)

---

## Overview

### Purpose

The Payment Processing Microservice extends Civic OS with secure, provider-agnostic payment capabilities. Following the established Go + River pattern (similar to file storage), this system enables integrators to accept payments for any entity type (event registrations, facility bookings, permit applications, donations, etc.) without requiring PCI compliance or storing sensitive payment information.

### Key Features

- **Provider-Agnostic Design**: Abstract payment interface with Stripe implementation (PayPal planned)
- **Polymorphic Payments**: Any entity can accept payments via `entity_type` + `entity_id` pattern
- **Async Job Processing**: River-based queue for reliable payment operations with retries
- **Automatic Entity Sync**: Database triggers update entity `payment_status` when payments succeed/fail *(currently requires domain-specific triggers)*
- **Processing Fees**: Configurable fee calculation (percentage + flat rate) with fee-aware refund handling *(v0.14.0+)*
- **Configurable Capture Timing**: Support both immediate and deferred capture flows per entity type
- **Email Notifications**: SMTP-based email confirmations with customizable templates
- **Webhook Idempotency**: Timestamp-based idempotency with event tracking, audit trail for all provider callbacks
- **Permission-Based Access**: Integrates with Civic OS RBAC (admin + billing_staff roles)
- **Async Payment Intent Creation**: Frontend polls for payment status while River worker creates Stripe PaymentIntent
- **Specialized UI**: SystemListPage/SystemDetailPage for payment history with refund capabilities

### Design Constraints

Based on requirements gathering (November 2025):

- ✅ Manual payment initiation (Pay Now button triggers flow)
- ✅ Generic payment schema (single table, polymorphic entity references)
- ✅ Configurable capture mode (immediate OR deferred per entity type)
- ✅ Instance-wide provider configuration (single Stripe account per deployment)
- ✅ Full frontend UI (checkout component, history views, admin management)
- ✅ Authenticated users only (no anonymous checkout)
- ✅ Single currency per instance (multi-currency deferred to future)
- ✅ SMTP-based email notifications (SendGrid, Mailgun, AWS SES, custom SMTP)
- ✅ Standardized entity columns (`payment_status`, `payment_id`)
- ✅ Low concurrency focus (<10 concurrent payments expected)

### Target Use Cases

1. **Event Registrations** - Immediate capture when users register for events/workshops
2. **Facility Bookings** - Deferred capture (reserve funds, capture on admin approval or check-in)
3. **Permit Applications** - Either immediate or deferred based on approval workflow
4. **Donations** - Immediate capture for one-time contributions

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        Angular Frontend                          │
│  ┌────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ Checkout       │  │ SystemListPage  │  │ SystemDetailPage│  │
│  │ Component      │  │ (History)       │  │ (Detail + Refund│  │
│  └────────────────┘  └─────────────────┘  └─────────────────┘  │
└──────────────┬────────────────────┬──────────────────────────────┘
               │                    │
               │ Sync RPC Call      │ REST Queries
               ▼                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                         PostgREST API                             │
│  ┌──────────────────────────────────────┐  ┌──────────────────┐ │
│  │ RPCs:                                │  │ Views:           │ │
│  │ - create_payment_intent_sync (NEW)   │  │ payments.trans...│ │
│  │ - capture_payment_intent             │  │ (RLS-enabled)    │ │
│  │ - refund_payment                     │  │                  │ │
│  │ - process_webhook                    │  │                  │ │
│  └──────────────────────────────────────┘  └──────────────────┘ │
└──────────────┬────────────────────────────────────────────────────┘
               │
               │ Database Triggers → Enqueue Jobs + Sync Entities
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    PostgreSQL Database                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Triggers:                                                  │  │
│  │ - sync_entity_payment_status → Update entity table        │  │
│  │ - enqueue_payment_event → Email, capture queue            │  │
│  │ - enqueue_create_intent_job → River job                   │  │
│  │                                                            │  │
│  │ Tables:                                                    │  │
│  │ - payments.transactions (RLS)                             │  │
│  │ - payments.refunds                                        │  │
│  │ - payments.webhooks                                       │  │
│  │ - metadata.entities (payment_capture_mode column)         │  │
│  │ - metadata.river_job (queue)                              │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────┬────────────────────────────────────────────────────┘
               │
               │ Job Polling
               ▼
┌──────────────────────────────────────────────────────────────────┐
│            Go Payment Worker (Separate Service)                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ River Workers:                                           │   │
│  │ - CreateIntentWorker   → Stripe API: create intent      │   │
│  │ - CaptureWorker        → Stripe API: capture payment    │   │
│  │ - RefundWorker         → Stripe API: process refund     │   │
│  │ - ProcessWebhookWorker → Verify signature, update status│   │
│  │ - SendEmailWorker      → SMTP: send confirmations       │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Payment Provider Interface (Stripe, PayPal future)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  Note: Separate from consolidated-worker (files/notifications)   │
│        Optional deployment for instances not using payments      │
└──────────────┬────────────────────────────────────────────────────┘
               │
               │ HTTPS API Calls
               ▼
         ┌──────────────┐
         │ Stripe API   │
         └──────────────┘
```

### Data Flow: Create Payment (Immediate Capture)

```
1. User clicks "Pay Now" on event registration #456
   ↓
2. Frontend calls create_payment_intent_sync(entity_type, entity_id, amount)
   ↓
3. RPC inserts row into payment_transactions (status: pending_intent)
   ↓
4. Trigger enqueues CreateIntentJob in river_job
   ↓
5. RPC waits (pg_sleep loop) for client_secret to be populated
   ↓
6. Go worker creates Stripe PaymentIntent, updates client_secret
   ↓
7. RPC returns {payment_id, client_secret, amount} to frontend (1-2 sec total)
   ↓
8. Frontend mounts Stripe Elements with client_secret
   ↓
9. User enters card info (Stripe-hosted, PCI-compliant)
   ↓
10. User confirms → Stripe automatically confirms payment (immediate capture)
    ↓
11. Frontend receives success → Shows confirmation
    ↓
12. Stripe webhook: payment_intent.succeeded
    ↓
13. ProcessWebhookWorker verifies signature, updates status = 'succeeded'
    ↓
14. Trigger: sync_entity_payment_status → event_registrations.payment_status = 'paid'
    ↓
15. Trigger: enqueue_payment_event → SendEmailWorker sends confirmation email
```

### Data Flow: Create Payment (Deferred Capture)

```
1-9. [Same as immediate capture through user entering card info]
    ↓
10. Frontend skips confirmation → Payment intent created but NOT captured
    ↓
11. Entity-specific trigger fires when admin approves facility booking:
    ↓
    CREATE TRIGGER auto_capture_on_approval
      AFTER UPDATE ON facility_bookings
      WHEN (NEW.status = 'approved' AND OLD.status = 'pending')
      EXECUTE FUNCTION enqueue_payment_capture_job();
    ↓
12. CaptureWorker calls Stripe ConfirmPaymentIntent()
    ↓
13. Worker updates status = 'succeeded'
    ↓
14. Triggers fire: entity sync + email notification
```

---

## Database Schema

### Schema Organization

Payment tables live in a dedicated `payments` schema, separate from `metadata` schema:

**Rationale:**
- **Domain isolation** - Payments are a bounded context (money, compliance, multi-provider)
- **Prevents pollution** - `metadata` schema already contains entities, properties, roles, permissions, files, notifications
- **Security** - Schema-level audit logging and permissions
- **Optionality** - Instances not using payments don't need this schema
- **Multi-provider future** - Clean namespace for Stripe, PayPal, Square integrations

```sql
CREATE SCHEMA IF NOT EXISTS payments;
GRANT USAGE ON SCHEMA payments TO authenticated, anon;
COMMENT ON SCHEMA payments IS 'Payment processing tables (provider-agnostic core + provider-specific data)';
```

### Core Tables

#### `payments.transactions`

Primary table for all payment records with polymorphic entity references.

```sql
CREATE TABLE payments.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership & Context
  user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,  -- Foreign entity table name (e.g., 'event_registrations')
  entity_id BIGINT NOT NULL,  -- Foreign entity record ID

  -- Payment Details
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,  -- Enum: pending_intent, succeeded, failed, refunded, canceled
  description TEXT,

  -- Capture Mode (copied from metadata.entities at creation time)
  capture_mode TEXT NOT NULL DEFAULT 'immediate',  -- 'immediate' or 'deferred'

  -- Provider Integration
  provider TEXT NOT NULL,  -- 'stripe', 'paypal' (future)
  provider_payment_id TEXT,      -- Stripe: 'pi_1234567890'
  provider_customer_id TEXT,     -- Stripe: 'cus_1234567890' (for future subscriptions)
  provider_client_secret TEXT,   -- Stripe: client secret for frontend Elements

  -- Extensibility
  metadata JSONB DEFAULT '{}',  -- Provider-specific extra data

  -- Audit Trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,  -- Timestamp when status reached terminal state

  -- Constraints
  CONSTRAINT payment_transactions_status_check
    CHECK (status IN ('pending_intent', 'capturing', 'succeeded', 'failed', 'refunded', 'canceled')),
  CONSTRAINT payment_transactions_capture_mode_check
    CHECK (capture_mode IN ('immediate', 'deferred'))
);

-- Indexes for common queries
CREATE INDEX idx_payment_transactions_user_id ON payments.transactions(user_id);
CREATE INDEX idx_payment_transactions_entity ON payments.transactions(entity_type, entity_id);
CREATE INDEX idx_payment_transactions_status ON payments.transactions(status);
CREATE INDEX idx_payment_transactions_provider_id ON payments.transactions(provider_payment_id);
CREATE INDEX idx_payment_transactions_created_at ON payments.transactions(created_at DESC);

-- Trigger: Update updated_at timestamp
CREATE TRIGGER update_payment_transactions_updated_at
  BEFORE UPDATE ON payments.transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Enqueue job on INSERT (create intent)
CREATE TRIGGER enqueue_create_intent_job
  AFTER INSERT ON payments.transactions
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_payment_create_intent_job();

-- Trigger: Enqueue job on UPDATE (capture, cancel)
CREATE TRIGGER enqueue_payment_status_job
  AFTER UPDATE OF status ON payments.transactions
  FOR EACH ROW
  WHEN (NEW.status IN ('capturing', 'canceling'))
  EXECUTE FUNCTION enqueue_payment_status_job();

-- Trigger: Sync entity payment_status automatically
CREATE TRIGGER sync_entity_payment_status
  AFTER UPDATE OF status ON payments.transactions
  FOR EACH ROW
  WHEN (NEW.status IN ('succeeded', 'failed', 'refunded', 'canceled')
        AND OLD.status <> NEW.status)
  EXECUTE FUNCTION update_entity_payment_status();

-- Trigger: Enqueue payment events (email, analytics)
CREATE TRIGGER enqueue_payment_event
  AFTER UPDATE OF status ON payments.transactions
  FOR EACH ROW
  WHEN (NEW.status IN ('succeeded', 'failed', 'refunded')
        AND OLD.status <> NEW.status)
  EXECUTE FUNCTION enqueue_payment_event();
```

#### Trigger Function: Entity Payment Status Sync

> **⚠️ Not Yet Implemented**: This generic trigger function is part of the future polymorphic design. Current implementations require **domain-specific triggers** that map payment status to entity-specific fields. See `examples/mottpark/init-scripts/09_mpra_payment_status_sync.sql` for the current pattern.

This trigger automatically updates the entity's `payment_status` column when payment completes.

```sql
CREATE OR REPLACE FUNCTION update_entity_payment_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_table_name TEXT;
  v_entity_id BIGINT;
  v_new_status TEXT;
  v_sql TEXT;
BEGIN
  v_table_name := NEW.entity_type;
  v_entity_id := NEW.entity_id;

  -- Map payment status to entity-specific status
  v_new_status := CASE NEW.status
    WHEN 'succeeded' THEN 'paid'
    WHEN 'failed' THEN 'payment_failed'
    WHEN 'refunded' THEN 'refunded'
    WHEN 'canceled' THEN 'canceled'
  END;

  -- Dynamically update the entity (requires payment_status and payment_id columns)
  -- Using format() for safe dynamic table names (prevents SQL injection)
  v_sql := format(
    'UPDATE %I SET payment_status = $1, payment_id = $2, updated_at = NOW()
     WHERE id = $3',
    v_table_name
  );

  EXECUTE v_sql USING v_new_status, NEW.id, v_entity_id;

  RAISE NOTICE 'Updated %.payment_status to % for entity #%',
    v_table_name, v_new_status, v_entity_id;

  RETURN NEW;
EXCEPTION
  WHEN undefined_table THEN
    RAISE WARNING 'Entity table % does not exist, skipping payment status sync', v_table_name;
    RETURN NEW;
  WHEN undefined_column THEN
    RAISE WARNING 'Entity table % missing payment_status or payment_id column', v_table_name;
    RETURN NEW;
END;
$$;
```

#### Trigger Function: Payment Event Queue

Enqueues background jobs for email notifications and other async workflows.

```sql
CREATE OR REPLACE FUNCTION enqueue_payment_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Enqueue event job for email notifications, analytics, etc.
  INSERT INTO river_job (
    kind,
    args,
    priority,
    scheduled_at,
    state
  ) VALUES (
    'payment_status_changed',
    jsonb_build_object(
      'payment_id', NEW.id,
      'entity_type', NEW.entity_type,
      'entity_id', NEW.entity_id,
      'user_id', NEW.user_id,
      'old_status', OLD.status,
      'new_status', NEW.status,
      'amount', NEW.amount,
      'currency', NEW.currency
    ),
    2, -- Normal priority
    NOW(),
    'available'
  );

  RETURN NEW;
END;
$$;
```

#### `payments.refunds`

Tracks refund operations (full or partial).

```sql
CREATE TABLE payments.refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments.transactions(id) ON DELETE CASCADE,

  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL,  -- pending, succeeded, failed

  provider_refund_id TEXT,  -- Stripe: 'ref_1234567890'

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT payment_refunds_status_check
    CHECK (status IN ('pending', 'succeeded', 'failed'))
);

CREATE INDEX idx_payment_refunds_payment_id ON payments.refunds(payment_id);

-- Trigger: Enqueue refund job on INSERT
CREATE TRIGGER enqueue_refund_job
  AFTER INSERT ON payments.refunds
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_payment_refund_job();
```

#### `payments.webhooks`

Audit log and deduplication table for all webhook events. Uses atomic INSERT...ON CONFLICT pattern to prevent race conditions.

```sql
CREATE TABLE payments.webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  provider TEXT NOT NULL,              -- 'stripe', 'paypal'
  provider_event_id TEXT NOT NULL,     -- Stripe: 'evt_1234567890'
  event_type TEXT NOT NULL,            -- Stripe: 'payment_intent.succeeded'
  payload JSONB NOT NULL,              -- Full webhook payload

  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,  -- Signature verification status

  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  error TEXT,  -- If processing failed

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency constraint (prevents duplicate webhook processing)
  CONSTRAINT payment_webhook_events_unique_event
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX idx_payment_webhook_events_processed ON payments.webhooks(processed, received_at);
CREATE INDEX idx_payment_webhook_events_event_type ON payments.webhooks(event_type);

-- Trigger: Enqueue webhook processing job on INSERT
CREATE TRIGGER enqueue_webhook_processing_job
  AFTER INSERT ON payments.webhooks
  FOR EACH ROW
  WHEN (NEW.processed = FALSE)  -- Only enqueue if not already processed
  EXECUTE FUNCTION enqueue_payment_webhook_job();
```

#### Extension to `metadata.entities`

Add payment configuration to entities table.

```sql
-- Add payment_capture_mode column to metadata.entities
ALTER TABLE metadata.entities
  ADD COLUMN payment_capture_mode TEXT DEFAULT 'immediate'
    CHECK (payment_capture_mode IN ('immediate', 'deferred'));

-- Example configuration
UPDATE metadata.entities SET payment_capture_mode = 'immediate' WHERE table_name = 'event_registrations';
UPDATE metadata.entities SET payment_capture_mode = 'deferred' WHERE table_name = 'facility_bookings';
UPDATE metadata.entities SET payment_capture_mode = 'immediate' WHERE table_name = 'permit_applications';
```

### Public Views

#### `payment_transactions` (RLS-enabled view)

Single view for user and admin access with row-level security.

```sql
CREATE VIEW payment_transactions AS
SELECT
  id,
  user_id,
  entity_type,
  entity_id,
  amount,
  currency,
  status,
  description,
  capture_mode,
  provider,
  provider_payment_id,
  -- Hide client_secret from view (sensitive, only via RPC)
  created_at,
  updated_at,
  completed_at
FROM payments.transactions;

-- Grant access
GRANT SELECT ON payment_transactions TO authenticated;

-- RLS on underlying table
ALTER TABLE payments.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own payments, admins/billing_staff see all"
  ON payments.transactions
  FOR SELECT
  USING (
    user_id = current_user_id()
    OR is_admin()
    OR has_permission('payment_transactions', 'read')
  );
```

---

## Entity Integration Pattern

### Schema Convention

**REQUIRED**: All payable entities must include these columns:

```sql
-- Example: Event Registrations
CREATE TABLE event_registrations (
  id BIGSERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id),
  user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id),

  -- Standard payment columns (REQUIRED)
  payment_status TEXT DEFAULT 'pending',
  payment_id UUID REFERENCES payments.transactions(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_payment_status
    CHECK (payment_status IN ('pending', 'paid', 'payment_failed', 'refunded', 'canceled'))
);

-- REQUIRED: Index foreign key columns
CREATE INDEX idx_event_registrations_event_id ON event_registrations(event_id);
CREATE INDEX idx_event_registrations_user_id ON event_registrations(user_id);
CREATE INDEX idx_event_registrations_payment_id ON event_registrations(payment_id);
```

### Automatic Status Sync

> **⚠️ Current Implementation**: The generic `update_entity_payment_status()` trigger described below is **not yet implemented**. You must create domain-specific trigger functions. See `examples/mottpark/init-scripts/09_mpra_payment_status_sync.sql` for a working pattern.

The target design would have `update_entity_payment_status()` trigger automatically update these columns when payment status changes:

- `succeeded` → `payment_status = 'paid'`
- `failed` → `payment_status = 'payment_failed'`
- `refunded` → `payment_status = 'refunded'`
- `canceled` → `payment_status = 'canceled'`

**Future goal**: No additional code needed - happens atomically in the same transaction as payment status update.

### Integration Steps for New Payable Entity

1. **Add columns** to your entity table:
   ```sql
   ALTER TABLE your_table ADD COLUMN payment_status TEXT DEFAULT 'pending';
   ALTER TABLE your_table ADD COLUMN payment_id UUID REFERENCES payments.transactions(id);
   ALTER TABLE your_table ADD CONSTRAINT valid_payment_status
     CHECK (payment_status IN ('pending', 'paid', 'payment_failed', 'refunded', 'canceled'));
   CREATE INDEX idx_your_table_payment_id ON your_table(payment_id);
   ```

2. **Configure capture mode** in metadata:
   ```sql
   UPDATE metadata.entities
   SET payment_capture_mode = 'immediate'  -- or 'deferred'
   WHERE table_name = 'your_table';
   ```

3. **Add UI button** to trigger payment (see Integration Examples section)

4. **Done!** Payment status syncs automatically.

---

## Processing Fees

**Status:** ✅ Implemented (v0.14.0)

Processing fees allow you to pass credit card processing costs to users. Fees are calculated by the payment worker and displayed transparently in the checkout UI.

### Fee Configuration

Fees are configured via environment variables in the payment-worker:

```bash
# Environment variables for payment-worker
PAYMENT_FEE_PERCENT=2.9      # Percentage fee (e.g., 2.9%)
PAYMENT_FEE_FLAT_CENTS=30    # Flat fee in cents (e.g., $0.30)
PAYMENT_FEE_REFUNDABLE=false # Whether fees are refunded with the payment
```

**Fee Calculation Formula:**
```
processing_fee = (amount * fee_percent / 100) + (fee_flat_cents / 100)
total_amount = amount + processing_fee
```

**Example:** For a $50.00 payment with 2.9% + $0.30 fees:
- Base amount: $50.00
- Processing fee: ($50.00 × 0.029) + $0.30 = $1.75
- Total charged: $51.75

### Database Schema

The `payments.transactions` table stores fee details for auditing:

```sql
-- Fee columns in payments.transactions
processing_fee NUMERIC(10,2),    -- Calculated fee amount
fee_percent NUMERIC(5,2),        -- Fee % at time of payment (e.g., 2.90)
fee_flat_cents INTEGER,          -- Flat fee in cents (e.g., 30)
fee_refundable BOOLEAN,          -- Whether fee is included in refunds
total_amount NUMERIC(10,2),      -- amount + processing_fee
max_refundable NUMERIC(10,2)     -- Max refundable (respects fee_refundable)
```

### Frontend Display

The `PaymentCheckoutComponent` automatically shows a fee breakdown when fees are configured:

```
┌─────────────────────────────────────┐
│ Payment Summary                     │
├─────────────────────────────────────┤
│ Amount:              $50.00         │
│ Processing Fee:       $1.75         │
│ ─────────────────────────────       │
│ Total:               $51.75         │
└─────────────────────────────────────┘
```

### Refund Behavior

When `PAYMENT_FEE_REFUNDABLE=false`:
- `max_refundable` = `amount` (original price only)
- Full refund returns base amount; processing fee is retained

When `PAYMENT_FEE_REFUNDABLE=true`:
- `max_refundable` = `total_amount` (includes fees)
- Full refund returns entire charged amount

The `PaymentBadgeComponent` displays accurate refund amounts based on these settings.

### TypeScript Interface

```typescript
// From src/app/interfaces/entity.ts
interface PaymentValue {
  amount: number;           // Base amount (original pricing)
  processing_fee: number;   // Processing fee amount
  total_amount: number;     // Total charged to Stripe (amount + processing_fee)
  max_refundable: number;   // Maximum refundable (respects fee_refundable)
  fee_percent?: number;     // Fee % applied (e.g., 2.9 for 2.9%)
  fee_flat_cents?: number;  // Flat fee in cents (e.g., 30 for $0.30)
  fee_refundable: boolean;  // Whether fee was refundable at payment time
  // ... other fields
}
```

---

## Configurable Capture Timing

### Capture Modes

| Mode | Behavior | Use Cases |
|------|----------|-----------|
| **Immediate** | Card charged when user confirms payment | Event registrations, permit fees, donations |
| **Deferred** | Funds reserved, captured later via trigger | Facility bookings (capture on approval), rentals (capture on pickup) |

### Example: Facility Booking Auto-Capture on Approval

```sql
-- Trigger on facility_bookings table captures payment when admin approves
CREATE OR REPLACE FUNCTION enqueue_payment_capture_on_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only trigger if status changed to 'approved' and payment exists
  IF NEW.status = 'approved'
     AND OLD.status <> 'approved'
     AND NEW.payment_id IS NOT NULL THEN

    -- Enqueue capture job
    INSERT INTO river_job (
      kind,
      args,
      priority,
      scheduled_at,
      state
    ) VALUES (
      'payment_capture',
      jsonb_build_object('payment_id', NEW.payment_id),
      1, -- High priority
      NOW(),
      'available'
    );

    RAISE NOTICE 'Enqueued capture job for payment %', NEW.payment_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_capture_on_approval
  AFTER UPDATE OF status ON facility_bookings
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_payment_capture_on_approval();
```

### Example: Equipment Rental Auto-Capture on Check-In

```sql
-- Capture payment when customer picks up rental equipment
CREATE TRIGGER auto_capture_on_checkin
  AFTER UPDATE OF checkin_time ON equipment_rentals
  FOR EACH ROW
  WHEN (NEW.checkin_time IS NOT NULL
        AND OLD.checkin_time IS NULL
        AND NEW.payment_id IS NOT NULL)
  EXECUTE FUNCTION enqueue_payment_capture_job();
```

**Integrator Flexibility**: These trigger examples can be customized to match any workflow - capture on approval, check-in, expiration, manual admin action, etc.

---

## Go Microservice Design

### Architectural Decision: Separate Payment Worker

The payment service is deployed as a **separate Go microservice** (`payment-worker`), independent from the `consolidated-worker` (which handles files, thumbnails, and notifications).

**Rationale:**

1. **Optionality** - Instances not using payment features don't deploy payment code or dependencies
2. **Bounded context** - Payments are a distinct domain (money, compliance, multi-provider)
3. **Independent deployment** - Update payment features without redeploying file storage or notifications
4. **Failure isolation** - Payment provider bugs don't crash file uploads or email sending
5. **Security** - Smaller attack surface, easier PCI compliance auditing
6. **Multi-provider future** - Clean namespace for adding PayPal, Square without bloating other services

**Trade-off:** One additional container to deploy (acceptable given optionality and isolation benefits)

**Service Comparison:**

| Service | Handles | Deploy When... |
|---------|---------|----------------|
| `consolidated-worker` | Files, thumbnails, notifications | Always (core framework features) |
| `payment-worker` | Stripe, PayPal, payment webhooks | Only if accepting payments |

### Directory Structure

```
services/payment-worker/
├── cmd/
│   └── worker/
│       └── main.go              # Entry point, River client initialization
├── internal/
│   ├── config/
│   │   └── config.go            # Environment configuration
│   ├── providers/
│   │   ├── provider.go          # PaymentProvider interface
│   │   ├── stripe.go            # Stripe implementation
│   │   └── paypal.go            # PayPal implementation (future)
│   ├── workers/
│   │   ├── create_intent.go     # CreateIntentWorker
│   │   ├── capture.go           # CaptureWorker
│   │   ├── refund.go            # RefundWorker
│   │   ├── process_webhook.go   # ProcessWebhookWorker (with signature verification)
│   │   ├── send_email.go        # SendEmailWorker (NEW)
│   │   └── payment_event.go     # PaymentEventWorker (routes to email, etc.)
│   ├── email/
│   │   ├── smtp.go              # SMTP client wrapper
│   │   └── templates.go         # Email template rendering
│   └── db/
│       └── queries.go           # Database helper functions
├── go.mod
├── go.sum
└── README.md
```

### Payment Provider Interface

```go
// internal/providers/provider.go
package providers

import (
	"context"
	"time"
)

// PaymentProvider abstracts payment operations across providers
type PaymentProvider interface {
	// CreateIntent reserves funds (returns provider payment ID + client secret)
	CreateIntent(ctx context.Context, params CreateIntentParams) (*PaymentIntent, error)

	// CaptureIntent confirms and captures reserved funds
	CaptureIntent(ctx context.Context, providerPaymentID string) (*PaymentResult, error)

	// CancelIntent releases reserved funds without charging
	CancelIntent(ctx context.Context, providerPaymentID string) error

	// CreateRefund issues refund for captured payment
	CreateRefund(ctx context.Context, params RefundParams) (*RefundResult, error)

	// GetPaymentStatus retrieves current status from provider
	GetPaymentStatus(ctx context.Context, providerPaymentID string) (*PaymentStatus, error)

	// VerifyWebhookSignature validates webhook authenticity
	// Returns the parsed event if signature is valid
	VerifyWebhookSignature(ctx context.Context, payload []byte, signature string) (interface{}, error)
}

type CreateIntentParams struct {
	Amount      int64  // Amount in cents (e.g., 5000 = $50.00)
	Currency    string // ISO 4217 code (e.g., "usd")
	Description string
	CaptureMode string // "immediate" or "deferred"
	CustomerID  string // Optional: existing customer ID
	Metadata    map[string]string
}

type PaymentIntent struct {
	ProviderPaymentID string
	ClientSecret      string
	Status            string
	CreatedAt         time.Time
}

type PaymentResult struct {
	ProviderPaymentID string
	Status            string
	CompletedAt       time.Time
}

type RefundParams struct {
	ProviderPaymentID string
	Amount            int64 // Optional: partial refund amount
	Reason            string
}

type RefundResult struct {
	ProviderRefundID string
	Status           string
	Amount           int64
	CompletedAt      time.Time
}

type PaymentStatus struct {
	Status      string
	Amount      int64
	Currency    string
	CompletedAt *time.Time
}
```

### Stripe Implementation (Updated for Capture Mode)

```go
// internal/providers/stripe.go
package providers

import (
	"context"
	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/paymentintent"
	"github.com/stripe/stripe-go/v76/refund"
	"github.com/stripe/stripe-go/v76/webhook"
)

type StripeProvider struct {
	apiKey        string
	webhookSecret string
}

func NewStripeProvider(apiKey, webhookSecret string) *StripeProvider {
	stripe.Key = apiKey
	return &StripeProvider{
		apiKey:        apiKey,
		webhookSecret: webhookSecret,
	}
}

func (p *StripeProvider) CreateIntent(ctx context.Context, params CreateIntentParams) (*PaymentIntent, error) {
	piParams := &stripe.PaymentIntentParams{
		Amount:      stripe.Int64(params.Amount),
		Currency:    stripe.String(params.Currency),
		Description: stripe.String(params.Description),
	}

	// Configure capture method based on mode
	if params.CaptureMode == "immediate" {
		piParams.CaptureMethod = stripe.String(string(stripe.PaymentIntentCaptureMethodAutomatic))
	} else {
		piParams.CaptureMethod = stripe.String(string(stripe.PaymentIntentCaptureMethodManual))
	}

	if params.CustomerID != "" {
		piParams.Customer = stripe.String(params.CustomerID)
	}

	for k, v := range params.Metadata {
		piParams.AddMetadata(k, v)
	}

	pi, err := paymentintent.New(piParams)
	if err != nil {
		return nil, err
	}

	return &PaymentIntent{
		ProviderPaymentID: pi.ID,
		ClientSecret:      pi.ClientSecret,
		Status:            string(pi.Status),
		CreatedAt:         time.Unix(pi.Created, 0),
	}, nil
}

func (p *StripeProvider) CaptureIntent(ctx context.Context, providerPaymentID string) (*PaymentResult, error) {
	pi, err := paymentintent.Capture(
		providerPaymentID,
		&stripe.PaymentIntentCaptureParams{},
	)
	if err != nil {
		return nil, err
	}

	var completedAt time.Time
	if pi.Status == stripe.PaymentIntentStatusSucceeded {
		completedAt = time.Now()
	}

	return &PaymentResult{
		ProviderPaymentID: pi.ID,
		Status:            string(pi.Status),
		CompletedAt:       completedAt,
	}, nil
}

func (p *StripeProvider) CreateRefund(ctx context.Context, params RefundParams) (*RefundResult, error) {
	refundParams := &stripe.RefundParams{
		PaymentIntent: stripe.String(params.ProviderPaymentID),
	}

	if params.Amount > 0 {
		refundParams.Amount = stripe.Int64(params.Amount)
	}

	if params.Reason != "" {
		refundParams.Reason = stripe.String(params.Reason)
	}

	r, err := refund.New(refundParams)
	if err != nil {
		return nil, err
	}

	return &RefundResult{
		ProviderRefundID: r.ID,
		Status:           string(r.Status),
		Amount:           r.Amount,
		CompletedAt:      time.Unix(r.Created, 0),
	}, nil
}

func (p *StripeProvider) VerifyWebhookSignature(ctx context.Context, payload []byte, signature string) error {
	_, err := webhook.ConstructEvent(payload, signature, p.webhookSecret)
	return err
}

// ... additional methods (CancelIntent, GetPaymentStatus)
```

### Webhook Handler Registry Pattern

Instead of a monolithic switch statement, we use a handler registry for extensibility and testability:

```go
// internal/webhooks/handler.go
package webhooks

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EventHandler processes a specific webhook event type
type EventHandler interface {
	HandleEvent(ctx context.Context, db *pgxpool.Pool, payload map[string]interface{}) error
}

// HandlerRegistry maps event types to handlers
type HandlerRegistry struct {
	handlers map[string]EventHandler
	logger   *zerolog.Logger
}

func NewHandlerRegistry(logger *zerolog.Logger) *HandlerRegistry {
	return &HandlerRegistry{
		handlers: make(map[string]EventHandler),
		logger:   logger,
	}
}

func (r *HandlerRegistry) Register(eventType string, handler EventHandler) {
	r.handlers[eventType] = handler
}

func (r *HandlerRegistry) Dispatch(ctx context.Context, db *pgxpool.Pool, eventType string, payload map[string]interface{}) error {
	handler, ok := r.handlers[eventType]
	if !ok {
		// Log unknown events instead of crashing
		r.logger.Warn().
			Str("event_type", eventType).
			Msg("Unknown webhook event type - storing for investigation")
		return r.storeUnknownEvent(ctx, db, eventType, payload)
	}

	return handler.HandleEvent(ctx, db, payload)
}

func (r *HandlerRegistry) storeUnknownEvent(ctx context.Context, db *pgxpool.Pool, eventType string, payload map[string]interface{}) error {
	// Store in a separate table for manual investigation
	_, err := db.Exec(ctx, `
		INSERT INTO payments.unknown_webhooks (event_type, payload, received_at)
		VALUES ($1, $2, NOW())
	`, eventType, payload)
	return err
}
```

**Example Handler Implementation:**

```go
// internal/webhooks/handlers/payment_succeeded.go
package handlers

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PaymentIntentSucceededHandler struct{}

func (h *PaymentIntentSucceededHandler) HandleEvent(
	ctx context.Context,
	db *pgxpool.Pool,
	payload map[string]interface{},
) error {
	// Extract payment_intent ID from nested payload
	data, ok := payload["data"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("invalid payload structure")
	}

	obj, ok := data["object"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("invalid data.object structure")
	}

	piID, ok := obj["id"].(string)
	if !ok {
		return fmt.Errorf("missing payment intent ID")
	}

	// Update payment status (idempotent via WHERE clause)
	_, err := db.Exec(ctx, `
		UPDATE payments.transactions
		SET
			status = 'succeeded',
			completed_at = NOW(),
			metadata = jsonb_set(COALESCE(metadata, '{}'), '{webhook_confirmed}', 'true')
		WHERE provider_payment_id = $1
		  AND status NOT IN ('succeeded', 'refunded')  -- Prevent overwriting terminal states
	`, piID)

	return err
}
```

**Handler Setup in main.go:**

```go
func setupWebhookHandlers(logger *zerolog.Logger) *webhooks.HandlerRegistry {
	registry := webhooks.NewHandlerRegistry(logger)

	// Register Stripe event handlers
	registry.Register("payment_intent.succeeded", &handlers.PaymentIntentSucceededHandler{})
	registry.Register("payment_intent.payment_failed", &handlers.PaymentIntentFailedHandler{})
	registry.Register("payment_intent.canceled", &handlers.PaymentIntentCanceledHandler{})
	registry.Register("charge.refunded", &handlers.ChargeRefundedHandler{})

	// Future: Easy to add more handlers without touching core routing logic
	// registry.Register("charge.dispute.created", &handlers.DisputeCreatedHandler{})

	return registry
}
```

### River Workers

#### CreateIntentWorker

```go
// internal/workers/create_intent.go
package workers

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"your-module/internal/providers"
)

type CreateIntentArgs struct {
	PaymentID string `json:"payment_id"`
}

func (CreateIntentArgs) Kind() string { return "payment_create_intent" }

type CreateIntentWorker struct {
	river.WorkerDefaults[CreateIntentArgs]
	db       *pgxpool.Pool
	provider providers.PaymentProvider
}

func (w *CreateIntentWorker) Work(ctx context.Context, job *river.Job[CreateIntentArgs]) error {
	// 1. Fetch payment record
	var payment struct {
		UserID      string
		Amount      float64
		Currency    string
		Description string
		CaptureMode string
		EntityType  string
		EntityID    int64
	}

	err := w.db.QueryRow(ctx, `
		SELECT user_id, amount, currency, description, capture_mode, entity_type, entity_id
		FROM payments.transactions
		WHERE id = $1
	`, job.Args.PaymentID).Scan(
		&payment.UserID,
		&payment.Amount,
		&payment.Currency,
		&payment.Description,
		&payment.CaptureMode,
		&payment.EntityType,
		&payment.EntityID,
	)
	if err != nil {
		return fmt.Errorf("fetch payment: %w", err)
	}

	// 2. Create payment intent with provider
	amountCents := int64(payment.Amount * 100)
	intent, err := w.provider.CreateIntent(ctx, providers.CreateIntentParams{
		Amount:      amountCents,
		Currency:    payment.Currency,
		Description: payment.Description,
		CaptureMode: payment.CaptureMode,
		Metadata: map[string]string{
			"payment_id":   job.Args.PaymentID,
			"entity_type":  payment.EntityType,
			"entity_id":    fmt.Sprintf("%d", payment.EntityID),
			"capture_mode": payment.CaptureMode,
		},
	})
	if err != nil {
		// Update payment status to failed
		_, _ = w.db.Exec(ctx, `
			UPDATE payments.transactions
			SET status = 'failed', metadata = jsonb_set(metadata, '{error}', to_jsonb($1::text))
			WHERE id = $2
		`, err.Error(), job.Args.PaymentID)

		return fmt.Errorf("create intent: %w", err)
	}

	// 3. Update payment record with provider details
	_, err = w.db.Exec(ctx, `
		UPDATE payments.transactions
		SET
			provider_payment_id = $1,
			provider_client_secret = $2,
			status = 'pending_intent',
			metadata = jsonb_set(metadata, '{provider_status}', to_jsonb($3::text))
		WHERE id = $4
	`, intent.ProviderPaymentID, intent.ClientSecret, intent.Status, job.Args.PaymentID)

	if err != nil {
		return fmt.Errorf("update payment record: %w", err)
	}

	return nil
}
```

#### ProcessWebhookWorker (with Handler Registry)

```go
// internal/workers/process_webhook.go
package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"your-module/internal/webhooks"
)

type ProcessWebhookArgs struct {
	WebhookEventID string `json:"webhook_event_id"`
}

func (ProcessWebhookArgs) Kind() string { return "payment_process_webhook" }

type ProcessWebhookWorker struct {
	river.WorkerDefaults[ProcessWebhookArgs]
	db              *pgxpool.Pool
	handlerRegistry *webhooks.HandlerRegistry
}

func (w *ProcessWebhookWorker) Work(ctx context.Context, job *river.Job[ProcessWebhookArgs]) error {
	// Acquire advisory lock to prevent concurrent processing of same webhook
	// Lock is automatically released at transaction end
	lockID := hashWebhookEventID(job.Args.WebhookEventID)

	_, err := w.db.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)
	if err != nil {
		return fmt.Errorf("acquire advisory lock: %w", err)
	}

	// Fetch webhook event
	var eventType string
	var payloadBytes []byte
	var alreadyProcessed bool

	err = w.db.QueryRow(ctx, `
		SELECT event_type, payload::text, processed
		FROM payments.webhooks
		WHERE id = $1
	`, job.Args.WebhookEventID).Scan(&eventType, &payloadBytes, &alreadyProcessed)

	if err != nil {
		return fmt.Errorf("fetch webhook event: %w", err)
	}

	// Idempotency check: Skip if already processed
	if alreadyProcessed {
		w.logger.Info().
			Str("webhook_event_id", job.Args.WebhookEventID).
			Msg("Webhook already processed, skipping")
		return nil
	}

	// Parse payload
	var payload map[string]interface{}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}

	// Dispatch to handler registry (replaces switch statement)
	err = w.handlerRegistry.Dispatch(ctx, w.db, eventType, payload)

	if err != nil {
		// Mark as failed with error message
		_, _ = w.db.Exec(ctx, `
			UPDATE payments.webhooks
			SET error = $1
			WHERE id = $2
		`, err.Error(), job.Args.WebhookEventID)
		return err
	}

	// Mark as processed
	_, err = w.db.Exec(ctx, `
		UPDATE payments.webhooks
		SET processed = TRUE, processed_at = NOW(), signature_verified = TRUE
		WHERE id = $1
	`, job.Args.WebhookEventID)

	return err
}

// hashWebhookEventID generates consistent advisory lock IDs
func hashWebhookEventID(eventID string) int64 {
	h := fnv.New64a()
	h.Write([]byte(eventID))
	return int64(h.Sum64())
}
```

---

## Email Service Integration

### SMTP Configuration

Email notifications are sent via SMTP (supports SendGrid, Mailgun, AWS SES, Postfix, etc.).

**Environment Variables:**

```bash
# Go Payment Service
SMTP_HOST="smtp.sendgrid.net"      # Or smtp.gmail.com, smtp-relay.gmail.com, etc.
SMTP_PORT="587"                     # 587 for TLS, 465 for SSL, 25 for plain
SMTP_USERNAME="apikey"              # SendGrid uses 'apikey', others use email
SMTP_PASSWORD="SG.xxx"              # API key or password
SMTP_FROM_EMAIL="noreply@civic-os.org"
SMTP_FROM_NAME="Civic OS Payments"
SMTP_USE_TLS="true"
```

### Email Worker

```go
// internal/workers/send_email.go
package workers

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"your-module/internal/email"
)

type SendEmailArgs struct {
	To          string `json:"to"`
	Subject     string `json:"subject"`
	BodyHTML    string `json:"body_html"`
	BodyText    string `json:"body_text"`
	TemplateID  string `json:"template_id"`  // Optional: for dynamic templates
	TemplateData map[string]interface{} `json:"template_data"`
}

func (SendEmailArgs) Kind() string { return "send_email" }

type SendEmailWorker struct {
	river.WorkerDefaults[SendEmailArgs]
	smtpClient *email.SMTPClient
}

func (w *SendEmailWorker) Work(ctx context.Context, job *river.Job[SendEmailArgs]) error {
	args := job.Args

	// Render template if template_id provided
	var bodyHTML, bodyText string
	if args.TemplateID != "" {
		var err error
		bodyHTML, err = email.RenderTemplate(args.TemplateID, args.TemplateData)
		if err != nil {
			return fmt.Errorf("render template: %w", err)
		}
		// Generate plain text version (strip HTML)
		bodyText = email.StripHTML(bodyHTML)
	} else {
		bodyHTML = args.BodyHTML
		bodyText = args.BodyText
	}

	// Send email via SMTP
	err := w.smtpClient.Send(ctx, email.Message{
		To:       args.To,
		Subject:  args.Subject,
		BodyHTML: bodyHTML,
		BodyText: bodyText,
	})

	if err != nil {
		return fmt.Errorf("send email: %w", err)
	}

	return nil
}
```

### Payment Event Worker (Routes to Email)

```go
// internal/workers/payment_event.go
package workers

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
)

type PaymentStatusChangedArgs struct {
	PaymentID  string  `json:"payment_id"`
	EntityType string  `json:"entity_type"`
	EntityID   int64   `json:"entity_id"`
	UserID     string  `json:"user_id"`
	OldStatus  string  `json:"old_status"`
	NewStatus  string  `json:"new_status"`
	Amount     float64 `json:"amount"`
	Currency   string  `json:"currency"`
}

func (PaymentStatusChangedArgs) Kind() string { return "payment_status_changed" }

type PaymentEventWorker struct {
	river.WorkerDefaults[PaymentStatusChangedArgs]
	db *pgxpool.Pool
}

func (w *PaymentEventWorker) Work(ctx context.Context, job *river.Job[PaymentStatusChangedArgs]) error {
	args := job.Args

	// Fetch user email
	var userEmail string
	err := w.db.QueryRow(ctx, `
		SELECT email FROM metadata.civic_os_users WHERE id = $1
	`, args.UserID).Scan(&userEmail)

	if err != nil {
		return fmt.Errorf("fetch user email: %w", err)
	}

	// Route to appropriate handler
	switch args.NewStatus {
	case "succeeded":
		return w.sendPaymentSuccessEmail(ctx, userEmail, args)
	case "failed":
		return w.sendPaymentFailedEmail(ctx, userEmail, args)
	case "refunded":
		return w.sendRefundEmail(ctx, userEmail, args)
	default:
		return nil // No email for other statuses
	}
}

func (w *PaymentEventWorker) sendPaymentSuccessEmail(
	ctx context.Context,
	userEmail string,
	args PaymentStatusChangedArgs,
) error {
	// Enqueue email job
	_, err := w.db.Exec(ctx, `
		INSERT INTO river_job (kind, args, priority, scheduled_at, state)
		VALUES (
			'send_email',
			$1,
			2,
			NOW(),
			'available'
		)
	`, map[string]interface{}{
		"to":      userEmail,
		"subject": fmt.Sprintf("Payment Confirmation - $%.2f", args.Amount),
		"template_id": "payment_success",
		"template_data": map[string]interface{}{
			"amount":      args.Amount,
			"currency":    args.Currency,
			"entity_type": args.EntityType,
			"entity_id":   args.EntityID,
			"payment_id":  args.PaymentID,
		},
	})

	return err
}

// ... similar methods for failed and refunded emails
```

### Email Templates

```go
// internal/email/templates.go
package email

import (
	"bytes"
	"html/template"
)

var templates = map[string]string{
	"payment_success": `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif;">
  <h2>Payment Confirmed</h2>
  <p>Thank you! Your payment of <strong>{{.currency}} {{.amount}}</strong> has been processed successfully.</p>
  <p><strong>Payment ID:</strong> {{.payment_id}}</p>
  <p><strong>Entity:</strong> {{.entity_type}} #{{.entity_id}}</p>
  <p>You can view your payment history at: <a href="https://your-domain.com/system/payment_transactions">My Payments</a></p>
  <hr>
  <p style="color: #666; font-size: 12px;">This is an automated message from Civic OS.</p>
</body>
</html>
`,
	"payment_failed": `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif;">
  <h2 style="color: red;">Payment Failed</h2>
  <p>Unfortunately, your payment of <strong>{{.currency}} {{.amount}}</strong> could not be processed.</p>
  <p><strong>Payment ID:</strong> {{.payment_id}}</p>
  <p>Please try again or contact support if the problem persists.</p>
  <hr>
  <p style="color: #666; font-size: 12px;">This is an automated message from Civic OS.</p>
</body>
</html>
`,
	// Add more templates...
}

func RenderTemplate(templateID string, data map[string]interface{}) (string, error) {
	tmplStr, ok := templates[templateID]
	if !ok {
		return "", fmt.Errorf("template not found: %s", templateID)
	}

	tmpl, err := template.New(templateID).Parse(tmplStr)
	if err != nil {
		return "", err
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", err
	}

	return buf.String(), nil
}
```

---

## RPC Functions

### `create_payment_intent_sync()` (Synchronous)

**NEW**: Replaces polling approach - RPC waits for payment intent creation before returning.

```sql
CREATE OR REPLACE FUNCTION create_payment_intent_sync(
  p_entity_type TEXT,
  p_entity_id BIGINT,
  p_amount NUMERIC,
  p_description TEXT DEFAULT NULL
) RETURNS JSONB
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment_id UUID;
  v_client_secret TEXT;
  v_currency TEXT;
  v_capture_mode TEXT;
  v_wait_count INT := 0;
BEGIN
  -- Input validation
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  -- Verify entity exists (basic check)
  -- Note: Can't validate polymorphic FK at DB level, but can check table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = p_entity_type
  ) THEN
    RAISE EXCEPTION 'Invalid entity type: %', p_entity_type;
  END IF;

  -- Get instance currency and capture mode from config
  SELECT value INTO v_currency
  FROM metadata.config
  WHERE key = 'payment_currency';

  IF v_currency IS NULL THEN
    v_currency := 'USD';
  END IF;

  -- Get capture mode from entity metadata
  SELECT payment_capture_mode INTO v_capture_mode
  FROM metadata.entities
  WHERE table_name = p_entity_type;

  IF v_capture_mode IS NULL THEN
    v_capture_mode := 'immediate';
  END IF;

  -- Create payment record
  INSERT INTO payments.transactions (
    user_id,
    entity_type,
    entity_id,
    amount,
    currency,
    status,
    provider,
    capture_mode,
    description
  ) VALUES (
    current_user_id(),
    p_entity_type,
    p_entity_id,
    p_amount,
    v_currency,
    'pending_intent',
    'stripe',  -- TODO: Get from config for multi-provider support
    v_capture_mode,
    COALESCE(p_description, format('Payment for %s #%s', p_entity_type, p_entity_id))
  )
  RETURNING id INTO v_payment_id;

  -- Trigger will enqueue CreateIntentJob

  -- Wait for worker to populate client_secret (synchronous polling with timeout)
  LOOP
    -- Check if client_secret is ready
    SELECT provider_client_secret INTO v_client_secret
    FROM payments.transactions
    WHERE id = v_payment_id;

    EXIT WHEN v_client_secret IS NOT NULL;
    EXIT WHEN v_wait_count >= 60; -- 30 second timeout (60 * 500ms)

    -- Sleep 500ms and retry
    PERFORM pg_sleep(0.5);
    v_wait_count := v_wait_count + 1;
  END LOOP;

  -- Check for failure or timeout
  IF v_client_secret IS NULL THEN
    DECLARE
      v_status TEXT;
      v_error TEXT;
    BEGIN
      SELECT status, metadata->>'error' INTO v_status, v_error
      FROM payments.transactions
      WHERE id = v_payment_id;

      IF v_status = 'failed' THEN
        RAISE EXCEPTION 'Payment intent creation failed: %', COALESCE(v_error, 'Unknown error');
      ELSE
        RAISE EXCEPTION 'Timeout waiting for payment intent creation (worker may be backed up)';
      END IF;
    END;
  END IF;

  -- Return everything frontend needs in one response
  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'client_secret', v_client_secret,
    'amount', p_amount,
    'currency', v_currency,
    'capture_mode', v_capture_mode
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_payment_intent_sync TO authenticated;
```

### `capture_payment_intent()`

```sql
CREATE OR REPLACE FUNCTION capture_payment_intent(
  p_payment_id UUID
) RETURNS VOID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  -- Verify ownership or permission
  IF NOT EXISTS (
    SELECT 1
    FROM payments.transactions
    WHERE id = p_payment_id
      AND (
        user_id = current_user_id()
        OR is_admin()
        OR has_permission('payment_transactions', 'update')
      )
  ) THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  -- Verify current status
  SELECT status INTO v_current_status
  FROM payments.transactions
  WHERE id = p_payment_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF v_current_status <> 'pending_intent' THEN
    RAISE EXCEPTION 'Payment must be in pending_intent status to capture (current: %)', v_current_status;
  END IF;

  -- Update status (trigger enqueues capture job)
  UPDATE payments.transactions
  SET status = 'capturing'
  WHERE id = p_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION capture_payment_intent TO authenticated;
```

### `refund_payment()`

```sql
CREATE OR REPLACE FUNCTION refund_payment(
  p_payment_id UUID,
  p_amount NUMERIC DEFAULT NULL,  -- NULL = full refund
  p_reason TEXT DEFAULT NULL
) RETURNS UUID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  v_refund_id UUID;
  v_payment_amount NUMERIC;
  v_payment_status TEXT;
  v_entity_type TEXT;
  v_entity_id BIGINT;
BEGIN
  -- Permission check
  IF NOT (is_admin() OR has_permission('payment_transactions', 'refund')) THEN
    RAISE EXCEPTION 'Permission denied - admin or refund permission required';
  END IF;

  -- Verify payment is refundable
  SELECT amount, status, entity_type, entity_id
  INTO v_payment_amount, v_payment_status, v_entity_type, v_entity_id
  FROM payments.transactions
  WHERE id = p_payment_id;

  IF v_payment_amount IS NULL THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF v_payment_status <> 'succeeded' THEN
    RAISE EXCEPTION 'Only succeeded payments can be refunded (current status: %)', v_payment_status;
  END IF;

  -- Additional permission check: verify user can access the entity being refunded
  -- This prevents billing_staff from refunding payments for entities they don't have access to
  -- Note: This is a simplified check - production should verify entity-level permissions

  -- Default to full refund
  IF p_amount IS NULL THEN
    p_amount := v_payment_amount;
  END IF;

  -- Validate refund amount
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero';
  END IF;

  IF p_amount > v_payment_amount THEN
    RAISE EXCEPTION 'Refund amount ($%) cannot exceed payment amount ($%)', p_amount, v_payment_amount;
  END IF;

  -- Create refund record (trigger enqueues job)
  INSERT INTO payments.refunds (
    payment_id,
    amount,
    reason,
    status
  ) VALUES (
    p_payment_id,
    p_amount,
    p_reason,
    'pending'
  )
  RETURNING id INTO v_refund_id;

  RETURN v_refund_id;
END;
$$;

GRANT EXECUTE ON FUNCTION refund_payment TO authenticated;
```

### `process_payment_webhook()`

Uses atomic INSERT...ON CONFLICT pattern to prevent race conditions during webhook deduplication.

```sql
CREATE OR REPLACE FUNCTION process_payment_webhook(
  p_provider TEXT,
  p_payload JSONB
) RETURNS JSONB  -- Returns status for better observability
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id TEXT;
  v_event_type TEXT;
  v_webhook_event_id UUID;
  v_is_duplicate BOOLEAN := FALSE;
BEGIN
  -- Extract event metadata (provider-specific structure)
  IF p_provider = 'stripe' THEN
    v_event_id := p_payload->>'id';
    v_event_type := p_payload->>'type';
  ELSE
    RAISE EXCEPTION 'Unsupported provider: %', p_provider;
  END IF;

  -- ATOMIC idempotency check + insert (prevents race conditions)
  INSERT INTO payments.webhooks (
    provider,
    provider_event_id,
    event_type,
    payload,
    signature_verified
  ) VALUES (
    p_provider,
    v_event_id,
    v_event_type,
    p_payload,
    FALSE  -- Will be verified by worker
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_webhook_event_id;

  -- Check if we got an ID (new insert) or NULL (duplicate)
  IF v_webhook_event_id IS NULL THEN
    -- Duplicate webhook, retrieve existing ID
    SELECT id INTO v_webhook_event_id
    FROM payments.webhooks
    WHERE provider = p_provider
      AND provider_event_id = v_event_id;

    v_is_duplicate := TRUE;

    RAISE NOTICE 'Duplicate webhook received: % %', p_provider, v_event_id;
  END IF;

  -- Always return 200 OK to webhook sender (even for duplicates)
  -- We handle retries internally via River jobs, not via webhook retries
  RETURN jsonb_build_object(
    'webhook_event_id', v_webhook_event_id,
    'duplicate', v_is_duplicate,
    'status', 'accepted'
  );
END;
$$;

-- Public endpoint (Stripe calls this directly)
GRANT EXECUTE ON FUNCTION process_payment_webhook TO anon, authenticated;

COMMENT ON FUNCTION process_payment_webhook IS
'Accepts webhook events from payment providers. Always returns success (200 OK) to prevent provider retries. Processing happens asynchronously via River jobs. Idempotent via ON CONFLICT.';
```

---

## Webhook Architecture

### Webhook Acceptance Pattern

**Critical Design Decision:** We **always return 200 OK** to webhook senders (Stripe, PayPal, etc.). This prevents the provider from retrying, and instead we handle retries internally via River's job queue.

**Rationale:**
- Payment providers retry failed webhooks aggressively (exponential backoff, up to 3 days)
- Provider retries can overwhelm our system during outages
- We want full control over retry timing, backoff, and limits
- Returning 200 immediately allows us to process asynchronously without blocking the provider

**Trade-off:** We lose the ability to send retry hints (400 vs 500) to payment providers, but gain better control over internal retry logic.

### Single Entry Point Design

**Endpoint registered with Stripe:**
```
POST https://your-domain.com/rpc/process_payment_webhook
Content-Type: application/json
Stripe-Signature: t=...,v1=...

{
  "id": "evt_1234567890",
  "type": "payment_intent.succeeded",
  "data": { ... }
}
```

**Response (always 200):**
```json
{
  "webhook_event_id": "550e8400-e29b-41d4-a716-446655440000",
  "duplicate": false,
  "status": "accepted"
}
```

### Flow

```
1. Stripe sends webhook → PostgREST RPC endpoint
   ↓
2. process_payment_webhook() extracts event ID
   ↓
3. INSERT...ON CONFLICT DO NOTHING (atomic deduplication)
   ↓
4. ALWAYS return 200 OK (even for duplicates)
   ↓
5. Trigger enqueues ProcessWebhookJob (only for new events)
   ↓
6. Go worker polls job, acquires advisory lock
   ↓
7. Worker checks if already processed (double-check for safety)
   ↓
8. Worker dispatches to handler registry (no switch statement)
   ↓
9. Handler updates payment_transactions status
   ↓
10. Triggers fire: entity sync + email notification
   ↓
11. Mark webhook event as processed
   ↓
12. River handles retries automatically on failure
```

### Idempotency Guarantees

**Three layers of protection:**

1. **Database constraint:** `UNIQUE (provider, provider_event_id)` prevents duplicate inserts
2. **ON CONFLICT DO NOTHING:** Atomic check-and-insert prevents race conditions
3. **Advisory locks:** Worker acquires lock before processing to prevent concurrent execution
4. **Processed flag check:** Worker skips if `processed = TRUE` (defense in depth)

### Security: Custom Body Parser for Signature Verification

**Challenge:** Stripe signature verification requires the **exact raw request bytes**. If we parse JSON first, we lose the exact formatting (whitespace, key order) and signature verification fails.

**Solution:** Custom body parser in HTTP layer (before PostgREST):

```go
// Preserve raw request body for signature verification
func webhookBodyParser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rpc/process_payment_webhook" {
			// Read raw body
			bodyBytes, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

			// Store in context for later verification
			ctx := context.WithValue(r.Context(), "raw_body", bodyBytes)
			ctx = context.WithValue(ctx, "stripe_signature", r.Header.Get("Stripe-Signature"))

			next.ServeHTTP(w, r.WithContext(ctx))
		} else {
			next.ServeHTTP(w, r)
		}
	})
}
```

**Verification happens in worker:**
```go
func (w *ProcessWebhookWorker) Work(ctx context.Context, job *river.Job[ProcessWebhookArgs]) error {
	// Retrieve raw body and signature from webhook event
	var rawBody []byte
	var signature string

	err := w.db.QueryRow(ctx, `
		SELECT payload, metadata->>'stripe_signature'
		FROM payments.webhooks
		WHERE id = $1
	`, job.Args.WebhookEventID).Scan(&rawBody, &signature)

	// Verify signature
	event, err := w.provider.VerifyWebhookSignature(ctx, rawBody, signature)
	if err != nil {
		return fmt.Errorf("signature verification failed: %w", err)
	}

	// Process verified event...
}
```

**Alternative:** Store signature in webhook event payload metadata and verify in worker.

### Event Type Handlers

| Stripe Event Type | Handler Action |
|-------------------|----------------|
| `payment_intent.succeeded` | Update status to 'succeeded', set completed_at, trigger entity sync + email |
| `payment_intent.payment_failed` | Update status to 'failed', log error, trigger email notification |
| `payment_intent.canceled` | Update status to 'canceled', trigger entity sync |
| `charge.refunded` | Update refund record, update payment status to 'refunded', trigger email |
| `charge.dispute.created` | Log dispute (future: notification system) |

---

## Frontend Components

### PaymentCheckoutComponent (Updated for Sync RPC)

Embeds Stripe Elements for secure card entry. **No polling** - single RPC call returns client_secret.

```typescript
// src/app/components/payment-checkout/payment-checkout.component.ts
import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { loadStripe, Stripe, StripeElements } from '@stripe/stripe-js';
import { getPostgrestUrl } from '../../config/runtime';

@Component({
  selector: 'app-payment-checkout',
  standalone: true,
  template: `
    <div class="card bg-base-200 shadow-xl p-6">
      <h2 class="card-title mb-4">Payment</h2>

      @if (loading) {
        <div class="flex items-center gap-2">
          <span class="loading loading-spinner"></span>
          <span>Setting up payment...</span>
        </div>
      } @else if (error) {
        <div class="alert alert-error">{{ error }}</div>
      } @else {
        <div id="payment-element" class="mb-4"></div>
        <button
          class="btn btn-primary w-full"
          (click)="submit()"
          [disabled]="processing"
        >
          @if (processing) {
            <span class="loading loading-spinner"></span>
          }
          Pay {{ amount | currency }}
        </button>
        @if (captureMode === 'deferred') {
          <p class="text-sm text-gray-600 mt-2">
            Your card will be verified but not charged until approved.
          </p>
        }
      }
    </div>
  `
})
export class PaymentCheckoutComponent implements OnInit {
  @Input() entityType!: string;
  @Input() entityId!: number;
  @Input() amount!: number;
  @Input() description?: string;

  @Output() success = new EventEmitter<string>();
  @Output() failure = new EventEmitter<string>();

  loading = true;
  processing = false;
  error?: string;
  captureMode?: string;

  private stripe?: Stripe;
  private elements?: StripeElements;
  private paymentId?: string;
  private clientSecret?: string;

  constructor(private http: HttpClient) {}

  async ngOnInit() {
    try {
      // 1. Initialize Stripe (get publishable key from config)
      const stripeKey = await this.getStripePublishableKey();
      this.stripe = await loadStripe(stripeKey);

      // 2. Create payment intent via SYNCHRONOUS RPC (no polling!)
      const response = await this.http.post<{
        payment_id: string;
        client_secret: string;
        amount: number;
        currency: string;
        capture_mode: string;
      }>(
        `${getPostgrestUrl()}/rpc/create_payment_intent_sync`,
        {
          p_entity_type: this.entityType,
          p_entity_id: this.entityId,
          p_amount: this.amount,
          p_description: this.description
        }
      ).toPromise();

      this.paymentId = response.payment_id;
      this.clientSecret = response.client_secret;
      this.captureMode = response.capture_mode;

      // 3. Mount Stripe Elements (client_secret received immediately)
      this.elements = this.stripe!.elements({ clientSecret: this.clientSecret });
      const paymentElement = this.elements.create('payment');
      paymentElement.mount('#payment-element');

      this.loading = false;
    } catch (err: any) {
      this.error = err.error?.message || err.message || 'Failed to initialize payment';
      this.loading = false;
    }
  }

  async getStripePublishableKey(): Promise<string> {
    // Fetch from metadata.config via RPC or hardcode for testing
    const config = await this.http.get<any>(
      `${getPostgrestUrl()}/metadata.config?key=eq.stripe_publishable_key`
    ).toPromise();

    return config[0]?.value || 'pk_test_YOUR_KEY_HERE';
  }

  async submit() {
    if (!this.stripe || !this.elements) return;

    this.processing = true;

    // Confirm payment with Stripe (handles card validation, 3D Secure, etc.)
    const { error } = await this.stripe.confirmPayment({
      elements: this.elements,
      confirmParams: {
        return_url: window.location.href, // Redirect after 3D Secure
      },
      redirect: 'if_required'
    });

    if (error) {
      this.failure.emit(error.message || 'Payment failed');
      this.processing = false;
    } else {
      // Payment succeeded! (For immediate capture, payment is already confirmed)
      // For deferred capture, payment intent is created but not captured
      this.success.emit(this.paymentId!);
      this.processing = false;
    }
  }
}
```

### SystemListPage & SystemDetailPage

See original document sections 1145-1365 for complete implementations. Key updates:
- SystemDetailPage includes refund button with permission checks
- Filtering by status, date range
- Export to CSV functionality

### Navigation Integration

```typescript
// src/app/app.component.ts
export class AppComponent {
  navItems = [
    // ... existing items
    {
      label: 'My Payments',
      route: '/system/payment_transactions',
      icon: 'credit-card',
      requiresAuth: true,
      show: () => this.auth.isAuthenticated()
    }
  ];
}
```

---

## Security & Permissions

### RLS Policy Breakdown

```sql
-- Users see their own payments
user_id = current_user_id()

-- Admins see all payments
OR is_admin()

-- Billing staff (custom role) see all payments
OR has_permission('payment_transactions', 'read')
```

### Permission Configuration

**Grant billing team access:**

```sql
-- Create billing_staff role
INSERT INTO metadata.roles (name, description)
VALUES ('billing_staff', 'View all payments and export reports (cannot refund)');

-- Grant read permission
CALL set_role_permission('billing_staff', 'payment_transactions', 'read', true);

-- Assign to user
INSERT INTO metadata.user_roles (user_id, role_id)
SELECT 'user-uuid-here', id FROM metadata.roles WHERE name = 'billing_staff';
```

**Grant refund permission to admins only:**

```sql
-- Refund permission defaults to admin-only
-- billing_staff intentionally does NOT get refund permission
```

### Input Validation

All RPCs include validation:
- Amount > 0
- Entity type exists in information_schema
- User owns payment or has appropriate permission
- Payment in valid status for requested operation

### Webhook Security

- **Idempotency**: UNIQUE constraint on `(provider, provider_event_id)`
- **Signature Verification**: ProcessWebhookWorker verifies Stripe signature using webhook secret
- **Audit Trail**: All webhooks logged in `payment_webhook_events` table
- **Rate Limiting**: Consider adding nginx rate limiting for `/rpc/process_payment_webhook` endpoint

---

## Configuration

### Environment Variables

**PostgREST:**
```bash
PGRST_DB_SCHEMAS="public,metadata,payments"  # Expose metadata and payments schemas
```

**Go Payment Service:**
```bash
# Database
DATABASE_URL="postgres://..."

# Stripe
STRIPE_API_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# Email (SMTP)
SMTP_HOST="smtp.sendgrid.net"
SMTP_PORT="587"
SMTP_USERNAME="apikey"
SMTP_PASSWORD="SG.xxx"
SMTP_FROM_EMAIL="noreply@civic-os.org"
SMTP_FROM_NAME="Civic OS Payments"
SMTP_USE_TLS="true"

# General
PAYMENT_CURRENCY="USD"
RIVER_WORKER_COUNT=5
```

**Docker Compose Example:**

```yaml
# docker-compose.yml
services:
  payment-worker:
    build: ./services/payment-worker
    environment:
      DATABASE_URL: postgres://authenticator:password@postgres:5432/civic_os
      STRIPE_API_KEY: ${STRIPE_API_KEY}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USERNAME: ${SMTP_USERNAME}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
      SMTP_FROM_EMAIL: noreply@civic-os.org
      SMTP_FROM_NAME: Civic OS Payments
      SMTP_USE_TLS: "true"
      PAYMENT_CURRENCY: USD
      RIVER_WORKER_COUNT: 5
    depends_on:
      - postgres
    restart: unless-stopped
```

### Database Configuration

```sql
-- Instance-wide config table
INSERT INTO metadata.config (key, value, description)
VALUES
  ('payment_currency', 'USD', 'Default currency for all payments'),
  ('payment_provider', 'stripe', 'Active payment provider'),
  ('stripe_publishable_key', 'pk_test_...', 'Stripe public key for frontend');
```

---

## Stripe Account Setup Guide

This section provides step-by-step instructions for setting up Stripe accounts for new Civic OS tenants.

### 1. Create Stripe Account

1. Go to https://dashboard.stripe.com/register
2. Sign up with tenant's email address (e.g., `billing@cityname.gov`)
3. Complete business verification:
   - Business type: Government entity / Non-profit
   - Tax ID (EIN for US entities)
   - Bank account for payouts
   - Address and contact information

### 2. Get API Keys

**Test Mode** (for development/staging):
1. Navigate to **Developers** → **API keys**
2. Copy **Publishable key** (starts with `pk_test_`)
3. Click **Reveal test key** to copy **Secret key** (starts with `sk_test_`)

**Production Mode** (after testing complete):
1. Toggle to **Live mode** in dashboard
2. Navigate to **Developers** → **API keys**
3. Copy **Publishable key** (starts with `pk_live_`)
4. Click **Reveal live key** to copy **Secret key** (starts with `sk_live_`)

### 3. Configure Webhooks

1. Navigate to **Developers** → **Webhooks**
2. Click **Add endpoint**
3. Set **Endpoint URL**: `https://your-tenant-domain.com/rpc/process_payment_webhook`
4. Click **Select events** and choose:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`
   - `charge.dispute.created`
5. Click **Add endpoint**
6. Click on the created webhook, then **Reveal** to copy **Signing secret** (starts with `whsec_`)

### 4. Configure Environment Variables

Add to your `.env` file or deployment configuration:

```bash
# Stripe Configuration
STRIPE_API_KEY="sk_test_..."          # or sk_live_ for production
STRIPE_WEBHOOK_SECRET="whsec_..."

# Database Configuration
INSERT INTO metadata.config (key, value) VALUES
  ('stripe_publishable_key', 'pk_test_...'),  # or pk_live_ for production
  ('payment_currency', 'USD'),
  ('payment_provider', 'stripe');
```

### 5. Test Webhook Delivery

**Using Stripe CLI** (recommended for local development):
```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login to your Stripe account
stripe login

# Forward webhooks to local PostgREST
stripe listen --forward-to http://localhost:3000/rpc/process_payment_webhook

# Trigger test webhook
stripe trigger payment_intent.succeeded
```

**Using Stripe Dashboard:**
1. Navigate to **Developers** → **Webhooks**
2. Click on your webhook endpoint
3. Click **Send test webhook**
4. Select `payment_intent.succeeded`
5. Click **Send test webhook**
6. Verify event appears in `payments.webhooks` table

### 6. Test Cards

Use these test cards in **test mode** only:

| Card Number | Behavior |
|-------------|----------|
| 4242 4242 4242 4242 | Successful payment |
| 4000 0000 0000 0002 | Card declined |
| 4000 0025 0000 3155 | Requires 3D Secure authentication |
| 4000 0000 0000 9995 | Insufficient funds |

**Expiration:** Any future date (e.g., 12/34)
**CVC:** Any 3 digits (e.g., 123)
**ZIP:** Any 5 digits (e.g., 12345)

### 7. Enable Live Mode

**After testing is complete:**

1. Complete Stripe account verification (may take 1-3 business days)
2. Replace test API keys with live keys in environment variables
3. Update `metadata.config` with `pk_live_` publishable key
4. Configure live webhook endpoint in Stripe dashboard
5. Test with real card (use small amount like $0.50, then refund)
6. Monitor payments in Stripe dashboard

### 8. Production Checklist

- [ ] Stripe account verified with business documents
- [ ] Bank account connected for payouts
- [ ] Live API keys configured in production environment
- [ ] Webhook endpoint configured and tested in live mode
- [ ] SSL certificate valid on webhook endpoint domain
- [ ] Test payment completed and refunded successfully
- [ ] Email notifications working (test with real email address)
- [ ] RLS policies tested (user, admin, billing_staff roles)
- [ ] Backup/disaster recovery plan documented

### 9. Ongoing Maintenance

**Monthly:**
- Reconcile Stripe payouts with database records
- Review failed payments and disputes

**Quarterly:**
- Review transaction fees and pricing
- Export payment data for accounting (CSV or API)

**Annually:**
- Rotate API keys and webhook secrets
- Review and update email templates
- Audit RLS policies and permissions

---

## Testing the Payment System

### Prerequisites

1. Stripe account with test mode API keys
2. Stripe CLI installed for webhook forwarding
3. Example running (e.g., `examples/community-center/` or `examples/mottpark/`)

### Quick Start Test Flow

```bash
# 1. Start services
cd examples/community-center
docker-compose up -d

# 2. Start Stripe webhook listener (in separate terminal)
stripe listen --forward-to http://localhost:8081/webhooks/stripe

# 3. Test payment flow in browser:
#    - Create reservation request
#    - Click "Pay Now" on detail page
#    - Use test card: 4242 4242 4242 4242 (any future date, any CVC)
#    - Verify status updates to "succeeded"
```

### Test Cards

| Card Number | Result |
|-------------|--------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0341` | Declined (card_declined) |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 0002` | Declined (generic) |

Full list: [Stripe Testing Documentation](https://stripe.com/docs/testing#cards)

### Testing Payment Retry

```bash
# 1. Use declined card: 4000 0000 0000 0341
# 2. Verify status = "failed"
# 3. Click "Pay Now" again
# 4. Verify NEW transaction created (check database)
# 5. Complete with success card
# 6. Check database - should show 2 records (failed + succeeded)
```

### Database Verification

```sql
-- Check transactions
SELECT id, provider_payment_id, status, amount, created_at
FROM payments.transactions
ORDER BY created_at DESC;

-- Check entity link (example: community-center)
SELECT id, display_name, payment_transaction_id
FROM reservation_requests
WHERE payment_transaction_id IS NOT NULL;

-- Check webhooks processed
SELECT provider_event_id, event_type, processed, created_at
FROM metadata.webhooks
ORDER BY created_at DESC;

-- Check refunds
SELECT r.*, t.amount as original_amount
FROM payments.refunds r
JOIN payments.transactions t ON r.transaction_id = t.id;
```

### Testing Refunds (Admin)

1. Navigate to `/admin/payments`
2. Find a succeeded payment
3. Click "Refund" button
4. Enter amount (partial or full)
5. Verify:
   - Refund appears in `payments.refunds` table
   - `effective_status` updates to `partially_refunded` or `refunded`
   - Stripe dashboard shows refund

---

## Design Patterns from Production Systems

This section documents patterns adopted from analysis of production payment synchronization systems (Supabase Stripe Sync Engine, November 2025).

### Timestamp-Based Idempotency

**Pattern:** Use `last_synced_at` column with WHERE clause to prevent stale data from overwriting newer data.

```sql
-- Payment transactions table includes sync timestamp
ALTER TABLE payments.transactions
  ADD COLUMN last_synced_at TIMESTAMPTZ;

-- Upsert pattern with timestamp protection
INSERT INTO payments.transactions (
  id, provider_payment_id, status, amount, last_synced_at
)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (id) DO UPDATE SET
  provider_payment_id = EXCLUDED.provider_payment_id,
  status = EXCLUDED.status,
  amount = EXCLUDED.amount,
  last_synced_at = EXCLUDED.last_synced_at
WHERE payment_transactions.last_synced_at IS NULL
   OR payment_transactions.last_synced_at < EXCLUDED.last_synced_at;
```

**How It Works:**
- First insert: `last_synced_at` is NULL → UPDATE succeeds
- Newer data: incoming timestamp > existing → UPDATE succeeds
- **Stale data:** incoming timestamp < existing → UPDATE returns 0 rows (no-op)

**Benefits:**
- No advisory locks required (WHERE clause prevents stale writes)
- Works across River job retries
- Handles out-of-order webhook delivery
- Simple to implement and understand

### Atomic Webhook Deduplication

**Pattern:** Use `INSERT...ON CONFLICT DO NOTHING` for race-condition-free deduplication.

```sql
-- Attempt insert, ignore duplicates
INSERT INTO payments.webhooks (provider, provider_event_id, event_type, payload)
VALUES ($1, $2, $3, $4)
ON CONFLICT (provider, provider_event_id) DO NOTHING
RETURNING id;

-- If RETURNING id is NULL, event already exists
```

**Comparison to SELECT-then-INSERT:**

```sql
-- ❌ Race condition: Two requests can both pass SELECT check
SELECT id FROM payment_webhook_events WHERE provider_event_id = $1;
IF NOT FOUND THEN
  INSERT INTO payment_webhook_events ...;
END IF;

-- ✅ Atomic: Database guarantees no duplicates
INSERT ... ON CONFLICT DO NOTHING RETURNING id;
```

### Handler Registry Pattern

**Pattern:** Map event types to handlers using a registry instead of monolithic switch statements.

**Benefits:**
- **Testability:** Each handler independently testable
- **Extensibility:** Add handlers without modifying router code
- **Graceful degradation:** Unknown events logged, not crashed
- **Type safety:** Interface contract enforced

**Implementation:** See "Webhook Handler Registry Pattern" section above (lines 879-1004).

### Custom Body Parser for Signature Verification

**Pattern:** Preserve raw HTTP request body for HMAC signature verification.

**Challenge:** Stripe (and most payment providers) sign the exact raw bytes of the request body. If you parse JSON first, whitespace and key ordering changes, breaking signature verification.

**Solution:** Custom HTTP middleware that:
1. Reads raw body bytes
2. Stores in context
3. Resets body for downstream handlers
4. Worker retrieves raw bytes for verification

**See:** "Security: Custom Body Parser for Signature Verification" section above (lines 1848-1898).

### Advisory Locks for Critical Sections

**Pattern:** Use PostgreSQL advisory locks to prevent concurrent processing of same webhook.

```go
// Acquire lock at start of transaction
lockID := hashWebhookEventID(job.Args.WebhookEventID)
_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)

// Lock automatically released at transaction end
```

**When to Use:**
- High-contention resources (same webhook processed by multiple workers)
- Critical sections requiring atomic operations
- Preventing duplicate side effects (sending emails, calling external APIs)

**When NOT to Use:**
- Low-contention operations (timestamp-based idempotency is simpler)
- Read-only operations
- Operations where duplicates are harmless

### Unknown Event Handling

**Pattern:** Log and store unknown webhook events instead of crashing.

```go
func (r *HandlerRegistry) Dispatch(ctx context.Context, eventType string, payload map[string]interface{}) error {
    handler, ok := r.handlers[eventType]
    if !ok {
        // Store for manual investigation instead of failing
        return r.storeUnknownEvent(ctx, eventType, payload)
    }
    return handler.HandleEvent(ctx, payload)
}
```

**Benefits:**
- Service continues running when provider adds new event types
- Unknown events logged for future implementation
- No emergency deployments when providers evolve their APIs

**Database Table:**
```sql
CREATE TABLE payments.unknown_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Fixture-Based Integration Testing

**Pattern:** Use real webhook payloads as test fixtures.

**Benefits:**
- High fidelity (tests use actual provider data structures)
- Easy to add new event types (just capture webhook JSON)
- Documents expected payload structure
- Catches API changes during integration tests

**Implementation:** See "Testing Strategy" section below.

---

## Implementation Roadmap

### Phase 0: Proof-of-Concept - Week 1-2

**Goal:** Validate technical assumptions before full implementation.

**Database:**
- [ ] Create minimal `payment_transactions` table (no triggers yet)
- [ ] Test `create_payment_intent_sync()` RPC with pg_sleep polling
- [ ] Measure sync RPC latency under simulated load (10 concurrent calls)

**Go Service:**
- [ ] Set up Go module skeleton
- [ ] Implement basic CreateIntentWorker (Stripe API integration only)
- [ ] Test River job processing with sample data

**Frontend:**
- [ ] Prototype PaymentCheckoutComponent with Stripe Elements
- [ ] Test Stripe Elements embedding in Angular standalone component
- [ ] Validate immediate vs. deferred capture modes in Stripe dashboard

**Key Questions to Answer:**
- [ ] Does sync RPC perform acceptably? (Target: <3 seconds 95th percentile)
- [ ] Can Stripe Elements integrate cleanly with Angular 20?
- [ ] Does River handle job volumes reliably? (Test 100 concurrent jobs)

**Decision Point:** If sync RPC is too slow or unstable, pivot to WebSocket approach.

---

### Phase 1: Foundation - Week 3-4

**Database:**
- [ ] Create migration for all tables (`payment_transactions`, `payment_refunds`, `payment_webhook_events`)
- [ ] Implement trigger functions:
  - `update_entity_payment_status()` (entity sync)
  - `enqueue_payment_event()` (email queue)
  - Job enqueue triggers
- [ ] Create views with RLS policies
- [ ] Add `payment_capture_mode` to `metadata.entities`
- [ ] Create RPCs: `create_payment_intent_sync()`, `process_payment_webhook()`

**Go Service:**
- [ ] Complete `PaymentProvider` interface
- [ ] Implement StripeProvider with capture mode support
- [ ] Implement CreateIntentWorker with error handling
- [ ] Implement ProcessWebhookWorker with signature verification

**Frontend:**
- [ ] Create SystemListPage component (basic)
- [ ] Create SystemDetailPage component (view only, no refund yet)
- [ ] Add `/system/:tableName` routes
- [ ] Add "My Payments" navbar link

**Testing:**
- [ ] Unit tests for Stripe provider (mocked API)
- [ ] Integration test: Create payment intent end-to-end
- [ ] Manual test: View payment history as user

---

### Phase 2: Checkout UI & Entity Integration - Week 5-6

**Database:**
- [ ] Add example entity tables with payment columns:
  - `event_registrations` (immediate capture)
  - `facility_bookings` (deferred capture)
- [ ] Test trigger-based entity sync with real data
- [ ] Create example capture timing trigger (facility approval)

**Frontend:**
- [ ] Complete PaymentCheckoutComponent with error handling
- [ ] Add capture mode indicator (immediate vs. deferred)
- [ ] Add payment status badges (color-coded: pending, succeeded, failed, refunded)
- [ ] Add error messages with retry logic

**Go Service:**
- [ ] Implement CaptureWorker
- [ ] Add retry logic with exponential backoff (River built-in)
- [ ] Add structured logging (JSON format for aggregation)

**Documentation:**
- [ ] Write entity integration guide (schema conventions, trigger examples)
- [ ] Document capture mode configuration

**Testing:**
- [ ] E2E test: Full immediate capture flow
- [ ] E2E test: Deferred capture with trigger-based capture
- [ ] Test 3D Secure handling
- [ ] Test payment failure scenarios (declined card, network timeout)

---

### Phase 3: Email & Webhooks - Week 7-8

**Database:**
- [ ] No schema changes needed (event triggers already exist)

**Go Service:**
- [ ] Implement SMTP client wrapper
- [ ] Create email templates (success, failed, refund)
- [ ] Implement SendEmailWorker
- [ ] Implement PaymentEventWorker (routes to email worker)
- [ ] Add retry logic for email failures (transient SMTP errors)

**Configuration:**
- [ ] Document SMTP setup for SendGrid, Mailgun, AWS SES
- [ ] Test email delivery in sandbox mode
- [ ] Configure SPF/DKIM records for production email

**Testing:**
- [ ] Test webhook event processing (success, failed, refund)
- [ ] Test duplicate webhook handling (idempotency)
- [ ] Test signature verification (valid and invalid signatures)
- [ ] Test email delivery (success confirmations, failure notifications)
- [ ] Stripe CLI webhook testing (`stripe trigger payment_intent.succeeded`)

---

### Phase 4: Admin & Refunds - Week 9-10

**Database:**
- [ ] Complete `refund_payment()` RPC with validation
- [ ] Create `billing_staff` role with read-only permissions

**Go Service:**
- [ ] Implement RefundWorker
- [ ] Add refund confirmation emails

**Frontend:**
- [ ] Add Refund button to SystemDetailPage (admin/refund permission only)
- [ ] Add refund modal with amount input (full vs. partial)
- [ ] Add permission checks in UI (hide refund button if no permission)
- [ ] Add filter/search to SystemListPage:
  - Filter by status (succeeded, failed, refunded)
  - Filter by date range
  - Search by payment ID, entity type
- [ ] Add CSV export functionality (PostgREST query with CSV headers)
- [ ] Add refund history section (show all refunds for a payment)

**Testing:**
- [ ] Test full refund flow (Stripe dashboard verification)
- [ ] Test partial refund
- [ ] Test permission enforcement (user, admin, billing_staff roles)
- [ ] Test refund email notifications

---

### Phase 5: Polish, Documentation & Production Readiness - Week 11-12

**Documentation:**
- [ ] Complete integrator guide (`PAYMENT_INTEGRATION_GUIDE.md`):
  - Making an entity payable (schema, triggers, UI)
  - Configuring capture timing (examples for 5 workflows)
  - Email template customization
  - Testing with Stripe test cards
  - Production deployment checklist
- [ ] Stripe account setup guide (this document, section above)
- [ ] Troubleshooting guide:
  - "Payment stuck in pending_intent" → Check worker logs
  - "Webhook not received" → Check Stripe dashboard
  - "Permission denied" → Check RLS policies
- [ ] Example use cases:
  - Event registration (immediate)
  - Facility booking (deferred, capture on approval)
  - Equipment rental (deferred, capture on check-in)
  - Permit application (either mode)

**Frontend:**
- [ ] Add loading states and animations (skeleton screens)
- [ ] Add toast notifications for payment success/failure (DaisyUI toast)
- [ ] Add payment analytics dashboard (admin only):
  - Total revenue (current month, all time)
  - Success rate (succeeded / total)
  - Top revenue entities (chart)
  - Failed payments list
- [ ] Add pagination to SystemListPage (50 records per page)
- [ ] Add real-time status updates (optional: WebSocket for live payment status)

**Testing:**
- [ ] Load testing: Simulate 10 concurrent payments (target: <5 second 95th percentile)
- [ ] Security audit:
  - RLS policies (verify user isolation)
  - Webhook signature verification
  - Input validation in all RPCs
  - SQL injection tests (dynamic table names in triggers)
- [ ] User acceptance testing with real users
- [ ] Cross-browser testing (Chrome, Firefox, Safari, Edge)
- [ ] Mobile testing (responsive design, mobile keyboard for card input)

**Production Deployment:**
- [ ] Deploy to staging environment
- [ ] Complete Stripe account verification
- [ ] Configure live webhook endpoint
- [ ] Test with real card (small amount, then refund)
- [ ] Set up monitoring and alerting:
  - Payment worker health checks
  - Failed payment notifications
  - Webhook delivery failures
- [ ] Document rollback procedure
- [ ] Train support staff on payment troubleshooting

---

## Testing Strategy

### Fixture-Based Integration Testing

**Pattern:** Use real webhook payloads captured from Stripe as test fixtures.

**Directory Structure:**
```
services/payments/
├── test/
│   ├── fixtures/
│   │   ├── stripe/
│   │   │   ├── payment_intent_succeeded.json
│   │   │   ├── payment_intent_failed.json
│   │   │   ├── charge_refunded.json
│   │   │   └── customer_updated.json
│   │   └── paypal/  # Future
│   │       └── payment_capture_completed.json
│   ├── helpers/
│   │   ├── fixtures.go       # Fixture loading utilities
│   │   ├── signature.go      # HMAC signature generation
│   │   └── database.go       # Test DB setup/teardown
│   └── integration/
│       ├── webhook_test.go
│       └── idempotency_test.go
```

**Generating Fixtures with Stripe CLI:**
```bash
# Trigger test webhooks and save payloads
stripe trigger payment_intent.succeeded --print-json > test/fixtures/stripe/payment_intent_succeeded.json
stripe trigger payment_intent.payment_failed --print-json > test/fixtures/stripe/payment_intent_failed.json
stripe trigger charge.refunded --print-json > test/fixtures/stripe/charge_refunded.json

# Or record live webhooks
stripe listen --forward-to http://localhost:8080/webhooks --print-json > test/fixtures/
```

**Fixture Loader Helper:**
```go
// test/helpers/fixtures.go
package helpers

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func LoadWebhookFixture(provider, eventName string) (map[string]interface{}, error) {
	path := filepath.Join("test", "fixtures", provider, eventName+".json")

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var webhook map[string]interface{}
	if err := json.Unmarshal(data, &webhook); err != nil {
		return nil, err
	}

	return webhook, nil
}

// Customize fixture with test-specific data
func CustomizeFixture(fixture map[string]interface{}, overrides map[string]interface{}) map[string]interface{} {
	for key, value := range overrides {
		setNestedValue(fixture, key, value)
	}
	return fixture
}
```

**Signature Generation Helper:**
```go
// test/helpers/signature.go
package helpers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

func GenerateStripeSignature(payload []byte, secret string) string {
	timestamp := time.Now().Unix()
	signedPayload := fmt.Sprintf("%d.%s", timestamp, payload)

	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(signedPayload))
	signature := hex.EncodeToString(h.Sum(nil))

	return fmt.Sprintf("t=%d,v1=%s", timestamp, signature)
}
```

### Unit Tests

**Handler Tests:**
```go
// internal/webhooks/handlers/payment_succeeded_test.go
func TestPaymentIntentSucceededHandler(t *testing.T) {
	// Arrange
	mockDB := &MockDB{}
	handler := &PaymentIntentSucceededHandler{}

	payload := map[string]interface{}{
		"data": map[string]interface{}{
			"object": map[string]interface{}{
				"id": "pi_test_123",
			},
		},
	}

	// Act
	err := handler.HandleEvent(context.Background(), mockDB, payload)

	// Assert
	assert.NoError(t, err)
	mockDB.AssertCalled(t, "Exec", mock.Anything, mock.MatchedBy(func(query string) bool {
		return strings.Contains(query, "UPDATE payments.transactions")
	}))
}
```

**Provider Tests:**
```go
// internal/providers/stripe_test.go
func TestStripeProvider_CreateIntent_ImmediateCapture(t *testing.T) {
	provider := NewStripeProvider("sk_test_...", "whsec_...")

	intent, err := provider.CreateIntent(context.Background(), CreateIntentParams{
		Amount:      5000,
		Currency:    "usd",
		CaptureMode: "immediate",
	})

	assert.NoError(t, err)
	assert.NotEmpty(t, intent.ClientSecret)
	assert.Equal(t, "automatic", intent.CaptureMethod)
}

func TestStripeProvider_VerifyWebhookSignature(t *testing.T) {
	payload := []byte(`{"id":"evt_test","type":"payment_intent.succeeded"}`)
	signature := helpers.GenerateStripeSignature(payload, "whsec_test_secret")

	event, err := provider.VerifyWebhookSignature(context.Background(), payload, signature)

	assert.NoError(t, err)
	assert.NotNil(t, event)
}
```

### Integration Tests

**Webhook Processing End-to-End:**
```go
// test/integration/webhook_test.go
func TestWebhookProcessing_PaymentSucceeded(t *testing.T) {
	// Setup test database
	ctx := context.Background()
	db := setupTestDB(t)
	defer db.Close()

	// Create test payment record
	paymentID := createTestPayment(t, db, map[string]interface{}{
		"provider_payment_id": "pi_test_123",
		"status":              "pending_intent",
		"amount":              50.00,
	})

	// Load fixture
	webhook, err := helpers.LoadWebhookFixture("stripe", "payment_intent_succeeded")
	require.NoError(t, err)

	// Customize with test payment ID
	webhook = helpers.CustomizeFixture(webhook, map[string]interface{}{
		"data.object.id": "pi_test_123",
	})

	// Generate signature
	payloadBytes, _ := json.Marshal(webhook)
	signature := helpers.GenerateStripeSignature(payloadBytes, os.Getenv("STRIPE_WEBHOOK_SECRET"))

	// Send webhook via HTTP
	req := httptest.NewRequest("POST", "/rpc/process_payment_webhook", bytes.NewReader(payloadBytes))
	req.Header.Set("Stripe-Signature", signature)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	// Assert response
	assert.Equal(t, 200, rr.Code)

	// Wait for async processing (River job)
	time.Sleep(1 * time.Second)

	// Assert database state
	var status string
	err = db.QueryRow(ctx, "SELECT status FROM payments.transactions WHERE id = $1", paymentID).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "succeeded", status)

	// Assert webhook marked as processed
	var processed bool
	err = db.QueryRow(ctx, "SELECT processed FROM payments.webhooks ORDER BY received_at DESC LIMIT 1").Scan(&processed)
	require.NoError(t, err)
	assert.True(t, processed)
}
```

**Idempotency Tests:**
```go
// test/integration/idempotency_test.go
func TestWebhookIdempotency_DuplicateEvents(t *testing.T) {
	webhook, _ := helpers.LoadWebhookFixture("stripe", "payment_intent_succeeded")
	payloadBytes, _ := json.Marshal(webhook)
	signature := helpers.GenerateStripeSignature(payloadBytes, os.Getenv("STRIPE_WEBHOOK_SECRET"))

	// Send same webhook twice
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("POST", "/rpc/process_payment_webhook", bytes.NewReader(payloadBytes))
		req.Header.Set("Stripe-Signature", signature)

		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		assert.Equal(t, 200, rr.Code)
	}

	// Assert only one webhook event stored
	var count int
	db.QueryRow(context.Background(), "SELECT COUNT(*) FROM payments.webhooks").Scan(&count)
	assert.Equal(t, 1, count)
}

func TestTimestampIdempotency_OlderDataRejected(t *testing.T) {
	ctx := context.Background()
	db := setupTestDB(t)

	// Insert newer data
	newerTime := time.Now()
	db.Exec(ctx, `
		INSERT INTO payments.transactions (id, provider_payment_id, amount, last_synced_at)
		VALUES ($1, $2, $3, $4)
	`, "test-payment-1", "pi_test_123", 5000, newerTime)

	// Attempt to upsert older data
	olderTime := newerTime.Add(-1 * time.Hour)
	result, _ := db.Exec(ctx, `
		INSERT INTO payments.transactions (id, provider_payment_id, amount, last_synced_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET
			amount = EXCLUDED.amount,
			last_synced_at = EXCLUDED.last_synced_at
		WHERE payment_transactions.last_synced_at < EXCLUDED.last_synced_at
	`, "test-payment-1", "pi_test_123", 3000, olderTime)

	// Assert no rows affected (WHERE clause prevented update)
	rowsAffected := result.RowsAffected()
	assert.Equal(t, int64(0), rowsAffected)

	// Assert original data preserved
	var amount int64
	db.QueryRow(ctx, "SELECT amount FROM payments.transactions WHERE id = $1", "test-payment-1").Scan(&amount)
	assert.Equal(t, int64(5000), amount)
}
```

**Concurrent Processing Tests:**
```go
func TestConcurrentWebhookProcessing(t *testing.T) {
	webhook, _ := helpers.LoadWebhookFixture("stripe", "payment_intent_succeeded")

	var wg sync.WaitGroup
	errors := make(chan error, 10)

	// Process same webhook from 10 goroutines
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := processWebhook(webhook); err != nil {
				errors <- err
			}
		}()
	}

	wg.Wait()
	close(errors)

	// All goroutines should complete without error
	for err := range errors {
		t.Errorf("Concurrent processing error: %v", err)
	}

	// Only one payment record should exist
	var count int
	db.QueryRow(context.Background(), "SELECT COUNT(*) FROM payments.transactions WHERE provider_payment_id = $1", "pi_test_123").Scan(&count)
	assert.Equal(t, 1, count)
}
```

### Benchmark Tests

```go
func BenchmarkWebhookProcessing(b *testing.B) {
	webhook, _ := helpers.LoadWebhookFixture("stripe", "payment_intent_succeeded")
	payloadBytes, _ := json.Marshal(webhook)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		processWebhook(payloadBytes)
	}
}

func BenchmarkTimestampIdempotency(b *testing.B) {
	ctx := context.Background()
	db := setupTestDB(b)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		db.Exec(ctx, `
			INSERT INTO payments.transactions (...)
			VALUES (...)
			ON CONFLICT (id) DO UPDATE SET ...
			WHERE payment_transactions.last_synced_at < EXCLUDED.last_synced_at
		`, ...)
	}
}
```

### Frontend E2E Tests

**Playwright/Cypress:**
```typescript
test('Payment checkout flow - immediate capture', async ({ page }) => {
  // 1. Navigate to entity with payment button
  // 2. Click "Pay Now"
  // 3. Wait for Stripe Elements to load
  // 4. Enter test card (4242 4242 4242 4242)
  // 5. Submit payment
  // 6. Verify success message
  // 7. Check payment_transactions record in database
  // 8. Verify entity payment_status updated
});

test('Payment checkout flow - 3D Secure', async ({ page }) => {
  // Use card 4000 0025 0000 3155
  // Handle 3D Secure authentication flow
});
```

### Manual Testing Checklist

**Stripe Test Cards:**
- [ ] Successful payment (4242 4242 4242 4242)
- [ ] Declined card (4000 0000 0000 0002)
- [ ] 3D Secure card (4000 0025 0000 3155)
- [ ] Insufficient funds (4000 0000 0000 9995)

**Webhook Testing:**
- [ ] Trigger `payment_intent.succeeded` via Stripe CLI
- [ ] Trigger `payment_intent.payment_failed`
- [ ] Send duplicate webhook (verify idempotency)
- [ ] Send webhook with invalid signature (verify rejection)

**Permission Testing:**
- [ ] User sees only own payments
- [ ] Admin sees all payments
- [ ] Billing staff sees all payments but cannot refund
- [ ] Admin can issue refunds

**Email Testing:**
- [ ] Receive payment success email
- [ ] Receive payment failed email
- [ ] Receive refund confirmation email
- [ ] Verify email content (amount, payment ID, entity info)

**Load Testing:**
- [ ] 10 concurrent payment creations (measure latency)
- [ ] 100 webhook events in rapid succession (verify worker keeps up)

---

## Integration Examples

### Example 1: Event Registration (Immediate Capture)

**1. Add payment columns to entity:**

```sql
-- Add payment columns to event_registrations table
ALTER TABLE event_registrations
  ADD COLUMN payment_status TEXT DEFAULT 'pending',
  ADD COLUMN payment_id UUID REFERENCES payments.transactions(id);

ALTER TABLE event_registrations
  ADD CONSTRAINT valid_payment_status
    CHECK (payment_status IN ('pending', 'paid', 'payment_failed', 'refunded', 'canceled'));

CREATE INDEX idx_event_registrations_payment_id ON event_registrations(payment_id);

-- Configure immediate capture
UPDATE metadata.entities
SET payment_capture_mode = 'immediate'
WHERE table_name = 'event_registrations';
```

**2. Add Pay Now button to detail page:**

```typescript
// event-registration-detail.component.ts
export class EventRegistrationDetailComponent {
  showPaymentModal = signal(false);

  registration$ = this.route.params.pipe(
    switchMap(p => this.data.getEntity('event_registrations', p['id']))
  );

  payNow(registration: any) {
    this.showPaymentModal.set(true);
  }

  handlePaymentSuccess(paymentId: string) {
    // Payment succeeded - entity sync happens automatically via trigger!
    // Just refresh UI to show updated status
    alert('Payment successful! You are now registered.');
    this.showPaymentModal.set(false);
    window.location.reload(); // Or use router.navigate to refresh
  }
}
```

**3. Template:**

```html
<div class="card">
  @if (registration$ | async; as reg) {
    <h2>{{ reg.event_name }}</h2>
    <p>Amount Due: {{ reg.amount | currency }}</p>

    @if (reg.payment_status !== 'paid') {
      <button class="btn btn-primary" (click)="payNow(reg)">
        Pay Now
      </button>
    } @else {
      <div class="badge badge-success">Paid</div>
    }
  }
</div>

@if (showPaymentModal()) {
  <dialog open class="modal">
    <div class="modal-box max-w-2xl">
      <h3 class="font-bold text-lg mb-4">Complete Payment</h3>
      <app-payment-checkout
        entityType="event_registrations"
        [entityId]="registrationId"
        [amount]="registration.amount"
        description="Event Registration"
        (success)="handlePaymentSuccess($event)"
        (failure)="alert($event)"
      />
    </div>
  </dialog>
}
```

**Result:** User clicks Pay Now → Enters card → Payment confirms → `payment_status` automatically updates to `'paid'` → Email sent → Done!

---

### Example 2: Facility Booking (Deferred Capture on Approval)

**1. Add payment columns + capture trigger:**

```sql
-- Add payment columns
ALTER TABLE facility_bookings
  ADD COLUMN payment_status TEXT DEFAULT 'pending',
  ADD COLUMN payment_id UUID REFERENCES payments.transactions(id);

ALTER TABLE facility_bookings
  ADD CONSTRAINT valid_payment_status
    CHECK (payment_status IN ('pending', 'paid', 'payment_failed', 'refunded', 'canceled'));

CREATE INDEX idx_facility_bookings_payment_id ON facility_bookings(payment_id);

-- Configure deferred capture
UPDATE metadata.entities
SET payment_capture_mode = 'deferred'
WHERE table_name = 'facility_bookings';

-- Auto-capture when admin approves booking
CREATE OR REPLACE FUNCTION enqueue_payment_capture_on_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND OLD.status <> 'approved'
     AND NEW.payment_id IS NOT NULL THEN

    INSERT INTO river_job (kind, args, priority, scheduled_at, state)
    VALUES (
      'payment_capture',
      jsonb_build_object('payment_id', NEW.payment_id),
      1,
      NOW(),
      'available'
    );

    RAISE NOTICE 'Auto-capture enqueued for payment %', NEW.payment_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_capture_on_approval
  AFTER UPDATE OF status ON facility_bookings
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_payment_capture_on_approval();
```

**2. Frontend (same as event registration):**

User clicks Pay Now → Enters card → Card verified but NOT charged → Admin approves booking → Trigger fires → Payment captured → Email sent.

---

### Example 3: Permit Application (Either Mode)

```sql
-- Configure based on workflow preference
UPDATE metadata.entities
SET payment_capture_mode = 'immediate'  -- or 'deferred'
WHERE table_name = 'permit_applications';

-- If deferred, add trigger for capture on approval (similar to facility bookings)
```

---

## Future Enhancements

### Phase 6: PayPal Integration

- Implement `PayPalProvider` class
- Add provider selection logic (instance-wide configuration)
- Update webhook handler for PayPal events
- Add PayPal Smart Buttons to checkout component

### Phase 7: Recurring Payments / Subscriptions

- Add `payment_subscriptions` table
- Implement `SubscriptionWorker` (handles recurring billing)
- Add subscription management UI
- Support pro-rated billing and cancellations

### Phase 8: Multi-Currency Support

- Add currency selection to checkout
- Store exchange rates in database
- Display converted amounts in user's preferred currency
- Support Stripe multi-currency capabilities

### Phase 9: Payment Analytics Dashboard

- Total revenue widget (current month, all time)
- Success/failure rate chart
- Top revenue entities
- Refund tracking and trends
- Export to QuickBooks/Xero

### Phase 10: Advanced Features

- Split payments (multiple entities share one payment)
- Payment plans (multi-installment payments)
- Gift payments (user pays for someone else)
- Bulk operations (admin refunds all registrations after event cancellation)
- Payment links (shareable URLs without pre-creating entity)
- Variable pricing (resident vs. non-resident rates)

### Conditional Payment Button Visibility

- Add `payment_show_condition` JSONB column to `metadata.entities`
- Reuse `evaluateCondition()` utility from Entity Action Buttons
- Hide "Pay Now" button when condition not met (vs. showing error after click)
- Example: `{"field": "payment_type_name", "operator": "ne", "value": "Cleaning Fee"}`
- Supports all condition operators: eq, ne, in, gt, lt, gte, lte, is_null, is_not_null
- **Workaround until implemented**: RPC can `RAISE EXCEPTION` with user-friendly message (e.g., "Credit card payments are not available for Cleaning Fees. Please contact xxx-xxx-xxxx to arrange payment.")

---

## Document Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-11-05 | Initial design document |
| 2.0 | 2025-11-05 | Major revision: Sync RPC, entity integration triggers, configurable capture, email service, Stripe onboarding guide, 12-week timeline |
| 2.1 | 2025-11-21 | Incorporated production patterns from Supabase Stripe Sync Engine analysis:<br>• Added webhook event tracking table for atomic deduplication<br>• Enhanced idempotency with timestamp-based WHERE clause pattern<br>• Replaced switch statement with handler registry pattern<br>• Clarified webhook acceptance pattern (always return 200 OK)<br>• Added custom body parser pattern for signature verification<br>• Added advisory locks for critical sections<br>• Added unknown event handling (graceful degradation)<br>• Added comprehensive fixture-based testing strategy<br>• Added benchmark tests for performance validation<br>• Added new section: "Design Patterns from Production Systems" |

---

**End of Design Document**
