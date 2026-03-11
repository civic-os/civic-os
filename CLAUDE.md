# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **⚠️ MAINTENANCE GUIDELINES FOR THIS FILE**
>
> This file is an **index**, not a tutorial. When updating CLAUDE.md:
> - **DO NOT add code samples** (SQL, TypeScript, bash) - put them in `docs/` files instead
> - **DO** add brief descriptions of features with doc references
> - **DO** keep essential bash commands for development (npm scripts, docker commands)
> - **DO** keep critical warnings that prevent common mistakes (e.g., FK index requirement)
> - **EXCEPTION**: Angular patterns (Signals, OnPush) stay here as they're project-wide conventions
>
> Pattern to follow: `**Feature Name** (version): Brief description. See \`docs/path/FILE.md\` for details.`

## Project Overview

Civic OS is a meta-application framework that automatically generates CRUD (Create, Read, Update, Delete) views for any PostgreSQL database schema. The Angular frontend dynamically creates list, detail, create, and edit pages based on database metadata stored in custom PostgreSQL views.

**Key Concept**: Instead of manually building UI for each table, Civic OS reads database schema metadata from `schema_entities` and `schema_properties` views to automatically generate forms, tables, and validation.

**License**: This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (C) 2023-2026 Civic OS, L3C. See the LICENSE file for full terms.

## Architecture

### Core Data Flow
1. **Database Schema** → PostgreSQL metadata tables (`metadata.entities`, `metadata.properties`)
2. **Metadata Views** → `schema_entities` and `schema_properties` views aggregate database structure
3. **SchemaService** → Fetches metadata and determines property types (text, number, foreign key, etc.)
4. **DataService** → Performs CRUD operations via PostgREST API
5. **Dynamic Pages** → List/Detail/Create/Edit pages render based on schema metadata
6. **Smart Components** → `DisplayPropertyComponent` and `EditPropertyComponent` adapt to property types

### Key Services

**SchemaService** (`src/app/services/schema.service.ts`) - Fetches and caches entity and property metadata, determines property types from PostgreSQL data types (e.g., `int4` with `join_column` → `ForeignKeyName`), filters properties for different contexts (list, detail, create, edit). Uses hybrid signal + observable pattern with in-flight request tracking to prevent duplicate HTTP requests (83% reduction in network traffic). See `docs/development/SCHEMA_SERVICE_ARCHITECTURE.md` for implementation details

**DataService** (`src/app/services/data.service.ts`) - Abstracts PostgREST API calls, builds query strings with select fields, ordering, and filters

**AuthService** (`src/app/services/auth.service.ts`) - Integrates with Keycloak for authentication via `keycloak-angular` library

### Property Type System

The `EntityPropertyType` enum maps PostgreSQL types to UI components:
- `ForeignKeyName`: Integer/UUID with `join_column` → Dropdown with related entity's display_name
- `User`: UUID with `join_table = 'civic_os_users'` → User display component with unified view access. See `docs/development/PROPERTY_TYPE_REFERENCE.md` for architecture details.
- `Payment`: UUID FK to `payments.transactions` → Payment status badge display, "Pay Now" button on detail pages (v0.13.0+)
- `DateTime`, `DateTimeLocal`, `Date`: Timestamp types → Date/time inputs
- `Boolean`: `bool` → Checkbox
- `Money`: `money` → Currency input (ngx-currency)
- `IntegerNumber`: `int4`/`int8` → Number input
- `TextShort`: `varchar` → Text input
- `TextLong`: `text` → Textarea
- `GeoPoint`: `geography(Point, 4326)` → Interactive map (Leaflet) with location picker
- `Color`: `hex_color` → Color chip display with native HTML5 color picker
- `Email`: `email_address` → Clickable mailto: link, HTML5 email input
- `Telephone`: `phone_number` → Clickable tel: link with formatted display, masked input (XXX) XXX-XXXX
- `TimeSlot`: `time_slot` (tstzrange) → Formatted date range display, dual datetime-local inputs with validation, optional calendar visualization

**Color Type** (`hex_color`): RGB color values with `#RRGGBB` validation. UI shows color chip + picker.

**Email Type** (`email_address`): RFC 5322 validation. UI shows clickable mailto: links.

**Telephone Type** (`phone_number`): US 10-digit format. UI shows formatted (XXX) XXX-XXXX with masked input.

