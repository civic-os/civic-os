# Community Center Reservations Example

This example demonstrates Civic OS's calendar integration features with a community center facility reservation system.

## Quick Start (Docker)

```bash
cd examples/community-center
cp .env.example .env
docker-compose up -d

# Wait for initialization (check logs)
docker-compose logs -f postgres
```

Then open your browser to `http://localhost:4200` and navigate to:
- `/view/resources` - View available facilities
- `/view/reservations` - See calendar view of approved reservations
- `/view/reservation_requests` - Manage booking requests

**Standard Ports** (same across all examples):
- PostgreSQL: 15432
- PostgREST: 3000
- Swagger UI: 8080
- MinIO: 9000 (API), 9001 (Console)

**Note**: Only one example can run at a time. Stop the pothole example (`docker-compose down`) before starting community-center.

## Features Demonstrated

- **TimeSlot Property Type**: Uses `time_slot` domain (tstzrange) for appointment scheduling
- **Calendar Views**: List page shows calendar view of approved reservations
- **Detail Page Calendars**: Resource detail pages show related reservations in a calendar
- **Custom Dashboard**: "Community Center Overview" with pending requests, upcoming reservations, and facilities
- **Metadata Enhancements**: User-friendly display names and helpful field descriptions
- **Approval Workflow**: Request → Review → Approve/Deny → Auto-create Reservation
- **Database Triggers**: Automatic synchronization between requests and reservations
- **Row-Level Security**: Users can only see their own requests
- **Timezone Handling**: Stores UTC, displays in user's local timezone

## File Structure

### Helper Files

- **`community-center.sql`** - Consolidated SQL file combining all init scripts for easy deployment
- **`jwt-secret.jwks`** - Keycloak JWT public key for local development (shared dev realm)
- **`fetch-keycloak-jwk.sh`** - Script to fetch latest JWT key from Keycloak
- **`mock-data-config.json`** - Configuration for mock data generation (future use)
- **`docker-compose.yml`** - Complete Docker stack for local development
- **`.env.example`** - Environment variable template

### Init Scripts (run in order)

- **`00_create_authenticator.sh`** - Creates PostgreSQL authenticator role
- **`01_reservations_schema.sql`** - Tables, triggers, PostgreSQL grants, sample data
- **`02_community_center_permissions.sql`** - RBAC permissions (maps standard roles to tables)
- **`03_text_search.sql`** - Full-text search configuration
- **`04_metadata_enhancements.sql`** - Display names, descriptions, and custom dashboard

## Schema Overview

### Tables

1. **`resources`** - Community facilities (Club House, etc.)
   - Tracks capacity, hourly rate, and availability status

2. **`reservation_requests`** - User-submitted booking requests
   - Statuses: pending, approved, denied, cancelled
   - Emoji-enhanced display names (⏳ pending, ✓ approved, ✗ denied, 🚫 cancelled)
   - RLS policies: users see only their own requests

3. **`reservations`** - Approved bookings (auto-managed via triggers)
   - Calendar view enabled (`show_calendar=true`)
   - Source of truth for facility availability
   - Exclusion constraint prevents double-booking

### Workflow

1. User creates reservation request → Status: pending
2. Editor reviews request → Changes status to approved/denied
3. Trigger automatically:
   - **If approved**: Creates reservation record, links to request
   - **If denied**: No reservation created
   - **If cancelled**: Deletes linked reservation

## Setup

### Option 1: Local Development (Docker)

```bash
cd examples/community-center
cp .env.example .env
docker-compose up -d
```

The database will automatically run migrations and initialize the schema via init scripts.

### Option 2: Hosted PostgreSQL (Consolidated SQL)

```bash
# 1. Deploy Civic OS core migrations (v0.9.0+)
docker run --rm -e PGRST_DB_URI="postgresql://postgres:password@host:5432/civic_os" \
  ghcr.io/civic-os/migrations:v0.9.0 deploy

# 2. Create authenticator role
psql -h your-host -U postgres -d civic_os -c \
  "CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'your-password';"

# 3. Run consolidated SQL file
psql -h your-host -U postgres -d civic_os -f community-center.sql
```

### Option 3: Using Init Scripts (Manual)

```bash
cd examples/community-center/init-scripts

# Run scripts in order
./00_create_authenticator.sh  # (edit connection string first)
psql -h host -U postgres -d civic_os -f 01_reservations_schema.sql
psql -h host -U postgres -d civic_os -f 02_community_center_permissions.sql
psql -h host -U postgres -d civic_os -f 03_text_search.sql
psql -h host -U postgres -d civic_os -f 04_metadata_enhancements.sql
```

## Using the Community Center System

### 1. Dashboard Overview

```
Navigate to: /dashboard
```

The "Community Center Overview" dashboard provides:
- **Pending Approval**: Reservation requests awaiting review (editors can click to approve/deny)
- **Upcoming Reservations**: Calendar view of all approved bookings
- **Available Facilities**: List of active community center spaces
- **Recent Requests**: Latest reservation requests across all statuses

**First-Time Users**: The dashboard is set as the default landing page and is visible to all users (public dashboard).

### 2. View Reservations Calendar (List Page)

```
Navigate to: /view/reservations
```

- **List/Calendar Toggle**: Click "Calendar" tab to see monthly view
- **Event Colors**: Approved reservations appear in default blue
- **Event Clicks**: Click event to navigate to reservation detail page

### 3. View Resource Calendar (Detail Page)

```
Navigate to: /view/resources/1  (Club House)
```

