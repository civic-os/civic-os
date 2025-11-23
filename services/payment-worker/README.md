# Payment Worker (POC)

Minimal proof-of-concept payment processing microservice for Civic OS. Handles Stripe PaymentIntent creation via River job queue.

## Overview

This is Phase 0.1 of the payment processing system - a vertical slice that proves:
- Synchronous RPC with polling works acceptably
- River job queue handles payment jobs reliably
- Stripe API integration works correctly
- Separate service architecture is viable

**What it does:** Creates Stripe PaymentIntents when payments are inserted into `payments.transactions` table.

**What it doesn't do (yet):** Webhooks, refunds, entity sync, email notifications, deferred capture.

## Architecture

```
PostgreSQL Trigger → River Job Queue → Payment Worker → Stripe API
     ↓                                        ↓
RPC polls status                       Updates database
```

1. User calls `create_payment_intent_sync(amount, description)` RPC
2. RPC inserts payment with status='pending_intent'
3. Trigger enqueues River job
4. Payment Worker picks up job and calls Stripe API
5. Worker updates payment with client_secret
6. RPC returns client_secret to frontend

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgres://...` | PostgreSQL connection string |
| `STRIPE_API_KEY` | Yes | _(none)_ | Stripe secret key (sk_test_... or sk_live_...) |
| `PAYMENT_CURRENCY` | No | `USD` | Default currency for payments |
| `RIVER_WORKER_COUNT` | No | `1` | Number of concurrent workers |
| `DB_MAX_CONNS` | No | `4` | Max database connections |
| `DB_MIN_CONNS` | No | `1` | Min database connections |

## Stripe Setup

1. Create Stripe account: https://dashboard.stripe.com/register
2. Get test API keys from Developers → API keys
3. Set `STRIPE_API_KEY=sk_test_...` in environment

## Development

```bash
# Install dependencies
cd services/payment-worker
go mod download

# Run locally (requires Postgres with payments schema)
export DATABASE_URL="postgres://authenticator:password@localhost:5432/civic_os"
export STRIPE_API_KEY="sk_test_..."
go run .
```

## Testing

### Manual Test (SQL)

```sql
-- Call RPC to create payment (should return in ~3 seconds)
SELECT create_payment_intent_sync(2500, 'Test payment $25.00');

-- Should return:
-- {
--   "payment_id": "...",
--   "client_secret": "pi_...secret_...",
--   "amount": 25.00,
--   "currency": "USD",
--   "status": "pending",
--   "description": "Test payment $25.00"
-- }

-- Check payment was created
SELECT * FROM payments.transactions ORDER BY created_at DESC LIMIT 1;

-- Check Stripe dashboard to verify PaymentIntent was created
```

### Test Payment Flow

1. Start payment-worker: `docker-compose up payment-worker`
2. Connect to database: `psql $DATABASE_URL`
3. Run test query above
4. Verify in Stripe dashboard: https://dashboard.stripe.com/test/payments

## Docker

```bash
# Build image
docker build -t civic-os/payment-worker:dev .

# Run container
docker run -e DATABASE_URL="..." -e STRIPE_API_KEY="sk_test_..." \
  civic-os/payment-worker:dev
```

## Monitoring

```bash
# Check worker logs
docker-compose logs -f payment-worker

# Check River job queue
psql $DATABASE_URL -c "SELECT * FROM metadata.river_job WHERE kind = 'create_payment_intent' ORDER BY created_at DESC LIMIT 10;"

# Check payment status
psql $DATABASE_URL -c "SELECT id, amount, status, provider_payment_id, created_at FROM payments.transactions ORDER BY created_at DESC LIMIT 10;"
```

## Troubleshooting

### "Timeout after 30 seconds"
- Check if payment-worker is running: `docker-compose ps payment-worker`
- Check worker logs: `docker-compose logs payment-worker`
- Verify Stripe API key is set correctly

### "Stripe API error"
- Check Stripe API key format (should start with `sk_test_` or `sk_live_`)
- Verify Stripe dashboard is accessible
- Check worker logs for detailed error message

### "Payment not found"
- Check if migration was applied: `sqitch status`
- Verify `payments` schema exists: `\dn` in psql

## Next Steps (Post-POC)

After proving this architecture works:
1. Add webhook processing for async status updates
2. Add entity sync (update entity.payment_status)
3. Add refund functionality
4. Add email notifications
5. Add deferred capture support
6. Add frontend PaymentCheckoutComponent

## License

Copyright (C) 2023-2025 Civic OS, L3C

AGPL-3.0-or-later