**TimeSlot Type** (`TimeSlot`): Use the `time_slot` domain (wraps `tstzrange`) for scheduling. Database stores UTC, UI displays local timezone. Edit provides two datetime-local inputs with validation.

**Calendar Integration** (v0.9.0+): Enable via `show_calendar=true` and `calendar_property_name` in `metadata.entities`. Supports overlap prevention via GIST exclusion constraints. See `docs/development/CALENDAR_INTEGRATION.md` for details and `examples/community-center/` for working example.

**iCal Subscription Feeds** (v0.27.0+): Export public calendar events as subscribable iCal feeds. Uses RFC 5545 helper functions (`format_ical_event()`, `wrap_ical_feed()`) with PostgREST media type handlers. Calendar apps (Google Calendar, Apple, Outlook) can subscribe to `/rpc/your_feed_function`. See `docs/INTEGRATOR_GUIDE.md` (iCal Calendar Feeds section) for implementation guide.

**Status Type** (`Status`, v0.15.0+): Centralized workflow system using `metadata.statuses` table with `entity_type` discriminator. Features colored badges/dropdowns, `is_initial`/`is_terminal` states, allowed transitions (v0.33.0+), and `status_key` for programmatic references. See `docs/INTEGRATOR_GUIDE.md` (Status Type System section) and `docs/development/STATUS_TYPE_SYSTEM.md` for design.

**Category** (`Category`, v0.34.0+): Simple enum categorization using `metadata.categories` table with `entity_type` discriminator. No workflow semantics (unlike Status). Use for name/color/sort_order values; use a custom lookup table if categories need extended properties. See `docs/INTEGRATOR_GUIDE.md` (Category System section) and `examples/staff-portal/`.

**Entity Notes** (v0.16.0+): Polymorphic notes system any entity can opt into. Features permission-isolated notes (`{entity}:notes:read/create`), system notes for audit trails, Markdown formatting, and export support. Enable via `SELECT enable_entity_notes('entity_type')`. See `docs/INTEGRATOR_GUIDE.md` (Entity Notes System section) for complete guide.

**Static Text Blocks** (v0.17.0+): Display-only markdown content blocks on Detail, Create, and Edit pages. Blocks are stored in `metadata.static_text` table and interspersed with properties by `sort_order`. Supports full markdown (headers, lists, bold, italic, links) via `ngx-markdown`, configurable visibility (`show_on_detail`, `show_on_create`, `show_on_edit`), and 1-8 column width.

See `docs/INTEGRATOR_GUIDE.md` (Static Text Blocks section) for usage guide and `examples/community-center/init-scripts/12_static_text_example.sql` for working example.

**Entity Action Buttons** (v0.18.0+): Metadata-driven action buttons on Detail pages that execute PostgreSQL RPC functions. Supports conditional visibility, confirmation modals, role-based permissions, and customizable icons/colors. **Action Parameters** (v0.32.0+) allow user-provided form fields in modals via `metadata.entity_action_params`. **Maintenance note**: When adding a new `EntityPropertyType`, check if it should also be added as an action param type. See `docs/INTEGRATOR_GUIDE.md` (Entity Action Buttons section) and `docs/development/ENTITY_ACTIONS.md` for details.

**Recurring Time Slots** (v0.19.0+): RFC 5545 RRULE-compliant recurring schedule system. Enable via `supports_recurring=true` and `recurring_property_name` in `metadata.entities`. Architecture: Series Groups → Series (RRULE + template) → Instances. Edit scope dialogs support "This only", "This and future", and "All" modifications. Managed at `/admin/recurring-schedules`. See `docs/notes/RECURRING_TIMESLOT_DESIGN.md` for complete architecture.

**Virtual Entities** (v0.28.0+): PostgreSQL VIEWs with INSTEAD OF triggers can behave like regular entities (full CRUD support). Use cases: simplified form interfaces, auto-approval workflows, computed defaults. Requirements: VIEW must have INSTEAD OF triggers for INSERT/UPDATE/DELETE + explicit `metadata.entities` entry (VIEWs are not auto-discovered). FK columns auto-inherit from base tables via `view_column_usage`; computed columns need manual `metadata.properties.join_table/join_column` config. See `docs/INTEGRATOR_GUIDE.md` (Virtual Entities section) for complete guide and `examples/mottpark/init-scripts/22_mpra_manager_events.sql` for working example.

