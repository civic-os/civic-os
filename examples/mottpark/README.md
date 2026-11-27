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
- **Mott Fest module** - Festival vendor, food truck and sponsorship applications on top of the clubhouse (see [Mott Fest Module](#mott-fest-module))

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
| RustFS Console | http://localhost:9001 | S3 file storage UI |
| PostgreSQL | localhost:15432 | Database (user: postgres) |

## Authentication

This example includes a **local Keycloak instance** for full RBAC testing.

### Quick Start (Local Keycloak)

```bash
# Start Keycloak (takes ~90 seconds to be ready)
docker-compose up -d keycloak

# Wait for healthy, then start PostgREST (auto-fetches JWKS)
docker-compose up -d --build
```

### Test Accounts

| Username | Password | Roles | Access Level |
|----------|----------|-------|--------------|
| testuser | testuser | user | View records, submit requests |
| testeditor | testeditor | user, editor | Create and edit records |
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
Then run `docker-compose up -d --build` to restart PostgREST with the new Keycloak URL

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

## Mott Fest Module

Scripts 34-38 and 40 add Mott Fest, the park's annual festival: organizers open a festival, the public applies as vendors, food trucks or sponsors, and organizers review, collect fees and close the festival. The module needs Civic OS v0.82.0+ (role-gated dashboards, the configurable menu and selector-hidden dashboards).

| Script | Adds |
|--------|------|
| `34_mottfest_schema.sql` | The `festival` table, the three application tables, the `mottfest_admin` role, statuses, categories, RLS, the revenue summary views and the anonymous feedback form (`feedback_submission`) |
| `35_mottfest_actions_payments.sql` | Review actions (approve, deny, waive, record payment, withdraw), festival open/close/complete, and the Pay Now guards that refuse unpayable rows with a message |
| `36_mottfest_notifications.sql` | Eight email templates and their triggers; the reply-to address comes from the `mottfest_contact_email` instance config key |
| `37_mottfest_dashboards_menu.sql` | Mott Fest and Mott Fest Management dashboards (review queues, payments, revenue and a "Thank-Yous Due" sponsor list), the "Thanks for your feedback" dashboard (hidden from the selector, reached after the survey) and the Mott Fest menu heading. The dashboards are shown only to `mottfest_admin` until script 40 runs |
| `38_mottfest_sample_data.sql` | **Example only.** An Open "Mott Fest (Sample)" festival with applications in every status, owned by placeholder users nobody can sign in as |
| `40_mottfest_launch.sql` | **Launch.** Makes the Mott Fest dashboard public, lets every signed-in user open the Thanks page, and adds the Mott Fest banner beside the welcome header on the default dashboard. Dashboards can't be menu entries yet ([civic-os/civic-os#124](https://github.com/civic-os/civic-os/issues/124)), so the banner and the dashboard selector lead to them |

**Naming.** Mott Fest tables are singular (`festival`, `vendor_application`), and so are entity display names ("Booth Vendor Application"), because pages build "Add {entity}" and "{entity}: {record}" from them. Menu nodes carry the plural labels ("Booth Vendor Applications"). `39_mpra_entity_names.sql` gives the clubhouse entities the same singular names and plural menu labels without renaming their tables, so URLs, API paths and iCal feed URLs are unchanged.

Every script records its schema decisions in `metadata.schema_decisions` and is safe to re-run. Re-runs keep an admin's menu and dashboard edits.

**Staged launch.** Scripts 34-38 can go onto a live instance well before the festival: organizers (`mottfest_admin`) and admins see the Mott Fest dashboards and can test every flow, while clubhouse users see no dashboard or landing-page change. The Mott Fest menu heading is not staged and shows from script 37 on, because menu hiding applies to everyone, admins included. Script 40 is the launch switch; production runs it last, as `37_mottfest_launch.sql`. A fresh example database runs it too, so it starts launched.

**Organizer access.** No test account is an organizer by default. Sign in as `testadmin`, open User Management and give a user the `mottfest_admin` role; the worker syncs it to Keycloak, so it is in the token at that user's next sign-in. The clubhouse `manager` role grants nothing in Mott Fest.

**Functional test.** With the stack running (and the worker, for the mail checks):

```bash
tests/functional/mottfest-module-test.sh
```

It signs in as testuser and testmanager (applicants), testeditor (made organizer for the run) and testadmin, and removes everything it creates. Stripe completion (paying with a test card through `stripe listen`) is not covered and is checked by hand. To run it against another database built from the production numbering, point `SCRIPTS_DIR` at that directory: script names are read from it.

**Removing the module.** Section 0 of `99_reset_instance.sql` drops everything 34-38 and 40 add and leaves the clubhouse alone; it does nothing on an instance without the module.

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
├── README.md              # This file
├── KEYCLOAK_SETUP.md      # Keycloak Admin API documentation
├── view-security-allowlist.txt  # Deliberate definer views (none; read by the nightly guard)
├── 99_reset_instance.sql  # Clears instance data, Mott Fest first (Section 0)
└── init-scripts/          # Database initialization, run in order on first start
    ├── 00_create_authenticator.sh
    ├── 01-05_mpra_*.sql   # Clubhouse schema, dashboard, automation, public calendar
    ├── 06-33_mpra_*.sql   # Clubhouse fixes and features (.disabled files are superseded)
    ├── 34_mottfest_schema.sql
    ├── 35_mottfest_actions_payments.sql
    ├── 36_mottfest_notifications.sql
    ├── 37_mottfest_dashboards_menu.sql
    ├── 38_mottfest_sample_data.sql   # Example only
    ├── 39_mpra_entity_names.sql      # Singular clubhouse entity names, plural menu labels
    └── 40_mottfest_launch.sql        # Shows Mott Fest to everyone (run last in production)
```
