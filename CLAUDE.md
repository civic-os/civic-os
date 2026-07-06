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

**SchemaService** (`src/app/services/schema.service.ts`) - Fetches and caches entity and property metadata, determines property types from PostgreSQL data types (e.g., `int4` with `join_column` → `ForeignKeyName`), filters properties for different contexts (list, detail, create, edit), with deduplication to prevent redundant HTTP requests. See `docs/development/SCHEMA_SERVICE_ARCHITECTURE.md` for implementation details

**DataService** (`src/app/services/data.service.ts`) - Abstracts PostgREST API calls, builds query strings with select fields, ordering, and filters

**AuthService** (`src/app/services/auth.service.ts`) - Integrates with Keycloak for authentication via `keycloak-angular` library

### Property Type System

The `EntityPropertyType` enum maps PostgreSQL types to UI components:
- `ForeignKeyName`: Integer/UUID with `join_column` → Dropdown with related entity's display_name. Supports cascading dropdowns, search modals with state persistence, and server-side filtering. See `docs/INTEGRATOR_GUIDE.md` (FK sections) and `docs/notes/OPTIONS_SOURCE_RPC_DESIGN.md`.
- `User`: UUID with `join_table = 'civic_os_users'` → User display component with FK search modal. See `docs/development/PROPERTY_TYPE_REFERENCE.md` for architecture details.
- `Payment`: UUID FK to `payments.transactions` → Payment status badge display, "Pay Now" button on detail pages (v0.13.0+)
- `DateTime`, `DateTimeLocal`, `Date`: Timestamp types → Date/time inputs
- `Boolean`: `bool` → Checkbox
- `Money`: `money` → Currency input (ngx-currency)
- `IntegerNumber`: `int4`/`int8` → Number input
- `TextShort`: `varchar` → Text input
- `TextLong`: `text` → Textarea
- `GeoPoint`: `geography(Point, 4326)` → Interactive map (Leaflet) with location picker
- `GeoPolygon`: `geography(Polygon, 4326)` → Interactive polygon map (Leaflet + leaflet-geoman-free) with draw/edit/delete
- `Color`: `hex_color` → Color chip display with native HTML5 color picker
- `Email`: `email_address` → Clickable mailto: link, HTML5 email input
- `Telephone`: `phone_number` → Clickable tel: link with formatted display, masked input (XXX) XXX-XXXX
- `TimeSlot`: `time_slot` (tstzrange) → Formatted date range display, dual datetime-local inputs with validation, optional calendar visualization

**Calendar Integration** (v0.9.0+): Enable via `show_calendar=true` and `calendar_property_name` in `metadata.entities`. Supports overlap prevention via GIST exclusion constraints. See `docs/development/CALENDAR_INTEGRATION.md` for details and `examples/community-center/` for working example.

**iCal Subscription Feeds** (v0.27.0+): Export calendar events as subscribable iCal feeds via PostgREST media type handlers. See `docs/INTEGRATOR_GUIDE.md` (iCal Calendar Feeds section) for implementation guide.

**Status Type** (`Status`, v0.15.0+): Centralized workflow system using `metadata.statuses` table with `entity_type` discriminator. Features colored badges/dropdowns, `is_initial`/`is_terminal` states, allowed transitions (v0.33.0+), and `status_key` for programmatic references. See `docs/INTEGRATOR_GUIDE.md` (Status Type System section) and `docs/development/STATUS_TYPE_SYSTEM.md` for design.

**Category** (`Category`, v0.34.0+): Simple enum categorization using `metadata.categories` table with `entity_type` discriminator. No workflow semantics (unlike Status). Use for name/color/sort_order values; use a custom lookup table if categories need extended properties. See `docs/INTEGRATOR_GUIDE.md` (Category System section) and `examples/staff-portal/`.

**Entity Notes** (v0.16.0+): Polymorphic notes system any entity can opt into. Features permission-isolated notes (`{entity}:notes:read/create`), system notes for audit trails, Markdown formatting, and export support. Enable via `SELECT enable_entity_notes('entity_type')`. See `docs/INTEGRATOR_GUIDE.md` (Entity Notes System section) for complete guide.