**System Introspection** (v0.23.0+): Auto-generated documentation for RPC functions, database triggers, and notification workflows. Features permission-filtered views (`schema_functions`, `schema_triggers`, `schema_entity_dependencies`, `schema_notifications`), static code analysis for entity effect detection, and admin-only views (`schema_permissions_matrix`, `schema_scheduled_functions`). Register functions via `metadata.auto_register_function()`. See `docs/INTEGRATOR_GUIDE.md` (System Introspection section) for complete guide and `examples/mottpark/init-scripts/13_mpra_introspection.sql` for working example.

**Source Code Block Visualization** (v0.29.0+): Read-only Blockly-based visualization of PL/pgSQL functions and SQL views. Pages: Entity Code (`/entity-code/:entity`), System Functions (`/system-functions`), System Policies (`/system-policies`). See `docs/notes/CODE_BLOCK_SYSTEM_DESIGN.md` for architecture and AST node mapping reference.

**Schema Decisions (ADR)** (v0.30.0+): Database-native architectural decision records via `metadata.schema_decisions` table. **Every schema change should include a `create_schema_decision()` call documenting the rationale.** Before modifying any entity's schema, **query existing decisions first**. See `docs/INTEGRATOR_GUIDE.md` (Schema Decisions section) for complete guide.

**File Storage Types** (`FileImage`, `FilePDF`, `File`): UUID foreign keys to `metadata.files` table for S3-based file storage with automatic thumbnail generation. Architecture includes database tables, consolidated worker service (S3 signer + thumbnail generation), and presigned URL workflow. See `docs/development/FILE_STORAGE.md` for complete implementation guide including adding file properties to your schema, validation types, and configuration

**Payment Type** (`Payment`, v0.13.0+): Stripe-based payment processing via UUID FK to `payments.transactions`. Enable on any entity via `payment_initiation_rpc` in `metadata.entities`. Frontend auto-displays payment badges on List pages and "Pay Now" button on Detail pages. See `docs/INTEGRATOR_GUIDE.md` (Payment System section) for complete workflow and `examples/community-center/` for working example.

**Consolidated Worker Architecture**: File storage, thumbnail generation, payment processing, and notification features run in a single Go + River microservice with a shared PostgreSQL connection pool (4 connections vs 12 with separate services). Provides at-least-once delivery, automatic retries with exponential backoff, row-level locking, and zero additional infrastructure beyond PostgreSQL. See `docs/development/GO_MICROSERVICES_GUIDE.md` for complete architecture and `docs/development/FILE_STORAGE.md` for usage guide

**Geography (GeoPoint) Type**: Requires a paired `<column_name>_text` computed field returning `ST_AsText()`. Maps auto-switch light/dark tiles based on DaisyUI theme. See `docs/development/PROPERTY_TYPE_REFERENCE.md` for computed field pattern and map dark mode details.

**DateTime vs DateTimeLocal - Timezone Handling**: `DateTime` (`timestamp`) stores wall-clock time with no conversion; `DateTimeLocal` (`timestamptz`) converts between user's local timezone and UTC. **CRITICAL**: The transformation logic in `EditPage.transformValueForControl()`, `EditPage.transformValuesForApi()`, and `CreatePage.transformValuesForApi()` handles these conversions — modifying this code can cause data integrity issues. See `docs/development/DATETIME_HANDLING.md` for details.

**Many-to-Many Relationships**: Auto-detected from junction tables. **CRITICAL**: Junction tables MUST use composite primary keys (NOT surrogate IDs). Renders on Detail pages with `ManyToManyEditorComponent`. Requires CREATE/DELETE permissions on junction table. See `docs/notes/MANY_TO_MANY_DESIGN.md` for implementation details and SQL examples.

**Full-Text Search**: Add `civic_os_text_search` tsvector column (generated, indexed) and configure `metadata.entities.search_fields` array. Frontend automatically displays search input on List pages. See example tables for implementation pattern.

**Excel Import/Export**: List pages include Import/Export buttons for bulk data operations. Export preserves filters/search/sort and includes foreign key display names. Import supports name-to-ID resolution for foreign keys with comprehensive validation. Requires CREATE permission. **Custom Import Mode** (v0.31.0+): `CustomImportConfig` abstraction enables non-entity imports (e.g., User Management bulk import) with inline validation and partial success handling.

