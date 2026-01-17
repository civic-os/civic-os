# Civic OS Examples Overview

This guide helps you choose the right example for learning or as a starting point for your project.

## Quick Comparison

| Example | Domain | Best For Learning |
|---------|--------|-------------------|
| [Pot Hole](#pot-hole) | Issue reporting | Basics: CRUD, file uploads, notifications |
| [Community Center](#community-center) | Facility reservations | Calendar, recurring schedules, action buttons |
| [Broader Impacts](#broader-impacts) | Research tracking | Many-to-many relationships, dashboards |
| [Mott Park](#mott-park) | Clubhouse reservations | Payments, status workflows, local Keycloak |
| [StoryMap](#storymap) | Geographic narratives | Map widgets, dashboard storytelling |

## Feature Matrix

| Feature | Pot Hole | Community Center | Broader Impacts | Mott Park | StoryMap |
|---------|:--------:|:----------------:|:---------------:|:---------:|:--------:|
| **TimeSlot / Calendar** | | ✅ | | ✅ | |
| **Recurring Schedules** | | ✅ | | | |
| **Status Workflows** | | | | ✅ | |
| **Stripe Payments** | | ✅ | | ✅ | |
| **Notifications (Email)** | ✅ | ✅ | | ✅ | |
| **Entity Notes** | | ✅ | | | |
| **Static Text Blocks** | | ✅ | | | |
| **Entity Action Buttons** | | ✅ | | | |
| **File Uploads** | ✅ | | | ✅ | |
| **Full-Text Search** | ✅ | ✅ | ✅ | | |
| **Many-to-Many** | | | ✅ | | |
| **Map Widgets** | | | | | ✅ |
| **Filtered List Widgets** | | | ✅ | | ✅ |
| **Calendar Widgets** | | ✅ | | ✅ | |
| **Local Keycloak** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Mock Data Generator** | ✅ | ✅ | ✅ | | ✅ |

## Services by Example

| Service | Port | Pot Hole | Community Center | Broader Impacts | Mott Park | StoryMap |
|---------|------|:--------:|:----------------:|:---------------:|:---------:|:--------:|
| PostgreSQL | 15432 | ✅ | ✅ | ✅ | ✅ | ✅ |
| PostgREST | 3000 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Swagger UI | 8080 | ✅ | ✅ | ✅ | ✅ | ✅ |
| MinIO S3 | 9000/9001 | ✅ | ✅ | ✅ | ✅ | |
| Inbucket SMTP | 9100 | ✅ | ✅ | ✅ | ✅ | |
| Payment Worker | 8081 | | ✅ | | ✅ | |
| Local Keycloak | 8082 | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Pot Hole

**Path:** `examples/pothole/`

**Domain:** Citizen infrastructure issue reporting

**What it demonstrates:**
- Basic CRUD operations with foreign keys
- File uploads (photos of issues)
- Email notifications on status changes
- Form validation rules
- Full-text search
- Role-based permissions (citizen, maintainer, admin)

**Key tables:** `issues`, `issue_statuses`, `issue_types`, `attachments`

**Good starting point for:** Simple issue tracking, service request systems

```bash
cd examples/pothole
docker-compose up -d
```

---

## Community Center

**Path:** `examples/community-center/`

**Domain:** Facility reservation and scheduling

**What it demonstrates:**
- **TimeSlot type** with calendar views (month/week/day)
- **Recurring schedules** (RFC 5545 RRULE support)
- **Entity Notes** (polymorphic notes on any entity)
- **Static Text Blocks** (markdown content on forms)
- **Entity Action Buttons** (Approve/Deny/Cancel workflows)
- Calendar widgets on dashboards
- Overlap prevention (GiST exclusion constraints)
- Email notifications for reservation workflow
- Payment integration (POC)

**Key tables:** `resources`, `reservation_requests`, `reservations`, `time_slots`

**Good starting point for:** Booking systems, appointment scheduling, resource management

**Special files:**
- `CALENDAR_WIDGET_TESTS.md` - Testing calendar features
- `RECURRING_SCHEDULE_TEST_PLAN.md` - Recurring event testing

```bash
cd examples/community-center
docker-compose up -d
```

---

## Broader Impacts

**Path:** `examples/broader-impacts/`

**Domain:** Academic research and partnership tracking

**What it demonstrates:**
- **Many-to-many relationships** (4 junction tables)
- Auto-generated display names (computed columns)
- Filtered list widgets on dashboards
- Full-text search across multiple entities
- Role-based access (user=read-only, admin=full CRUD)

**Key tables:** `organizations`, `contacts`, `projects`, `interest_centers`, `broader_impact_categories`

**Junction tables:** `organization_impacts`, `contact_projects`, `contact_impacts`, `project_impacts`

**Good starting point for:** CRM systems, partnership tracking, grant management

```bash
cd examples/broader-impacts
docker-compose up -d
```

---

## Mott Park

**Path:** `examples/mottpark/`

**Domain:** Recreation area clubhouse reservations with payments

**What it demonstrates:**
- **Status Type System** (multi-stage workflow: Pending → Approved → Completed → Closed)
- **Multiple payment tracking** (security deposit, facility fee, cleaning fee)
- **Stripe payment integration** (production-ready)
- **Local Keycloak** with pre-configured test users
- **Public/private calendar** (approved events visible publicly)
- **Scheduled jobs** (daily automation for reminders)
- Holiday pricing rules

**Key tables:** `reservation_requests`, `reservation_payments`, `reservation_payment_types`, `public_calendar_events`, `holiday_rules`

**Good starting point for:** Complex booking systems with payments, multi-stage approval workflows

**Test accounts (local Keycloak):**
| Username | Password | Roles |
|----------|----------|-------|
| testuser | testuser | user |
| testmanager | testmanager | user, manager |
| testadmin | testadmin | user, admin |

**Special files:**
- `KEYCLOAK_SETUP.md` - Admin API documentation
- `keycloak/mottpark-dev.json` - Realm configuration

```bash
cd examples/mottpark
docker-compose up -d keycloak  # Start Keycloak first
# Wait ~90 seconds for healthy
./fetch-keycloak-jwk.sh && docker-compose restart postgrest
docker-compose up -d  # Start remaining services
```

---

## StoryMap

**Path:** `examples/storymap/`

**Domain:** Geographic narrative visualization

**What it demonstrates:**
- **Map widgets** with progressive clustering
- **Filtered list widgets** with temporal filtering
- **Multi-dashboard narratives** (4 connected chapters)
- **Geography/GeoPoint type** for location data
- Markdown content widgets

**Story:** "From 15 to 200+ Players" - Youth soccer program growth (2018-2025)

**Key tables:** `participants`, `teams`, `team_rosters`, `sponsors`

**Dashboard chapters:**
1. 2018 - Foundation Year (15 players)
2. 2020 - Building Momentum (45 players)
3. 2022 - Acceleration (120 players)
4. 2025 - Impact at Scale (200+ players)

**Good starting point for:** Data storytelling, geographic visualizations, annual reports

```bash
cd examples/storymap
docker-compose up -d
```

---

## Running Examples

### Important: One Example at a Time

All examples use the same ports. Stop one before starting another:

```bash
# Stop current example
docker-compose down

# Switch to new example
cd ../another-example
docker-compose up -d
```

### Quick Start Pattern

```bash
cd examples/<example-name>
cp .env.example .env              # Create local config
docker-compose up -d              # Start services
./fetch-keycloak-jwk.sh           # Fetch JWT keys (if applicable)
docker-compose restart postgrest  # Apply JWT config

# From repo root:
npm start                         # Start Angular frontend
# Visit http://localhost:4200
```

### Reset Database

```bash
docker-compose down -v  # Remove volumes
docker-compose up -d    # Fresh start
```

---

## Learning Path

### Beginner
1. **Pot Hole** - Learn basic CRUD, file uploads, notifications
2. **StoryMap** - Understand dashboard widgets and geographic data

### Intermediate
3. **Broader Impacts** - Master many-to-many relationships
4. **Community Center** - Learn calendar/scheduling features

### Advanced
5. **Mott Park** - Full payment integration, status workflows, local Keycloak

---

## Mock Data Generation

Three examples include mock data generators:

```bash
# Generate fresh mock data
npm run generate pothole
npm run generate broader-impacts
npm run generate community-center

# SQL output only (for inspection)
npm run generate pothole -- --sql
```

Configuration files: `examples/<name>/mock-data-config.json`

---

## See Also

- [CLAUDE.md](../CLAUDE.md) - Complete feature reference
- [INTEGRATOR_GUIDE.md](./INTEGRATOR_GUIDE.md) - Feature configuration guide
- [AUTHENTICATION.md](./AUTHENTICATION.md) - Keycloak setup details
- [docs/development/](./development/) - Technical implementation guides