**Static Text Blocks** (v0.17.0+): Display-only markdown content blocks interspersed with properties on Detail, Create, and Edit pages. See `docs/INTEGRATOR_GUIDE.md` (Static Text Blocks section) for usage guide.

**Video Embeds** (v0.50.0+): `@[video](url)` markdown syntax for embedding YouTube videos within Static Text Blocks and notes. Uses DOMPurify sanitization with `privacy-enhanced` nocookie domain for GDPR compliance. Supported in all markdown rendering contexts (Static Text, Entity Notes, Dashboard Markdown widgets).

**Entity Action Buttons** (v0.18.0+): Metadata-driven action buttons on Detail pages that execute PostgreSQL RPC functions. Supports action parameters, filtered FK param dropdowns, photo gallery params, and dot-notation visibility/enabled conditions. **Maintenance note**: When adding a new `EntityPropertyType`, check if it should also be added as an action param type. See `docs/INTEGRATOR_GUIDE.md` (Entity Action Buttons section) and `docs/development/ENTITY_ACTIONS.md` for details.

**Recurring Time Slots** (v0.19.0+): RFC 5545 RRULE-compliant recurring schedules. Enable via `supports_recurring=true` in `metadata.entities`. See `docs/notes/RECURRING_TIMESLOT_DESIGN.md` for architecture.

**Virtual Entities** (v0.28.0+): PostgreSQL VIEWs with INSTEAD OF triggers behave like regular CRUD entities. See `docs/INTEGRATOR_GUIDE.md` (Virtual Entities section) for requirements and examples.

**System Introspection** (v0.23.0+): Auto-generated documentation for RPCs, triggers, and notification workflows. Register functions via `metadata.auto_register_function()`. See `docs/INTEGRATOR_GUIDE.md` (System Introspection section).

**Source Code Block Visualization** (v0.29.0+): Read-only Blockly-based visualization of PL/pgSQL functions and SQL views. Pages: Entity Code (`/system/entity-code/:tableName`), System Functions (`/system/functions`), System Policies (`/system/policies`). See `docs/notes/CODE_BLOCK_SYSTEM_DESIGN.md` for architecture and AST node mapping reference.

**Schema Decisions (ADR)** (v0.30.0+): Database-native architectural decision records via `metadata.schema_decisions` table. **Every schema change should include a `create_schema_decision()` call documenting the rationale.** Before modifying any entity's schema, **query existing decisions first**. See `docs/INTEGRATOR_GUIDE.md` (Schema Decisions section) for complete guide.

**File Storage Types** (`FileImage`, `FilePDF`, `File`): S3-based file storage with automatic thumbnail generation via consolidated worker. **File Administration** (v0.39.0+): Admin page at `/admin/files` for browsing all files. See `docs/development/FILE_STORAGE.md` for implementation guide and `docs/notes/ADMIN_PAGE_PITFALLS.md` for architecture patterns.

**PhotoGallery** (`PhotoGallery`, v0.47.0+): Multi-image gallery as a column-level property type with drag-drop reorder, lightbox viewing, and per-column constraints via `metadata.photo_gallery_config`. **Gallery Administration** (v0.47.0+): Admin page at `/admin/galleries`. See `docs/notes/PHOTO_GALLERY_DESIGN.md` for architecture and `docs/INTEGRATOR_GUIDE.md` (PhotoGallery section) for setup.

**Guided Forms** (v0.48.0+): Multi-step form workflows with conditional skip/require, auto-save, review-and-submit, and lock-on-submit. Configure via `guided_form_key` on `metadata.entities` with steps in `metadata.guided_form_steps`. **Dual-Status Pattern** (v0.55.2+): Separate framework lifecycle column and business workflow column. See `docs/notes/GUIDED_FORM_SYSTEM_DESIGN.md` for architecture and `docs/INTEGRATOR_GUIDE.md` (Guided Forms section) for setup.