**Limitations**: No M:M relationships (use junction table import), 10MB file limit, 50,000 row export limit, INSERT only (no updates).

See `docs/development/IMPORT_EXPORT.md` and `docs/INTEGRATOR_GUIDE.md` for complete specification.

## Custom Dashboards

**Status**: Phase 2 complete - Dynamic widgets (filtered lists, maps with clustering)

The home page (`/`) displays configurable dashboards with extensible widget types. Dashboard selector in navbar switches between available dashboards.

**Current**: ✅ View dashboards ✅ Markdown widgets ✅ Filtered list widgets ✅ Map widgets with clustering ✅ Calendar widgets ❌ Management UI ❌ Auto-refresh

**Configuration**: Create dashboards via SQL INSERT into `metadata.dashboards` and `metadata.dashboard_widgets`. Requires `created_by = current_user_id()` for ownership. Widget types use registry pattern. See `docs/development/DASHBOARD_WIDGETS.md` for complete widget type reference, filter operators, and troubleshooting. See `docs/INTEGRATOR_GUIDE.md` for SQL examples and `docs/notes/DASHBOARD_DESIGN.md` for architecture.

## Development Commands

**Daily Development:**
```bash
npm start                          # Start dev server (http://localhost:4200)
npm run watch                      # Build in watch mode
```

**Testing:**
```bash
npm run test:headless              # Run once and exit (RECOMMENDED - use this!)
npm test -- --no-watch             # Run all tests without watch mode
npm test -- --no-watch --include='**/schema.service.spec.ts'  # Run specific file
```

**CRITICAL**: Always use `--no-watch` or `npm run test:headless` when running tests as Claude Code. Watch mode keeps the process running indefinitely, which blocks the tool and wastes resources. The `test:headless` script is specifically configured to run once and exit cleanly.

**EFFICIENT DEBUGGING**: When debugging test failures, save output to a file for quick searching:
```bash
npm run test:headless 2>&1 | tee /tmp/test-output.txt  # Run tests, save output
grep "FAILED" /tmp/test-output.txt                      # Find all failures
grep -B 5 -A 10 "FAILED" /tmp/test-output.txt          # Get failure context
```
This avoids re-running the full test suite (30+ seconds) when investigating multiple failures.

See `docs/development/TESTING.md` for comprehensive testing guidelines, best practices, and troubleshooting.

**⚠️ MANDATORY: Run Tests Before Committing**

You **MUST** run the full test suite (`npm run test:headless`) before staging or committing ANY code changes. This is non-negotiable. Failing tests that reach CI/CD waste time and break the build.

- Run `npm run test:headless` after completing your changes
- If tests fail, fix them before staging
- Never ignore failing tests or assume they're "unrelated" to your changes
- Adding new services/dependencies to components often requires updating test mocks

**Building:**
```bash
npm run build                      # Production build
```

**Code Generation:**
```bash
ng generate component components/component-name
ng generate service services/service-name
ng generate component pages/page-name --type=page  # Use "page" suffix by convention
```

**Mock Data Generation:**
```bash
# Using npm wrapper (recommended):
npm run generate pothole              # Generate for Pot Hole example
npm run generate pothole -- --sql     # SQL file only
npm run generate broader-impacts      # Generate for Broader Impacts (UMFlint)
npm run generate community-center     # Generate for Community Center example

# Using shell wrapper (alternative):
./examples/generate.sh pothole --sql
./examples/generate.sh broader-impacts
```

The mock data generator is **validation-aware**: it fetches validation rules from `metadata.validations` and generates compliant data (respects min/max, minLength/maxLength, pattern constraints). Each example has its own `mock-data-config.json` to control record counts and geography bounds.

**Important**: Mock data should be generated AFTER database initialization (after `docker-compose up`), not during init scripts. This allows schema changes to flow smoothly without being blocked by stale static SQL files. Examples are located in the `examples/` directory (pothole, broader-impacts, community-center, mottpark, storymap). All examples use the same port configuration - only run one example at a time.

**Examples Overview**: See `docs/EXAMPLES.md` for a comparison of all examples showing which features each demonstrates (calendar, payments, notifications, etc.) and recommended learning paths.

## Database Setup

