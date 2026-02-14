# Civic OS Roadmap

This document outlines the development roadmap for Civic OS, organized by phases as described in the [Civic OS Vision](https://github.com/civic-os/vision).

## Phase 1: Development Tools

### Schema
- [x] Build Entity metadata table
- [x] Build Property metadata table
- [x] Build out User table with public and private fields
- [x] Show related Entities (inverse relationships)
- [x] Allow one-to-many and many-to-many Properties
- [x] Build scheme for editable Properties, default values, etc.
- [x] Add Form Validation Messages
- [x] Allow sorting/layout of Property Views/Lists
- [x] Add User Profile and management (via Keycloak account console)
- [x] Add Login/Logout Screens (uses Keycloak Auth)
- [x] Add File/Image data types (S3-based with thumbnails)
- [x] Live update page as Schema is updated
- [x] Add Color PropertyType
- [ ] Configurable Entity Menu (Nesting, Hiding, Singular/Plural names)
- [ ] **Cascading Dropdowns** - Filter FK dropdown options based on another field's selection (e.g., category → subcategory)

#### List Pages
- [X] Add pagination
- [x] Add text search as an indexed column and toggle-able search box
- [x] Add Map view for List pages
- [x] Add Calendar view for List pages (TimeSlot property type with FullCalendar integration)
- [x] Add Sortable columns and default sort
- [x] Add filter-able columns (mostly FK fields, but also expand to other indexed fields like datetime)
- [x] Add spreadsheet Import/Export capabilities
- [x] Add iCal subscription feeds for calendar apps to subscribe to events (v0.27.0)

### Roles
- [x] Build Roles/Permissions schema
- [ ] Give Roles display name, description
- [x] Allow creation of Roles on the Permissions screen (or a role-specific screen)

### Workflow
- [ ] Build table structure for attaching workflow to Entity (Use Properties table)
- [ ] Build Trigger rules to restrict transitions
- [ ] Create Override Workflow permission
- [ ] Limit UI Selectors based on Workflow
- [ ] Set up Record Defaults (On Create)

### Logic
- [x] **Entity Action Buttons** (v0.18.0) - Metadata-driven action buttons on Detail pages that execute PostgreSQL RPC functions
  - [x] Database schema (`metadata.entity_actions`, `metadata.entity_action_roles` tables) and migration
  - [x] Per-action permission system with role mapping (v0.18.1 refactor, managed via Permissions page)
  - [x] Conditional visibility and disabled state (JSONB expressions evaluated client-side)
  - [x] RPC-driven post-action behavior (messages, navigation, refresh controlled by return value)
  - [x] Frontend integration (ActionBarComponent with overflow, confirmation modals, loading states)
  - [x] Example implementation in community-center (Approve/Deny/Cancel reservation workflow)
  - [ ] User context in visibility/enabled conditions (e.g., `$user.role`, `$user.id` for ownership checks)

- [x] **First-Class Notes System** - Polymorphic notes for any entity (v0.16.0, see `docs/development/ENTITY_NOTES.md`)
  - [x] Database schema (`metadata.entity_notes` table, polymorphic design)
  - [x] `create_entity_note()` RPC for manual and trigger-generated notes
  - [x] Metadata configuration (`enable_notes` on `metadata.entities`)
  - [x] RLS policies (read access follows entity, edit own notes, admin override)
  - [x] Frontend component (notes section on Detail pages, simple formatting)
  - [x] Example trigger for status change notes

- [x] **Recurring Time Slots** (v0.19.0) - RFC 5545 RRULE-based recurring schedules for time-slotted entities
  - [x] Database schema (`time_slot_series_groups`, `time_slot_series`, `time_slot_instances` tables)
  - [x] RRULE validation with DoS prevention (max occurrences, horizon limits)
  - [x] Series management UI (`/admin/recurring-schedules`) for editors/admins
  - [x] Go worker for background instance expansion
  - [x] Edit scope dialogs (this only, this and future, all)
  - [x] Conflict preview before series creation
  - [ ] Calendar integration showing recurring series badges

### Dashboards (Phased Development)
- [x] **Phase 1 - Core Infrastructure**: Database schema, widget registry, markdown widget, static dashboard with navigation
- [x] **Phase 2 - Dynamic Widgets**: Filtered list widget, map widget with clustering, calendar widget, auto-refresh infrastructure
- [ ] **Phase 3 - Management**: Dashboard management UI, widget editor, user preferences, global filter bar
- [ ] **Phase 4 - Polish**: Drag-and-drop reordering, dashboard templates, embedded links, mobile optimizations
- [ ] **Phase 5 - Advanced Widgets**: Stat cards (backend aggregation required), charts (Chart.js), query results from views
- [ ] **Phase 6 - Permissions**: Role-based visibility, widget-level permissions, private dashboards

### General
- [~] **ADA/WCAG Compatibility** - ~60% complete (Phases 1-3 done)
  - [x] Testing infrastructure (pa11y, Lighthouse, BackstopJS)
  - [x] ARIA labels on all icon buttons
  - [x] Skip navigation link
  - [x] Form label associations and validation announcements
  - [x] Table semantics (caption, scope, aria-sort)
  - [x] ARIA live regions for loading/errors
  - [x] Keyboard navigation for table rows
  - [ ] Modal focus management (Angular CDK)
  - [ ] Color contrast fixes (3 issues)
  - [ ] Focus indicators and Phase 4 polish items
  - See `docs/development/ACCESSIBILITY_WCAG.md` for details
- [x] Allow Angular app to be configured at container runtime (for flexible deployments)
- [x] Save selected Theme in localstorage and use on reload
- [x] Allow user profile editing (via Keycloak account console with JWT sync)
- [x] App and Database update deployments
- [x] Automatically assign new users the "user" role
- [ ] Title updates (configure base from Angular Runtime)
- [ ] Application Logging from frontend and pattern for SQL logging
- [x] Application Analytics (external Matomo integration; see Phase 3 for built-in analytics engine)
- [ ] Move api functionality (views, functions, rpcs) into `api` schema that is also accessible via postgrest

## Phase 2: Introspection Tools

### Schema
- [x] Build automatic generation of Entity Relationship Diagrams showing how schema works
- [x] Permit other relationship types (one-to-one, many-to-many)
- [x] **ERD Interactive Features (Complete)** - Schema Editor with JointJS-based visualization
  - [x] Zoom controls (zoom in, zoom out, zoom to fit)
  - [x] Pan with Shift+drag
  - [x] Click to select entities
  - [x] Drag to reposition entities
  - [x] M:M relationship visualization
  - [x] Theme integration (dynamic color updates)
  - [ ] **Next Steps for Phase 3 Schema Editor**:
    - [ ] Add property lists inside entity boxes (currently just display_name)
    - [ ] Show data types and constraints for each property
    - [ ] Add legend for relationship types (FK, M:M, 1:1)
    - [ ] Implement entity grouping/nesting (for modules or related entities)
    - [ ] Add search/filter for large schemas
    - [ ] Save/restore custom layout positions to user preferences
    - [ ] Export diagram as image (PNG/SVG)
    - [ ] Minimap for navigation in large schemas
- [ ] Advanced Form Validation by use of RPCs
- [x] Add Static Text blocks (v0.17.0 - markdown content via `metadata.static_text`, see `docs/design/STATIC_TEXT_FEATURE.md`)
- [ ] Add customizable template pages (primarily for PDF)
- [ ] Research safe database schema editing, sandboxing
- [ ] One-to-One relationship created as child record
  - [ ] Grouped on Detail Page
  - [ ] Grouped on ERD
  - [ ] Multi-step create forms
- [ ] Use postgres Schemas to builder larger, modular apps

### Workflow
- [ ] Build automatic generation of Workflow diagrams showing how workflows operate

### Logic
- [~] **Source Code Block Visualization** (v0.29.0) - Read-only Blockly-based visualization of PL/pgSQL functions and SQL views
  - [x] Go worker parses source code via `libpg_query` and stores AST in `metadata.parsed_source_code`
  - [x] `AstToBlocklyService` maps PL/pgSQL AST nodes to custom Blockly block definitions
  - [x] `BlocklyViewerComponent` lazy-loads Blockly (~150KB gzip) with read-only workspace
  - [x] Custom block definitions (`sql-blocks.ts`) for SQL/PL/pgSQL constructs (SELECT INTO, UPDATE, IF/ELSE, DECLARE, etc.)
  - [x] Theme integration (DaisyUI light/dark with `civic-os-theme.ts`)
  - [x] Entity Code page (`/entity-code/:entity`) showing functions with Source/Blocks toggle
  - [x] System Functions page (`/system-functions`) and System Policies page (`/system-policies`)
  - [ ] **Documentation**: Write `docs/development/CODE_BLOCK_SYSTEM.md` user-facing guide. Design doc at `docs/notes/CODE_BLOCK_SYSTEM_DESIGN.md`
  - [ ] Regex fallback (`SqlBlockTransformerService`) for functions without pre-parsed ASTs
  - [ ] Interactive editing (Phase 3: remove `readOnly: true`, enable visual SQL editing)
- [ ] **Entity Actions Management Page** - Read-only view of all configured entity actions
  - [ ] List all actions grouped by entity
  - [ ] Show action configuration (visibility/enabled conditions, RPC function, button style)
  - [ ] Show role permissions for each action

### Utilities
- [x] Build notification service (v0.11.0 - database templates, River-based worker, email via AWS SES)

- [ ] **Multi-Tenancy** - First-class support for multi-tenant applications
  - [ ] Row-level tenant isolation with `tenant_id` column and automatic RLS
  - [ ] Tenant context detection (subdomain, header, or JWT-based)
  - [ ] Tenant management UI for provisioning and configuration
  - [ ] Schema-per-tenant option for stronger data boundaries

- [ ] **Activity/Audit Log** - Track who changed what and when
  - [ ] Database schema (`metadata.audit_log` table, polymorphic design)
  - [ ] PostgreSQL trigger function for automatic change capture
  - [ ] JSONB diff format (`{"field": {"old": X, "new": Y}}`)
  - [ ] UI component (Activity tab on Detail pages, timeline view)
  - [ ] Filter by user, field, date range
  - [ ] RLS policies (entity-level read permissions)

- [ ] **Due Date / SLA Property Type** - Time-based prioritization
  - [ ] `due_at` property type with DateTimeLocal handling
  - [ ] Overdue highlighting on List pages (visual indicator)
  - [ ] "Overdue Items" dashboard widget
  - [ ] Optional: SLA calculation from entity creation

## Phase 3: Graphical Editing Tools

### Schema
- [ ] **Build GUI editor for Entity Relationship Diagrams** - Extend Phase 2 Schema Editor with editing capabilities
  - [ ] Right-click context menus for entities and relationships
  - [ ] Add new entity modal with property definitions
  - [ ] Edit entity properties (name, display_name, description)
  - [ ] Add/edit/delete properties within entities
  - [ ] Create relationships by dragging between entities
  - [ ] Edit relationship properties (FK column name, cascade rules)
  - [ ] Delete entities and relationships with confirmation
  - [ ] Undo/redo support for all editing operations
  - [ ] Live validation and database schema updates
  - [ ] Migration preview before applying changes
- [ ] Allow creating new columns on an existing entity
- [ ] Allow creation/modification of text search columns

### Workflow
- [ ] Build GUI editor for Workflow diagrams showing how workflows operate

### Logic
- [ ] Build GUI editor for Block Diagrams showing how Logic works
- [ ] **Entity Actions Editor** - Full CRUD for entity actions via UI
  - [ ] Create new actions (select entity, configure RPC, set conditions)
  - [ ] Edit existing actions (update visibility/enabled conditions, button style, messages)
  - [ ] Delete actions with confirmation
  - [ ] Manage role permissions inline

- [ ] **Validation Management UI** - Full CRUD for validation rules
  - [ ] Add/edit/delete validation rules per property
  - [ ] Validation type picker (required, min, max, minLength, maxLength, pattern)
  - [ ] Custom error message editor
  - [ ] Link from Schema Inspector Validations tab

### Analytics & Observability
- [ ] Build integrated analytics engine (no external servers required)
  - [ ] Error logging and tracking
  - [ ] Usage metrics and user behavior analytics
  - [ ] Query performance monitoring (detect and log slow queries)
  - [ ] Database-backed storage for all telemetry data
  - [ ] Admin dashboard for viewing analytics and trends
  - [ ] Replace external Matomo dependency with self-contained solution


## Phase 4: Extension Modules
- [ ] Financial Tools (Accounting)
- [x] **Payments Integration** (v0.13.0/v0.14.0 - Stripe, metadata-driven, refunds, admin UI, notifications)
  - [ ] Conditional payment button visibility (`payment_show_condition` JSONB, like action buttons)

- [ ] **Assignment Queue / Load Balancing** - Work distribution for teams
  - [ ] Work queue concept (entities with `assigned_user_id` column)
  - [ ] Round-robin assignment algorithm
  - [ ] Load-based assignment (items per user)
  - [ ] Workload visibility dashboard widget
  - [ ] Manual reassignment via Entity Actions

- [ ] **E-Signatures** - Electronic document signing capabilities

---

For more details on the vision behind these phases, see the [Civic OS Vision repository](https://github.com/civic-os/vision).