**Payment Type** (`Payment`, v0.13.0+): Stripe-based payment processing via UUID FK to `payments.transactions`. Enable on any entity via `payment_initiation_rpc` in `metadata.entities`. Frontend auto-displays payment badges on List pages and "Pay Now" button on Detail pages. See `docs/INTEGRATOR_GUIDE.md` (Payment System section) for complete workflow and `examples/community-center/` for working example.

**Consolidated Worker Architecture**: File storage, thumbnail generation, payment processing, and notification features run in a single Go + River microservice with at-least-once delivery, automatic retries, and zero additional infrastructure beyond PostgreSQL. See `docs/development/GO_MICROSERVICES_GUIDE.md` for complete architecture and `docs/development/FILE_STORAGE.md` for usage guide

**Geography (GeoPoint / GeoPolygon) Types**: Require a paired `<column_name>_text` computed field returning `ST_AsText()`. Maps auto-switch light/dark tiles based on DaisyUI theme. GeoPolygon (v0.49.0+) adds interactive polygon drawing and multi-polygon display. See `docs/development/PROPERTY_TYPE_REFERENCE.md` for computed field pattern and `docs/notes/GEO_POLYGON_DESIGN.md` for polygon architecture.

**DateTime vs DateTimeLocal - Timezone Handling**: `DateTime` (`timestamp`) stores wall-clock time with no conversion; `DateTimeLocal` (`timestamptz`) converts between user's local timezone and UTC. **CRITICAL**: The transformation logic in `EditPage.transformValueForControl()`, `EditPage.transformValuesForApi()`, and `CreatePage.transformValuesForApi()` handles these conversions — modifying this code can cause data integrity issues. See `docs/development/DATETIME_HANDLING.md` for details.

**Many-to-Many Relationships**: Auto-detected from junction tables. **CRITICAL**: Junction tables MUST use composite primary keys (NOT surrogate IDs). Supports filtered options (`options_source_rpc`, v0.44.0), search modals (`fk_search_modal`, v0.45.0+), inline positioning (`show_inline`, v0.46.0), and rich junctions with extra columns (v0.51.0+). See `docs/notes/MANY_TO_MANY_DESIGN.md` for implementation details and `docs/INTEGRATOR_GUIDE.md` (M:M sections) for configuration.

**Full-Text Search + Substring Search** (v0.55.2+): Dual search modes via `fulltext_search_column` (tsvector FTS) and `substring_search_column` (ILIKE trigram). Both can be combined for hybrid search. See `docs/INTEGRATOR_GUIDE.md` (Full-Text Search section) and `docs/notes/HYBRID_SEARCH_DESIGN.md` for architecture.

**Phone Search Tokens** (v0.50.1): `phone_search_tokens(phone_number)` pre-computes searchable phone fragments for GIN-indexed tsvector lookup. The `civic_os_users` VIEW uses this automatically. See `docs/INTEGRATOR_GUIDE.md` (Full-Text Search > Phone Number Search section).

**Excel Import/Export**: Bulk data operations on List pages with FK name resolution and validation. **Custom Import Mode** (v0.31.0+) for non-entity imports. **M:M Import** (v0.60.0): Pure junction M:M properties import via comma-separated values with two-phase insert (main rows first, then junction records). Rich junctions and parent-hop M:M excluded. See `docs/development/IMPORT_EXPORT.md` and `docs/INTEGRATOR_GUIDE.md` for specification.

**Multi-Language (i18n)** (v0.57.0+): Framework UI strings and instance metadata render in the user's preferred language, with RTL layout support (v0.64.0). **Admin Translation Management** (v0.62.0+): Page at `/admin/translations` for browsing/editing translations with coverage reports. See `docs/notes/I18N_DESIGN.md` for architecture and `docs/INTEGRATOR_GUIDE.md` (Multi-Language section) for setup.

**User Profile Extensions** (v0.65.0+): Metadata-driven system for registering tables as user profile extensions via `metadata.user_profile_extensions`. Self-service "My Profile" page (`/profile`) with collapsible sections for core info, notification prefs, and extension data. Profile completion guard blocks navigation when required extensions are missing. Admin integration shows extension status in User Management edit modal. See `docs/notes/USER_PROFILE_EXTENSION_DESIGN.md` for architecture and `docs/INTEGRATOR_GUIDE.md` (User Profile Extensions section) for setup.