Docker Compose runs PostgreSQL 17 with PostGIS 3.5 and PostgREST locally with Keycloak authentication. The development environment uses **Sqitch migrations** (same as production) to set up the core Civic OS schema, ensuring dev/prod parity.

**Migration Flow** (automatic on first `docker-compose up`):
1. Postgres container builds custom image with Sqitch installed (`docker/dev-postgres/Dockerfile`)
2. Init script creates authenticator role (`examples/<example-name>/init-scripts/00_create_authenticator.sh`)
3. Init script runs Sqitch migrations to deploy core schema (`postgres/migrations/`)
4. Example-specific scripts run (pothole tables, permissions, etc.)

**Important**: Schema changes should be made via migrations (see Database Migrations section below). To apply new migrations, recreate the database (`docker-compose down -v && docker-compose up -d`) or run migrations manually via the migrations container.

**PostgREST + Keycloak JWK**: After a fresh `docker-compose up -d`, PostgREST will fail to verify JWTs until Keycloak's signing key is fetched. Run `./fetch-keycloak-jwk.sh` from the example directory (e.g., `examples/staff-portal/`) once Keycloak is ready. The script fetches the JWKS, saves it to `jwt-secret.jwks`, and restarts PostgREST automatically. This is required after every `docker-compose down -v` since Keycloak regenerates keys on fresh startup.

**PostGIS**: Installed in dedicated `postgis` schema (not `public`) to keep the public schema clean. Functions accessible via `search_path`. Use schema-qualified references: `postgis.geography(Point, 4326)` and `postgis.ST_AsText()`.

## Database Migrations

Civic OS uses **Sqitch** for versioned database schema migrations in **both development and production**. This ensures dev/prod parity and allows upgrading databases safely as new versions are released.

**Key Concepts:**
- **Core Objects Only**: Migrations manage `metadata.*` schema and core public objects (RPCs, views, domains). User application tables (`public.issues`, `public.tags`, etc.) are not managed by core migrations.
- **Version-Based Naming**: Migrations use `vX-Y-Z-note` format (e.g., `v0-4-0-add_tags_table`) to tie schema changes to releases.
- **Rollback Support**: Every migration has deploy/revert/verify scripts for safe upgrades and rollbacks.
- **Containerized**: Migration container (`ghcr.io/civic-os/migrations`) is versioned alongside frontend/postgrest for guaranteed compatibility.

**Quick Commands:**

```bash
# Generate new migration
./scripts/generate-migration.sh add_feature "Add feature X"

# Test locally
sqitch deploy dev --verify
sqitch revert dev --to @HEAD^  # Rollback
sqitch deploy dev --verify      # Re-deploy

# Deploy to production (using versioned container)
./scripts/migrate-production.sh latest $DATABASE_URL
```

**Important Notes:**
- Migrations are **automatically tested** in CI/CD on every push
- Migration container **version must match** frontend/postgrest versions
- Generated migrations require **manual enhancement** (add metadata insertions, grants, RLS policies)
- See `postgres/migrations/README.md` for comprehensive documentation

**When to Create Migrations:**
- Adding/modifying `metadata.*` tables
- Adding/updating public RPCs or views
- Adding custom domains
- Schema changes that affect UI generation

## Production Deployment & Containerization

Civic OS provides production-ready Docker containers (frontend, postgrest, migrations) with runtime configuration via environment variables. Containers are versioned and multi-architecture (amd64, arm64), automatically built and published to GitHub Container Registry.

**Runtime Configuration**: Use semantic helper functions (`getPostgrestUrl()`, `getKeycloakConfig()`, etc.) from `src/app/config/runtime.ts`. **CRITICAL**: Never import `environment.postgrestUrl` directly - helpers enable runtime configuration in production.

See `docs/deployment/PRODUCTION.md` for complete deployment guide, `docker/README.md` for container documentation, and `docker-compose.prod.yml` for deployment example. For single-VPS deployments (DigitalOcean, etc.), see `infrastructure/vps/README.md` for Caddy + docker-rollout setup with zero-downtime updates.

## PostgREST Integration

All API calls use PostgREST conventions:
- **Select fields**: `?select=id,name,created_at`
- **Embedded resources**: `?select=id,author:users(display_name)`
- **Filters**: `?id=eq.5`
- **Ordering**: `?order=created_at.desc`