- **Calendar Section**: Shows all reservations for this resource
- **Event Clicks**: Click to navigate to reservation detail
- **Date Selection**: Click/drag on calendar to create new reservation request with pre-filled time slot
- **"Add" Button**: Creates new request with resource pre-filled

### 4. Create Reservation Request

```
Navigate to: /create/reservation_requests
```

- **Time Slot Input**: Two datetime-local inputs (start + end)
- **Timezone Conversion**: Automatically converts to/from UTC
- **Validation**: End time must be after start time
- **Submit**: Creates pending request

### 5. Approve/Deny Requests (Requires Editor Role)

```
Navigate to: /view/reservation_requests
Filter by: status = pending
```

- **Review Details**: Click request to view Edit page
- **Approve**: Change status to "approved" → Trigger creates reservation
- **Deny**: Change status to "denied", add denial_reason
- **Verify**: Check `/view/reservations` to see approved requests appear in calendar

## Database Constraints

### Overlap Prevention

The `reservations` table has an exclusion constraint to prevent double-booking:

```sql
EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&)
```

This ensures:
- Same resource cannot have overlapping time slots
- Database-level enforcement (cannot be bypassed)
- Uses GiST index for efficient range queries
- Requires `btree_gist` extension (included in Civic OS v0.9.0+)

**Note**: Phase 5 (frontend async validation) is not yet implemented, so overlap errors appear only on submit.

### Time Slot Validation

Both tables enforce valid time ranges:

```sql
CHECK (NOT isempty(time_slot) AND lower(time_slot) < upper(time_slot))
```

## Roles & Permissions

### Default Roles

- **anonymous**: No access
- **user** (authenticated):
  - Can create reservation requests
  - Can view own requests only
  - Can view all resources and reservations
- **editor**:
  - All user permissions
  - Can update any reservation request (approve/deny)
  - Can view all requests
- **admin**:
  - Full access to all tables
  - Can directly manipulate reservations table

### RLS Policies

```sql
-- Users see only their own requests
FOR SELECT USING (requested_by = public.current_user_id() OR has_permission(...))

-- Users can create requests
FOR INSERT WITH CHECK (requested_by = public.current_user_id())

-- Only editors can update requests (approve/deny)
FOR UPDATE USING (has_permission('reservation_requests', 'update'))
```

## Sample Data

The schema includes:
- 1 resource: "Club House" (75 capacity, $25/hour)
- 1 approved reservation (Saturday birthday party)
- 2 pending requests (Sunday meeting, weekday book club)
- 1 denied request (late night event - demonstrates workflow)

## Mock Data Generation

The example includes a `mock-data-config.json` file for generating additional test data using the Civic OS mock data generator:

```bash
# Generate mock data (from project root)
npm run generate community-center

# Or using the shell wrapper
./examples/generate.sh community-center
```

**Note**: Currently, the schema includes sufficient sample data (1 resource, 4 requests). Mock data generation is optional and can be configured via `mock-data-config.json`.

## Known Limitations

1. **No Overlap Validation (Frontend)**: Phase 5 not implemented - users discover conflicts only on submit
2. **No Recurring Events**: Each reservation is one-time
3. **Capacity Not Enforced**: `attendee_count` can exceed resource capacity
4. **Users Cannot Edit Requests**: Once submitted, must contact editor
5. **No Notifications**: Approval/denial doesn't trigger emails

## Future Enhancements

See `docs/development/CALENDAR_INTEGRATION.md` for roadmap:
- Phase 5: Frontend overlap validation with async validators
- Payment processing integration
- Recurring reservations (RRULE support)
- Email/SMS notifications
- Conflict resolution UI

## Troubleshooting

### Trigger Not Firing

```sql
-- Verify trigger exists
SELECT tgname FROM pg_trigger WHERE tgrelid = 'reservation_requests'::regclass;

-- Test manually
UPDATE reservation_requests SET status = 'approved' WHERE id = 1;
SELECT * FROM reservations;  -- Should see new record
```

### RLS Blocking Queries

```sql
-- Check current user roles
SELECT get_user_roles();

-- Temporarily disable RLS for testing (as admin)
ALTER TABLE reservation_requests DISABLE ROW LEVEL SECURITY;
```

### Calendar Not Showing

Check metadata:

```sql
SELECT show_calendar, calendar_property_name
FROM metadata.entities
WHERE table_name = 'reservations';
-- Should return: TRUE | time_slot
```

## Quick Reference

### Start/Stop Commands

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Reset database (delete all data)
docker-compose down -v
docker-compose up -d

# Access PostgreSQL directly
docker exec -it postgres_db psql -U postgres -d civic_os
```

### Frontend Development

```bash
# In project root (not examples/community-center/)
npm start

# Frontend will connect to PostgREST on localhost:3000
# Visit http://localhost:4200
```

### Useful SQL Queries

```sql
-- Check calendar metadata
SELECT table_name, show_calendar, calendar_property_name, calendar_color_property
FROM metadata.entities
WHERE show_calendar = TRUE;

-- View all reservation requests
SELECT id, status, purpose, time_slot, requested_by
FROM reservation_requests
ORDER BY created_at DESC;

-- View approved reservations (calendar events)
SELECT r.id, r.purpose, r.time_slot, res.display_name as resource
FROM reservations r
JOIN resources res ON r.resource_id = res.id
ORDER BY lower(r.time_slot);

-- Check for overlapping reservations
SELECT r1.id, r1.purpose, r1.time_slot
FROM reservations r1
JOIN reservations r2 ON r1.resource_id = r2.resource_id
  AND r1.id != r2.id
  AND r1.time_slot && r2.time_slot;
```

## License

AGPL-3.0-or-later (same as parent project)