## Custom Dashboards

**Status**: Phase 2 complete, plus calendar widgets and chart widgets (grouped bar, v0.61.0)

The home page (`/`) displays configurable dashboards with extensible widget types. Dashboard selector in navbar switches between available dashboards.

**Current**: ✅ View dashboards ✅ Markdown widgets ✅ Filtered list widgets ✅ Map widgets with clustering ✅ Calendar widgets ✅ Chart widgets (grouped bar, v0.61.0) ❌ Management UI ❌ Auto-refresh

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

**Functional tests** (`tests/functional/`): Bash scripts that test migrations, RLS policies, and PostgREST integration against a live database. Key rules: never modify schema in test scripts (use migrations), create dummy files for uploads, and clean up FK references before deleting records. See `docs/notes/ADMIN_PAGE_PITFALLS.md` (Functional Testing section).

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

Civic OS uses **Sqitch** for versioned database schema migrations in both development and production, ensuring dev/prod parity. Migrations use `vX-Y-Z-note` naming and include deploy/revert/verify scripts.

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

Generated migrations require **manual enhancement** (metadata inserts, grants, RLS policies). See `postgres/migrations/README.md` for comprehensive documentation.

**Future Direction**: Declarative schema management deferred to v1.0 milestone. See `docs/notes/DECLARATIVE_SCHEMA_MANAGEMENT.md`.

## Production Deployment & Containerization

Civic OS provides production-ready Docker containers (frontend, postgrest, migrations) with runtime configuration via environment variables. Containers are versioned and multi-architecture (amd64, arm64), automatically built and published to GitHub Container Registry.

**Runtime Configuration**: Use semantic helper functions (`getPostgrestUrl()`, `getKeycloakConfig()`, etc.) from `src/app/config/runtime.ts`. **CRITICAL**: Never import `environment.postgrestUrl` directly - helpers enable runtime configuration in production.

See `docs/deployment/PRODUCTION.md` for complete deployment guide, `docker/README.md` for container documentation, and `docker-compose.prod.yml` for deployment example. For single-VPS deployments (DigitalOcean, etc.), see `infrastructure/vps/README.md` for Caddy + docker-rollout setup with zero-downtime updates.

**LLM Release Notes**: GitHub Releases are generated by Claude Sonnet 5 via AWS Bedrock (OIDC federation, zero stored secrets). The workflow collects doc diffs, migration SQL, source diffs, and commit subjects as context. Falls back to commit-list format if AWS is unconfigured. See `docs/development/RELEASE_NOTES_AWS_SETUP.md` for IAM setup.

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

**Permissions Model** (v0.48.0+): Three-layer access control (database GRANTs → RBAC → RLS ownership). Sidebar visibility is controlled by `show_in_sidebar`, not `read` permission. Frontend does NOT gate data rendering on `entity.select` — RLS alone controls row visibility. See `docs/development/PERMISSIONS_MODEL.md` for complete architecture and anti-patterns.

**RBAC System**: Permissions are stored in database (`metadata.roles`, `metadata.permissions`, `metadata.permission_roles`). Each role has an immutable `role_key` (programmatic identifier for JWT matching and SQL lookups) and a freely-editable `display_name` (human label). Use `get_role_id(role_key)` helper for lookups. PostgreSQL functions (`get_user_roles()`, `has_permission()`, `is_admin()`) extract roles from JWT claims and enforce permissions via Row Level Security policies.

**Default Roles** (by `role_key`): `anonymous` (unauthenticated), `user` (authenticated), `editor` (create/edit), `manager` (manage records), `admin` (full access + permissions UI)