The `SchemaService.propertyToSelectString()` method builds PostgREST-compatible select strings for foreign keys and user references.

**API Testing with JWT Generation**: Generate JWTs from the example `.env` secret to test RLS policies, permissions, and multi-tenant scenarios. See `docs/development/TESTING.md` (PostgREST API Testing section) for workflow.

## Built-in PostgreSQL Functions

Civic OS provides helper functions for JWT data extraction (`current_user_id()`, `current_user_email()`), RBAC checks (`has_permission()`, `is_admin()`), programmatic metadata configuration (`upsert_entity_metadata()`, `set_role_permission()`), and causal binding registration (`add_status_transition()`, `add_property_change_trigger()`). See `docs/INTEGRATOR_GUIDE.md` for complete function reference with parameters and examples.

## Authentication & RBAC

**Keycloak Authentication**: See `docs/AUTHENTICATION.md` for complete setup instructions.

**Quick Reference** (default local instance):
- Keycloak URL: `http://localhost:8082`
- Realm: `civic-os-dev`
- Client ID: `civic-os-dev-client`
- Admin Console: http://localhost:8082 (admin/admin)
- Realm config: `examples/keycloak/civic-os-dev.json` (auto-imported on startup)
- Test users: `testuser`, `testeditor`, `testmanager`, `testadmin` (password = username)

All example docker-compose files include a pre-configured Keycloak service. The shared instance at `auth.civic-os.org` is available as an alternative (see `docs/AUTHENTICATION.md`).

**RBAC System**: Permissions are stored in database (`metadata.roles`, `metadata.permissions`, `metadata.permission_roles`). PostgreSQL functions (`get_user_roles()`, `has_permission()`, `is_admin()`) extract roles from JWT claims and enforce permissions via Row Level Security policies.

**Default Roles**: `anonymous` (unauthenticated), `user` (authenticated), `editor` (create/edit), `manager` (manage records), `admin` (full access + permissions UI)

**Admin Features** (require `admin` role):
- **Permissions Page** (`/permissions`) - Manage role-based table permissions, entity action permissions, and role delegation (v0.31.0+)
- **User Management Page** (`/admin/users`) - Create, edit, and manage user accounts with async Keycloak provisioning, inline role assignment/revocation, and bulk import from Excel with partial success handling (v0.31.0+). See `docs/INTEGRATOR_GUIDE.md` (User Provisioning section) for details.
- **Entities Page** (`/entity-management`) - Customize entity display names, descriptions, menu order
- **Properties Page** (`/property-management`) - Configure column labels, descriptions, sorting, width, visibility
- **Schema Editor** (`/schema-editor`) - Visual ERD with auto-layout, relationship inspection, and geometric port ordering
- **Role Impersonation** (Settings modal) - Test RLS policies as different roles without logging out. Admins only.

**Role Delegation** (v0.31.0+): Admin-configurable matrix controlling which roles can assign/revoke which other roles. Configured via "Role Delegation" tab on Permissions page. Uses `metadata.role_can_manage` table. The `anonymous` role is excluded from delegation (framework-only permission role). See `docs/INTEGRATOR_GUIDE.md` (Role Delegation section) for details.

**Admin Page Architecture**: Admin pages (User Management, Permissions, Entity/Property Management) use **read-only VIEWs** for data retrieval and **RPCs** for mutations. System views like `managed_users` are excluded from `schema_entities` via its WHERE clause so they don't appear in the sidebar or Schema Editor ERD. This pattern avoids the complexity of INSTEAD OF triggers while keeping PostgREST's native filtering/pagination for reads.

**Keycloak Service Account** (v0.31.0+): The consolidated worker uses a `civic-os-service-account` client (client credentials flow) for Keycloak API access. This enables user provisioning (creating Keycloak users) and role sync (creating/deleting realm roles). See `docs/AUTHENTICATION.md` (Step 8) for setup.

**Troubleshooting RBAC**: See `docs/TROUBLESHOOTING.md` for debugging JWT roles and permissions issues.

## Common Patterns

### Adding a New Entity to the UI
1. Create table in PostgreSQL `public` schema
2. Grant permissions to database roles:
   - **Public tables**: Grant SELECT to `web_anon` (anonymous) and all CRUD permissions to `authenticated`
   - **Sensitive tables** (payments, private data): Grant only to `authenticated`, withhold from `web_anon`

   When `web_anon` has no privileges, anonymous users see a "Sign in to view this record" prompt instead of the data.
