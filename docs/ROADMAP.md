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

#### List Pages
- [X] Add pagination
- [x] Add text search as an indexed column and toggle-able search box
- [x] Add Map view for List pages
- [x] Add Calendar view for List pages (TimeSlot property type with FullCalendar integration)
- [x] Add Sortable columns and default sort
- [x] Add filter-able columns (mostly FK fields, but also expand to other indexed fields like datetime)
- [x] Add spreadsheet Import/Export capabilities

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
- [ ] **Entity Action Buttons** - Manually triggerable logic via buttons on Entity detail pages (see `docs/development/ENTITY_ACTIONS.md`)
  - [ ] Database schema (entity_actions, protected_rpcs tables) and migration
  - [ ] Per-RPC permission system with role mapping
  - [ ] Conditional visibility and disabled state (JSONB expressions evaluated client-side)
  - [ ] RPC-driven post-action behavior (messages, navigation, refresh controlled by return value)
  - [ ] Frontend integration (DetailPage buttons, confirmation modals, loading states)
  - [ ] Example implementation in pothole domain (approve/reject actions)

### Dashboards (Phased Development)
- [x] **Phase 1 - Core Infrastructure**: Database schema, widget registry, markdown widget, static dashboard with navigation
- [ ] **Phase 2 - Dynamic Widgets**: Filtered list widget, auto-refresh infrastructure, data freshness UX
- [ ] **Phase 3 - Management**: Dashboard management UI, widget editor, user preferences, global filter bar
- [ ] **Phase 4 - Polish**: Drag-and-drop reordering, dashboard templates, embedded links, mobile optimizations
- [ ] **Phase 5 - Advanced Widgets**: Stat cards (backend aggregation required), charts (Chart.js), query results from views
- [ ] **Phase 6 - Permissions**: Role-based visibility, widget-level permissions, private dashboards

### General
- [ ] ADA/WCAG Compatibility
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
- [ ] Add static helper text fields (display-only metadata.properties entries for form guidance, no database column)
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
- [ ] Build automatic generation of Block Diagrams showing how Logic works

### Utilities
- [ ] Build notification service

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
- [ ] Payments Integration


---

For more details on the vision behind these phases, see the [Civic OS Vision repository](https://github.com/civic-os/vision).
