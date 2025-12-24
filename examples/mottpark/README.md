# Mott Park Recreation Area - Clubhouse Reservation System

A reservation management system for the Mott Park Recreation Area clubhouse, demonstrating advanced Civic OS features.

## Features Demonstrated

- **TimeSlot Type** - Event scheduling with calendar integration
- **Status Type System** - Workflow management (Pending → Approved/Denied/Cancelled → Completed → Closed)
- **Multi-Payment Tracking** - Security deposit, facility fee, and cleaning fee with Stripe integration
- **Public/Private Calendar** - Public events visible on calendar, private events masked
- **Notification Triggers** - Email notifications on status changes
- **Scheduled Jobs** - Daily automation for payment reminders and event completion
- **Holiday Rules** - Evergreen holiday pricing (weekends/holidays = $300, weekdays = $150)

## Quick Start

```bash
# Start all services
docker-compose up -d

# Start the Angular frontend (from repo root)
cd ../..
npm start
```

Then open http://localhost:4200

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | http://localhost:4200 | Angular app |
| PostgREST API | http://localhost:3000 | REST API |
| Swagger UI | http://localhost:8080 | API documentation |
| Keycloak Admin | http://localhost:8082 | Identity management (admin/admin) |
| Inbucket | http://localhost:9100 | Email testing UI |
| MinIO Console | http://localhost:9001 | S3 file storage UI |
| PostgreSQL | localhost:15432 | Database (user: postgres) |

## Authentication

This example includes a **local Keycloak instance** for full RBAC testing.

### Quick Start (Local Keycloak)

```bash
# Start Keycloak (takes ~90 seconds to be ready)
docker-compose up -d keycloak

# Wait for healthy, then fetch JWT keys
./fetch-keycloak-jwk.sh && docker-compose restart postgrest
```

### Test Accounts

| Username | Password | Roles | Access Level |
|----------|----------|-------|--------------|
| testuser | testuser | user | View records, submit requests |
| testmanager | testmanager | user, manager | Create, edit, manage records |
| testadmin | testadmin | user, admin | Full access + Permissions page |

### Keycloak Admin Console

Access http://localhost:8082 with `admin` / `admin` to:
- Create/manage users
- Assign roles
- View login events

See [KEYCLOAK_SETUP.md](./KEYCLOAK_SETUP.md) for Admin REST API documentation.

### Alternative: Shared Keycloak

To use the shared instance instead, update `.env`:
```bash
KEYCLOAK_URL=https://auth.civic-os.org
KEYCLOAK_REALM=civic-os-dev
KEYCLOAK_CLIENT_ID=myclient
```
Then run `./fetch-keycloak-jwk.sh && docker-compose restart postgrest`

## Stripe Testing

To enable payments:

1. Get test API keys from https://dashboard.stripe.com/test/apikeys
2. Add to `.env`:
   ```
   STRIPE_API_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
3. Restart the payment-worker: `docker-compose restart payment-worker`

## Schema Overview

### Main Tables

- **reservation_requests** - Clubhouse reservation requests
- **reservation_payments** - Individual payment records (deposit, facility, cleaning)
- **reservation_payment_types** - Payment type definitions
- **public_calendar_events** - Synced view of approved events for public calendar
- **holiday_rules** - Evergreen holiday definitions for pricing

### Workflow

1. User submits reservation request (status: Pending)
2. Manager approves/denies request
3. If approved: payment records created, event syncs to public calendar
4. User pays security deposit, then facility fee, then cleaning fee
5. After event: Manager marks as Completed
6. After deposit refund: Manager marks as Closed

## Reset Database

```bash
# Stop and remove volumes
docker-compose down -v

# Restart fresh
docker-compose up -d
```

## File Structure

```
mottpark/
├── docker-compose.yml      # Service definitions
├── .env                    # Local environment variables
├── .env.example           # Template for .env
├── jwt-secret.jwks        # JWT verification keys
├── fetch-keycloak-jwk.sh  # Script to update JWT keys
├── README.md              # This file
├── KEYCLOAK_SETUP.md      # Keycloak Admin API documentation
├── keycloak/              # Keycloak realm configuration
│   └── mottpark-dev.json  # Local dev realm with test users
└── init-scripts/          # Database initialization
    ├── 00_create_authenticator.sh
    ├── 01_mpra_reservations_schema.sql
    ├── 02_mpra_holidays_dashboard.sql
    ├── 03_mpra_manager_automation.sql
    ├── 04_mpra_new_features.sql
    ├── 05_mpra_public_calendar.sql
    ├── 06_mpra_fix_overlap_constraint.sql
    ├── 07_mpra_fix_payment_display_name.sql
    ├── 08_mpra_fix_public_calendar_widget.sql
    ├── 09_mpra_payment_status_sync.sql
    ├── 10_mpra_fix_public_events_types.sql
    ├── 11_mpra_calendar_colors.sql
    ├── 12_mpra_scheduled_jobs.sql
    └── 99_reset_instance.sql
```