3. **IMPORTANT: Create indexes on all foreign key columns** (PostgreSQL does NOT auto-index FKs). See `docs/INTEGRATOR_GUIDE.md` for index examples.
4. Navigate to `/view/your_table_name` - UI auto-generates
5. (Optional) Add entries to `metadata.entities` and `metadata.properties` for custom display names, ordering, etc.

**Why FK indexes matter:** The inverse relationships feature (showing related records on Detail pages) requires indexes on foreign key columns to avoid full table scans. Without these indexes, queries like `SELECT * FROM issues WHERE status_id = 1` will be slow on large tables.

### Custom Property Display

Override property metadata in `metadata.properties` to customize UI: `display_name`, `sort_order`, `column_width` (1=half, 2=full), `sortable`, `filterable`, `show_on_list/create/edit/detail`. Use Properties Management page (`/property-management`) or SQL. See `docs/INTEGRATOR_GUIDE.md` for examples.

### Handling New Property Types
1. Add new type to `EntityPropertyType` enum
2. Update `SchemaService.getPropertyType()` to detect the type
3. Add rendering logic to `DisplayPropertyComponent`
4. Add input control to `EditPropertyComponent`

### Metadata Tables Reference

Configure Civic OS behavior via metadata tables:
- **`metadata.entities`** / **`metadata.properties`** - Entity/property display settings (use Entity/Property Management pages or SQL)
- **`metadata.validations`** / **`metadata.constraint_messages`** - Validation rules and friendly error messages
- **`metadata.roles`** / **`metadata.permissions`** - RBAC configuration (use Permissions page or SQL)
- **`metadata.dashboards`** / **`metadata.dashboard_widgets`** - Dashboard configuration (Preview, SQL only)
- **`metadata.status_transitions`** - Allowed status transitions with optional RPC binding (v0.33.0+)
- **`metadata.property_change_triggers`** - Property-level event-to-function bindings (v0.33.0+)

See `docs/INTEGRATOR_GUIDE.md` for complete metadata architecture, field descriptions, and configuration patterns.

### Creating Records with Pre-filled Fields (Query Param Pattern)

CreatePage supports pre-filling form fields via query parameters (e.g., `/create/appointments?resource_id=5`). Use `DetailPage.navigateToCreateRelated()` to link from Detail pages. Query params are applied after form build, only to empty fields. See `CreatePage.applyQueryParamDefaults()` for implementation.

### Form Validation

Civic OS provides **dual enforcement** validation: frontend validation via `metadata.validations` for UX and backend CHECK constraints for security. Supported types: `required`, `min`, `max`, `minLength`, `maxLength`, `pattern`. The `SchemaService.getFormValidatorsForProperty()` maps rules to Angular validators, and `ErrorService.parseToHuman()` translates CHECK constraint errors to friendly messages.

See `docs/INTEGRATOR_GUIDE.md` (Validation System section) for SQL examples and patterns, and `examples/pothole/init-scripts/02_validation_examples.sql` for complete examples. Future async/RPC validators: `docs/development/ADVANCED_VALIDATION.md`.

### Notification System

**Version**: v0.11.0+

Send multi-channel notifications (email, SMS) to users using database-managed templates with Go template syntax and a River-based Go microservice. Features include: template management UI at `/notifications/templates`, real-time validation, HTML preview, polymorphic entity references, and automatic retries with exponential backoff.

See `docs/INTEGRATOR_GUIDE.md` (Notification System section) for Quick Start SQL examples and template patterns, `docs/development/NOTIFICATIONS.md` for complete architecture and AWS SES setup, and `examples/pothole/init-scripts/08_notification_templates.sql` for working examples.

### Visual Diagramming with JointJS

**Reference Implementation**: Schema Editor (`/schema-editor`)

The Schema Editor demonstrates best practices for integrating JointJS (MIT-licensed diagramming library) into Angular applications. Key patterns include: JointJS initialization, geometric port ordering, batching for routing stability, Metro router configuration, auto-layout integration, and theme integration. Use this pattern when building visual editors, workflow designers, or any feature requiring draggable, connectable visual elements.