**Admin Features** (require `admin` role):
- **Permissions Page** (`/permissions`) - Manage role-based table permissions, entity action permissions, and role delegation (v0.31.0+)
- **User Management Page** (`/admin/users`) - Create, edit, manage users with Keycloak provisioning, role assignment, and bulk import (v0.31.0+). See `docs/INTEGRATOR_GUIDE.md` (User Provisioning section) for details.
- **Entities Page** (`/entity-management`) - Customize entity display names, descriptions, menu order
- **Properties Page** (`/property-management`) - Configure column labels, descriptions, sorting, width, visibility
- **Schema Editor** (`/schema-editor`) - Visual ERD with auto-layout, relationship inspection, and geometric port ordering
- **File Administration** (`/admin/files`) - Browse all uploaded files with All Files (inline filters) and Entity Files (two-phase query) modes. Requires `files:read` permission. (v0.39.0+)
- **Status Administration** (`/admin/statuses`) - Manage status types, status values (color, sort order, initial/terminal flags), and allowed transitions. Permission-gated via `metadata.statuses` CRUD permissions. (v0.40.0+)
- **Category Administration** (`/admin/categories`) - Manage category groups and category values (color, sort order). Permission-gated via `metadata.categories` CRUD permissions. (v0.40.0+)
- **Gallery Administration** (`/admin/galleries`) - Browse all photo galleries with filters (entity type, linked/draft status), stats (total galleries, images, storage), and entity navigation. Admin-only. (v0.47.0+)
- **Translation Administration** (`/admin/translations`) - Browse, edit, and create translations with locale/source-type filters, search, missing-translation coverage reports, and live preview after save. Visible when `supportedLocales` has 2+ entries. Admin-only. (v0.62.0+)
- **Role Impersonation** (Settings modal) - Test RLS policies as different roles without logging out. Admins only. `refresh_current_user()` is excluded from impersonation to prevent role sync poisoning (v0.41.2 fix). See `docs/AUTHENTICATION.md` (Role Impersonation section).

**Role Delegation** (v0.31.0+): Admin-configurable matrix controlling which roles can assign/revoke which other roles. Configured via "Role Delegation" tab on Permissions page. Uses `metadata.role_can_manage` table. The `anonymous` role is excluded from delegation (framework-only permission role). See `docs/INTEGRATOR_GUIDE.md` (Role Delegation section) for details.

**Admin Page Architecture**: Admin pages use read-only VIEWs + RPCs (not INSTEAD OF triggers). **Before building a new admin page**, read `docs/notes/ADMIN_PAGE_PITFALLS.md` for common mistakes.

**Keycloak Service Account** (v0.31.0+): The consolidated worker uses a `civic-os-service-account` client (client credentials flow) for Keycloak API access. This enables user provisioning (creating Keycloak users) and role sync (creating/deleting realm roles). See `docs/AUTHENTICATION.md` (Step 8) for setup.

**Troubleshooting RBAC**: See `docs/TROUBLESHOOTING.md` for debugging JWT roles and permissions issues.

## Common Patterns

### Instance Design Checklists

Two checklists for reviewing new instance designs, derived from NEH post-design corrections. Use `/design-review` skill to scan a design doc against both checklists automatically.

- `docs/INSTANCE_DESIGN_UX_CHECKLIST.md` — Interface/flow concerns (workflows, field visibility, dropdowns, entity groups)
- `docs/INSTANCE_DESIGN_SCHEMA_CHECKLIST.md` — Schema/SQL concerns (entity architecture, column design, triggers, scaling, permissions)

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
5. **Update Schema Assistant prompts**: If the new type should be available to LLM-generated schemas, add it to `tools/schema-assistant/prompts/system.md` (Custom Domains / type list) and update few-shot examples if relevant

### Metadata Tables Reference

Configure Civic OS behavior via metadata tables:
- **`metadata.entities`** / **`metadata.properties`** - Entity/property display settings (use Entity/Property Management pages or SQL)
- **`metadata.validations`** / **`metadata.constraint_messages`** - Validation rules and friendly error messages
- **`metadata.roles`** / **`metadata.permissions`** - RBAC configuration (use Permissions page or SQL)
- **`metadata.dashboards`** / **`metadata.dashboard_widgets`** - Dashboard configuration (Preview, SQL only)
- **`metadata.status_transitions`** - Allowed status transitions with optional RPC binding (v0.33.0+)
- **`metadata.property_change_triggers`** - Property-level event-to-function bindings (v0.33.0+)

See `docs/INTEGRATOR_GUIDE.md` for complete metadata architecture, field descriptions, and configuration patterns.

**LLM Schema Assistant**: CLI tool that generates Civic OS schema SQL from natural language using LLM providers (Anthropic, OpenAI, OpenRouter). Includes safety validator (whitelist/blacklist/review-tier), context assembly from PostgREST schema state, and cost tracking. See `docs/notes/LLM_SCHEMA_ASSISTANT_DESIGN.md` for full architecture and `tools/schema-assistant/` for implementation. **Maintenance note**: When modifying metadata table structures, the Integrator Guide, or adding new property types, the Schema Assistant's system prompt (`tools/schema-assistant/prompts/system.md`) and few-shot examples (`tools/schema-assistant/prompts/examples/`) must be updated to match.

**Deterministic Schema SDK** (planned): Research found 65% of schema operations (32/49) are fully parameterizable — structured inputs produce guaranteed-correct SQL without LLM involvement. The Migration-First SDK will generate complete deploy/revert SQL migration scripts from TypeScript, shifting the LLM's role from SQL generator to parameter extractor. See `docs/notes/DETERMINISTIC_SCHEMA_SDK_DESIGN.md` for architecture and phased plan.

### Creating Records with Pre-filled Fields (Query Param Pattern)

CreatePage supports pre-filling form fields via query parameters (e.g., `/create/appointments?resource_id=5`). Use `DetailPage.navigateToCreateRelated()` to link from Detail pages. Query params are applied after form build, only to empty fields. See `CreatePage.applyQueryParamDefaults()` for implementation.

### Form Validation

Civic OS provides **dual enforcement** validation: frontend via `metadata.validations` for UX and backend CHECK constraints for security. `SchemaService.getFormValidatorsForProperty()` maps rules to Angular validators; `ErrorService.parseToHuman()` translates constraint errors to friendly messages. See `docs/INTEGRATOR_GUIDE.md` (Validation System section) for supported types and SQL patterns. Future: `docs/development/ADVANCED_VALIDATION.md`.

### Notification System

**Notification System** (v0.11.0+ email, v0.35.0+ SMS): Multi-channel notifications via database templates and River-based Go worker. See `docs/development/NOTIFICATIONS.md` for architecture and `docs/INTEGRATOR_GUIDE.md` (Notification System section) for SQL examples.

### Application Analytics

**Application Analytics** (v0.26.0+): Matomo integration via `AnalyticsService`. HTTP error tracking interceptor, auth events, CRUD operation tracking, and list page view tracking with filter/search context. See `docs/development/ANALYTICS_TRACKING.md` for event conventions and implementation guide.

### Visual Diagramming with JointJS

**Reference Implementation**: Schema Editor (`/schema-editor`). Use this pattern when building visual editors or workflow designers. See `docs/development/JOINTJS_INTEGRATION.md` for integration guide and `docs/notes/SCHEMA_EDITOR_DESIGN.md` for design details.

## Angular 20 Critical Patterns

**IMPORTANT**: Use Signals for reactive component state and `OnPush` change detection on all components. These ensure proper change detection with zoneless architecture and `@if`/`@for` control flow.

See `docs/development/ANGULAR.md` for code examples, the OnPush + async pipe pattern, and reference implementations.

**Multi-phase data loading**: For pages that load data in stages, use multiple `effect()` instances where each reads signals written by the prior effect. Do NOT chain imperative method calls. See `docs/notes/ADMIN_PAGE_PITFALLS.md` for the pattern.

## Styling

- **Tailwind CSS** for utility classes
- **DaisyUI 5** component library — all 35 built-in themes enabled. Default: `corporate`. Configurable per deployment via `DEFAULT_THEME` Docker env var. Users choose their theme in Settings > Colors.
- Theme constants in `src/app/constants/themes.ts` — recommended list, auto-detection, label helper
- `ThemeService` toggles `theme-light`/`theme-dark` CSS classes on `<html>` for scalable light/dark selectors (used by Prism.js in `src/styles.css`)
- Global styles in `src/styles.css`