See `docs/development/JOINTJS_INTEGRATION.md` for complete integration guide, `docs/notes/SCHEMA_EDITOR_DESIGN.md` for design details, and `docs/notes/JOINTJS_TROUBLESHOOTING_LESSONS.md` for debugging tips

## Angular 20 Critical Patterns

### Signals for Reactive State

**IMPORTANT**: Use Signals for reactive component state to ensure proper change detection with zoneless architecture and new control flow syntax (`@if`, `@for`).

```typescript
import { Component, signal } from '@angular/core';

export class MyComponent {
  data = signal<MyData | undefined>(undefined);
  loading = signal(true);
  error = signal<string | undefined>(undefined);

  loadData() {
    this.dataService.fetch().subscribe({
      next: (result) => {
        this.data.set(result);
        this.loading.set(false);
      },
      error: (err) => this.error.set(err.message)
    });
  }
}
```

**Template**: Access signal values with `()` syntax: `@if (loading()) { <span class="loading"></span> }`

### OnPush + Async Pipe Pattern

**CRITICAL**: All components should use `OnPush` change detection with the `async` pipe. Do NOT manually subscribe to observables in components with `OnPush` - this causes change detection issues.

```typescript
@Component({
  selector: 'app-my-page',
  changeDetection: ChangeDetectionStrategy.OnPush,  // Required
  // ...
})
export class MyPageComponent {
  // Expose Observable with $ suffix
  data$: Observable<MyData> = this.dataService.getData();
}
```

**Template**: Use async pipe: `@if (data$ | async; as data) { <div>{{ data.name }}</div> }`

**Why**: OnPush change detection only runs when: (1) Input properties change, (2) Events fire from template, (3) The `async` pipe receives new values. Manual subscriptions don't trigger OnPush.

**Reference implementations**:
- `PermissionsPage`, `EntityManagementPage` - Signal-based state
- `SchemaErdPage`, `ListPage`, `DetailPage` - OnPush + async pipe

## Styling

- **Tailwind CSS** for utility classes
- **DaisyUI 5** component library (themes: light, dark, corporate, nord, emerald)
- Global styles in `src/styles.css`

**IMPORTANT: This project uses DaisyUI 5, not DaisyUI 4.** Many class names changed between versions. See `docs/development/ANGULAR.md` (DaisyUI 5 Migration section) for the full v4→v5 mapping table. Always verify class names against the [DaisyUI 5 documentation](https://daisyui.com/components/).

## TypeScript Configuration

- Strict mode enabled
- `experimentalDecorators: true` for Angular decorators
- Target: ES2022
- Module resolution: bundler

## Documentation Conventions

When creating new documentation files, follow this structure:

**Root Level (reserved):**
- `README.md` - Project overview and quick start guide
- `CLAUDE.md` - AI assistant instructions (this file)
- `LICENSE` - License file

**Documentation Structure:**
- `docs/` - User-facing documentation (setup guides, troubleshooting)
  - `AUTHENTICATION.md` - Authentication and Keycloak setup
  - `TROUBLESHOOTING.md` - Common issues and solutions
  - `ROADMAP.md` - Feature roadmap and planning
- `docs/development/` - Developer-specific guides
  - `ANGULAR.md` - Angular coding standards and patterns
  - `TESTING.md` - Testing guidelines and best practices
- `docs/notes/` - Historical notes, bug documentation, research
  - `DRAG_DROP_BUG_FIX.md` - Bug fix documentation example
  - `FILE_STORAGE_OPTIONS.md` - Research document example

**When to create new documentation:**
- User guides → `docs/`
- Developer guides → `docs/development/`
- Bug postmortems, research notes → `docs/notes/`
- **Never** create markdown files in the root directory (except README.md and CLAUDE.md)

## Git Commit Guidelines

- **ALWAYS run `npm run test:headless` before staging/committing** - failing tests break CI/CD
- Use concise summary-style commit messages that describe the overall change
- Avoid bulleted lists of individual changes - summarize the purpose instead
- Keep commit messages clean and professional
- NEVER include promotional content or advertisements
- NEVER include attribution like "Generated with Claude Code" or "Co-Authored-By: Claude"
- Focus on the technical changes and their purpose
- **Copyright years**: Update `Copyright (C) 2023-YYYY` to the current year in files you substantively modify. Do not do bulk sweeps across untouched files.