**IMPORTANT: This project uses DaisyUI 5, not DaisyUI 4.** Many class names changed between versions. See `docs/development/ANGULAR.md` (DaisyUI 5 Migration section) for the full v4→v5 mapping table. Always verify class names against the [DaisyUI 5 documentation](https://daisyui.com/components/).

**CRITICAL: `not-prose` for sensitive components.** All CRUD pages wrap content in `<div class="prose">`. Tailwind Typography applies styles to bare HTML elements (`img`, `video`, `table`, `hr`, headings, etc.) — any component that dynamically creates these elements (maps, diagrams, rich editors, canvas libraries) **must** add `not-prose` to its outermost wrapper div. Without it, elements like Leaflet tile `<img>` tags get `margin: 2em 0` which causes subtle visual bugs. See `docs/notes/MAP_SHIFT_INVESTIGATION.md` for the full story.

**CRITICAL: Always use CSS logical properties for direction.** Never use physical direction classes (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`). Always use logical equivalents (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`, `text-end`). Same applies in component CSS files (`margin-inline-start` not `margin-left`, etc.). This ensures RTL languages render correctly. See `docs/development/ANGULAR.md` (RTL Support section) for the complete mapping table.

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

**Docs over auto-memory — always.** Auto-memory only lives on one machine and is invisible to contributors. `docs/` files are checked into Git, portable, and permanent. Heavily favor `docs/` for anything of lasting value. Auto-memory is only for quick operational reminders (commands, env quirks).

**Documentation is a feature.** Every feature ships with documentation updates targeting three audiences:
1. **`CLAUDE.md`** — AI-readable index so Claude Code understands the feature in future sessions
2. **`docs/INTEGRATOR_GUIDE.md`** — Human integrators: SQL configuration, examples, behavior
3. **`docs/notes/<FEATURE>_DESIGN.md`** — Future contributors: architecture, decisions, tradeoffs

Keep all three fresh with every feature. Stale docs are worse than no docs.

**i18n is a feature requirement.** Any feature adding user-visible strings must ship with translations. See `docs/notes/I18N_DESIGN.md` (New Feature i18n Checklist) for the required steps.

**⚠️ MANDATORY: Comprehensive E2E Verification**

You **MUST** perform comprehensive end-to-end verification after ALL code changes, before declaring work complete or committing. This is non-negotiable. Do not skip layers. Do not stop after unit tests.

1. **Unit tests** — `npm run test:headless` — all passing
2. **Docker** — `docker compose down -v && docker compose up -d` — migrations apply cleanly, check `docker compose logs postgres`
3. **SQL** — Use MCP postgres tool or `psql` to verify schema changes, VIEWs, RLS policies, and functions
4. **curl** — Verify PostgREST serves correct data: `curl -s http://localhost:3000/entity?limit=1 | jq .`
5. **Browser** — Use Playwright MCP to navigate affected pages, interact with UI, and verify rendering/behavior

Run all 5 layers proactively without being asked. See `docs/development/E2E_VERIFICATION.md` for detailed commands and verification queries.

## Git Commit Guidelines

- **ALWAYS run `npm run test:headless` before staging/committing** - failing tests break CI/CD
- Use concise summary-style commit messages that describe the overall change
- Avoid bulleted lists of individual changes - summarize the purpose instead
- Keep commit messages clean and professional
- NEVER include promotional content or advertisements
- NEVER include attribution like "Generated with Claude Code" or "Co-Authored-By: Claude"
- Focus on the technical changes and their purpose
- **Never commit SQL data dumps** (e.g., `*_dump.sql`, seed data exports) — they bloat the repo and may contain PII. Data stays outside version control.
- **Version tagging**: Before creating a git tag (`git tag vX.Y.Z`), verify that `package.json` `version` matches the tag version. CI will reject tags where the versions don't match. Bump `package.json` and commit before tagging.
- **Copyright years**: Update `Copyright (C) 2023-YYYY` to the current year in files you substantively modify. Do not do bulk sweeps across untouched files.
