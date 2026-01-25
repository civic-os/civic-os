# Civic OS Integrator Guide

This guide is for system administrators and integrators setting up and configuring Civic OS instances. If you're a developer building applications **on top of** Civic OS, see `CLAUDE.md` for quick-reference documentation.

**Audience**:
- System administrators deploying Civic OS
- Integrators configuring metadata for custom domains
- Database administrators managing schema and permissions
- DevOps engineers setting up CI/CD pipelines

**Related Documentation**:
- `CLAUDE.md` - Developer quick-reference for building Civic OS apps
- `docs/deployment/PRODUCTION.md` - Production deployment and containerization
- `postgres/migrations/README.md` - Sqitch migrations and schema management
- `docs/AUTHENTICATION.md` - Keycloak setup and RBAC configuration

---

## Table of Contents

- [Metadata Architecture](#metadata-architecture)
- [Built-in PostgreSQL Functions](#built-in-postgresql-functions)
- [Feature Configuration](#feature-configuration)
- [Database Patterns](#database-patterns)
- [Production Considerations](#production-considerations)

---

## Metadata Architecture

Civic OS uses a metadata-driven architecture where database tables in the `metadata` schema control UI behavior, validation rules, and permissions. Understanding this architecture is essential for configuring instances.

### Entity & Property Configuration

**`metadata.entities`** - Controls how tables are displayed and behave in the UI

Key fields:
- `table_name` (PK) - PostgreSQL table name (from `public` schema)
- `display_name` - Friendly name shown in menu and page titles
- `description` - Optional description shown on List pages
- `sort_order` - Menu ordering (lower numbers appear first)
- `search_fields` - TEXT[] array of columns for full-text search
- `show_on_map` - BOOLEAN - Enable map visualization on List page
- `map_property_name` - Column name with geography data (requires `show_on_map=true`)
- `show_calendar` - BOOLEAN - Enable calendar visualization on List page
- `calendar_property_name` - Column name with time_slot data (requires `show_calendar=true`)
- `calendar_color_property` - Optional hex_color column for event colors

**Configuration Methods**:
1. Entity Management page UI (`/entity-management`) - Admin-only visual editor
2. SQL INSERT/UPDATE statements - Seed scripts or migrations
3. RPC function: `upsert_entity_metadata()` - Programmatic configuration

**Example**: Configure entity for calendar view
```sql
INSERT INTO metadata.entities (
  table_name,
  display_name,
  description,
  sort_order,
  search_fields,
  show_on_map,
  map_property_name,
  show_calendar,
  calendar_property_name,
  calendar_color_property
) VALUES (
  'reservations',
  'Reservations',
  'Resource booking system',
  10,
  ARRAY['purpose', 'notes'],  -- Full-text search columns
  FALSE, NULL,                  -- Map disabled
  TRUE, 'time_slot', 'color'   -- Calendar enabled
);
```

---

**`metadata.properties`** - Controls how individual columns are displayed and behave

Key fields:
- `table_name`, `column_name` (Composite PK) - Identifies the property
- `display_name` - Custom label (default: column_name with underscores removed)
- `description` - Optional help text shown in forms
- `sort_order` - Field ordering in forms/tables (lower numbers first)
- `column_width` - Form field width: 1 (half) or 2 (full, default)
- `sortable` - BOOLEAN - Enable column sorting on List pages
- `filterable` - BOOLEAN - Show property in filter bar (supports: ForeignKeyName, User, DateTime, DateTimeLocal, Date, Boolean, Money, IntegerNumber)
- `show_on_list` - BOOLEAN - Display in List page table (default: true)
- `show_on_create` - BOOLEAN - Display in Create form (default: true)
- `show_on_edit` - BOOLEAN - Display in Edit form (default: true)
- `show_on_detail` - BOOLEAN - Display in Detail page (default: true)

**Configuration Methods**:
1. Property Management page UI (`/property-management`) - Admin-only visual editor
2. SQL INSERT/UPDATE statements with `ON CONFLICT` for idempotency
3. RPC function: `upsert_property_metadata()` - Programmatic configuration

**Example**: Configure property visibility and filtering
```sql
-- Enable filtering on status dropdown
INSERT INTO metadata.properties (table_name, column_name, filterable)
VALUES ('issues', 'status_id', TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET filterable = TRUE;

-- Hide system fields from create/edit forms (keep on detail)
UPDATE metadata.properties
SET show_on_create = FALSE, show_on_edit = FALSE
WHERE column_name IN ('created_at', 'updated_at');

-- Set custom label and half-width display
INSERT INTO metadata.properties (table_name, column_name, display_name, column_width)
VALUES ('issues', 'severity', 'Severity Level', 1)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name, column_width = EXCLUDED.column_width;
```

---

### Validation System

**`metadata.validations`** - Defines frontend validation rules applied before API submission

Supported validation types:
- `required` - Field must have a value
- `min` / `max` - Numeric range validation (for IntegerNumber, Money)
- `minLength` / `maxLength` - String length validation (for TextShort, TextLong)
- `pattern` - Regex pattern validation (for all text types)
- `fileType` - MIME type validation (for File properties only)
- `maxFileSize` - Size limit in bytes (for File properties only)

Fields:
- `table_name`, `column_name` - Identifies the property
- `validation_type` - One of the types above
- `validation_value` - The constraint value (e.g., "10" for min, "^\\d{5}$" for zip code pattern)
- `error_message` - User-friendly error message shown when validation fails
- `sort_order` - Order of validation checks (lower numbers first)

**Important**: Validation rules are **frontend-only** and can be bypassed. Always add corresponding database constraints (CHECK, NOT NULL, UNIQUE) for security.

**Example**: Add validation rules with backend enforcement
```sql
-- 1. Backend enforcement (CHECK constraint)
ALTER TABLE products
  ADD CONSTRAINT price_positive CHECK (price > 0),
  ADD CONSTRAINT price_max CHECK (price <= 1000000);

-- 2. Frontend validation (immediate UX feedback)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('products', 'price', 'min', '0.01', 'Price must be greater than zero', 1),
  ('products', 'price', 'max', '1000000', 'Price cannot exceed $1,000,000', 2);

-- 3. Friendly error mapping (for when frontend is bypassed)
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('price_positive', 'products', 'price', 'Price must be greater than zero'),
  ('price_max', 'products', 'price', 'Price cannot exceed $1,000,000');
```

**Pattern Validation Examples**:
```sql
-- US ZIP code
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('addresses', 'zip_code', 'pattern', '^\d{5}(-\d{4})?$', 'ZIP code must be 5 or 9 digits');

-- Username (alphanumeric, 3-20 chars)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('users', 'username', 'pattern', '^[a-zA-Z0-9_]{3,20}$', 'Username must be 3-20 alphanumeric characters');
```

---

### Avoid Dynamic Values in CHECK Constraints

**WARNING**: Do NOT use `CURRENT_DATE`, `NOW()`, or `CURRENT_TIMESTAMP` in CHECK constraints.

CHECK constraints are evaluated on **every INSERT and UPDATE**. If you use dynamic values:
- A row that was valid when created may become invalid later
- ANY update to the row (even unrelated columns) will fail once the constraint condition changes

**Bad Example**:
```sql
-- This blocks ALL updates once the event is < 10 days away!
ALTER TABLE reservations
  ADD CONSTRAINT min_advance_booking
  CHECK (event_date >= CURRENT_DATE + INTERVAL '10 days');
```

**Good Example**:
```sql
-- Use created_at to validate against submission time (immutable)
ALTER TABLE reservations
  ADD CONSTRAINT min_advance_booking
  CHECK (event_date >= created_at::DATE + INTERVAL '10 days');
```

**Alternative Approaches** for time-based validations that should only apply at creation:
1. **Use `created_at`** as the reference point (recommended - simple and declarative)
2. **Use a trigger** with `TG_OP = 'INSERT'` check (more flexible but more code)
3. **Validate in an RPC function** instead of a constraint (for complex business logic)

---

**`metadata.constraint_messages`** - Maps database constraint names to user-friendly error messages

When database constraints are violated (CHECK, UNIQUE, FOREIGN KEY, EXCLUSION), PostgreSQL returns cryptic error messages like `"23514: new row violates check constraint"`. This table maps constraint names to friendly messages that users see in the UI.

**How It Works** (Implemented in v0.9.0):
1. Frontend preloads constraint messages at startup via `public.constraint_messages` view
2. Messages are cached in `SchemaService` alongside entities and properties
3. When a constraint error occurs, `ErrorService` extracts the constraint name from the PostgreSQL error
4. The cached message is looked up and displayed to the user
5. Cache is refreshed on navigation when `schema_cache_versions` detects changes

**Supported Error Codes**:
- `23514` - CHECK constraint violations
- `23P01` - Exclusion constraint violations (e.g., overlapping time slots)
- `23505` - UNIQUE constraint violations (future support)
- `23503` - FOREIGN KEY violations (future support)

Fields:
- `constraint_name` (PK) - PostgreSQL constraint name
- `table_name` - Table where constraint is defined
- `column_name` - Column involved (NULL for multi-column constraints)
- `error_message` - User-friendly message shown in UI

**Example**: Map constraints to friendly errors
```sql
-- CHECK constraints
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('age_minimum', 'users', 'age', 'You must be at least 18 years old'),
  ('valid_email_domain', 'users', 'email', 'Email must be from an authorized domain');

-- UNIQUE constraints (currently falls back to generic "Record must be unique")
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('users_email_key', 'users', 'email', 'An account with this email address already exists'),
  ('issues_ticket_number_key', 'issues', 'ticket_number', 'This ticket number is already in use');

-- FOREIGN KEY constraints (currently falls back to generic error)
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('issues_assigned_to_fkey', 'issues', 'assigned_to', 'Cannot delete user: they have assigned issues');

-- EXCLUSION constraints (v0.9.0+, used for TimeSlot overlap prevention)
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('no_overlapping_reservations', 'reservations', 'time_slot',
   'This time slot is already booked. Please select a different time or check the calendar for availability.');
```

**Finding Constraint Names**: Query `pg_constraint` to find constraint names in your database:
```sql
SELECT conname, conrelid::regclass AS table_name, contype
FROM pg_constraint
WHERE conrelid::regclass::text = 'your_table_name';
-- contype: 'c' = CHECK, 'u' = UNIQUE, 'f' = FOREIGN KEY, 'x' = EXCLUSION
```

---

### RBAC System

**`metadata.roles`** - Defines authorization roles

Fields:
- `id` (SERIAL PK) - Unique role identifier
- `display_name` - Role name (should match Keycloak role name)
- `description` - Optional description of role's purpose

**Default Roles** (created in baseline migration):
- `anonymous` - Unauthenticated users
- `user` - Authenticated users (basic access)
- `editor` - Can create and edit records
- `admin` - Full access including admin pages

#### Anonymous Access Patterns

The `web_anon` PostgreSQL role controls what unauthenticated users can see. Two patterns are available:

| Pattern | Use Case | Anonymous Experience |
|---------|----------|---------------------|
| **Grant SELECT to `web_anon`** | Public data (events, locations, reports) | Can browse list/detail pages |
| **No grants to `web_anon`** | Sensitive data (payments, private records) | "Sign in to view" prompt |

**Recommendation**: Grant `web_anon` SELECT on most tables for public browsing. Withhold for:
- Payment/financial tables
- Private user information
- Draft/unpublished content

**Example - Public table:**
```sql
GRANT SELECT ON public.events TO web_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events TO authenticated;
```

**Example - Sensitive table (no anonymous access):**
```sql
-- No web_anon grant = table invisible to anonymous users
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
```

**Why this matters**: When `web_anon` has no privileges on a table, PostgreSQL's `information_schema` doesn't expose the table at all. This means:
1. The table won't appear in `schema_entities` for anonymous users
2. Attackers can't even enumerate that the table exists
3. This provides stronger security than RLS-based blocking alone

---

**Creating Custom Roles**:
```sql
-- Via SQL
INSERT INTO metadata.roles (display_name, description)
VALUES ('moderator', 'Can review and approve submissions');

-- Via RPC
SELECT create_role('moderator', 'Can review and approve submissions');
```

---

**`metadata.permissions`** - Defines available permissions for tables

Fields:
- `id` (SERIAL PK) - Unique permission identifier
- `table_name` - PostgreSQL table name
- `permission` - Enum: 'CREATE', 'READ', 'UPDATE', 'DELETE'

**Permissions are automatically created** when tables are discovered by the schema service. You rarely need to manually insert into this table.

---

**`metadata.permission_roles`** - Junction table mapping roles to permissions

Fields:
- `role_id` (FK to roles) - Role being granted permission
- `permission_id` (FK to permissions) - Permission being granted
- `granted` (BOOLEAN) - TRUE to grant, FALSE to explicitly deny

**Configuration Methods**:
1. Permissions page UI (`/permissions`) - Admin-only matrix editor
2. RPC function: `set_role_permission(role_id, table_name, permission, granted)` - Programmatic configuration

**Example**: Grant permissions to custom role
```sql
-- Grant moderator role READ and UPDATE on issues table
SELECT set_role_permission(
  (SELECT id FROM metadata.roles WHERE display_name = 'moderator'),
  'issues',
  'READ',
  TRUE
);

SELECT set_role_permission(
  (SELECT id FROM metadata.roles WHERE display_name = 'moderator'),
  'issues',
  'UPDATE',
  TRUE
);
```

**Keycloak Integration**: Roles must be configured in Keycloak and included in JWT tokens. See `docs/AUTHENTICATION.md` for setup instructions.

---

### File Storage System

**`metadata.files`** - Tracks uploaded files stored in S3-compatible storage (MinIO for development, AWS S3 for production)

Fields:
- `id` (UUID PK) - Unique file identifier (referenced by entity FKs)
- `original_filename` - User's original filename
- `s3_key` - S3 object key (path in bucket: `{entity_type}/{entity_id}/{file_id}/original.{ext}`)
- `mime_type` - Content type (e.g., 'image/jpeg', 'application/pdf')
- `size_bytes` - File size for quota enforcement
- `thumbnail_status` - Enum: 'pending', 'processing', 'completed', 'failed', 'not_applicable'
- `entity_table`, `entity_id` - Back-reference to owning entity
- `created_by` (UUID FK) - User who uploaded the file

**File Storage Architecture** (v0.10.0+):

Civic OS provides a complete file upload workflow using **Go microservices** with River job queue:

1. **S3 Signer Service**: Generates presigned upload URLs via PostgreSQL job queue
   - Frontend calls `request_file_upload()` RPC which creates job in `metadata.river_job` table
   - Go service polls for jobs, generates presigned S3 URLs, updates `file_upload_requests` table
   - Provides at-least-once delivery with automatic retries and exponential backoff

2. **Thumbnail Worker**: Processes uploaded images and PDFs asynchronously
   - Listens for file creation events via PostgreSQL NOTIFY
   - Generates 3 thumbnail sizes for images (150x150, 400x400, 800x800) using libvips
   - Extracts first page of PDFs as thumbnail (400x400) using pdftoppm
   - White background letterboxing preserves aspect ratio
   - Stores thumbnails in S3: `{entity_type}/{entity_id}/{file_id}/thumb-{size}.jpg`

3. **Property Types**: `FileImage`, `FilePDF`, `File` detected from validation metadata
   - UI automatically shows thumbnails, lightbox viewers, and download links
   - Validation enforced via `fileType` and `maxFileSize` in `metadata.validations`

**Deployment Requirements**:
- S3-compatible storage (MinIO, AWS S3, DigitalOcean Spaces)
- Consolidated Worker container (handles S3 presigning, thumbnail generation, and notifications)
- PostgreSQL with River tables (`metadata.river_job`, `metadata.river_leader`)
- Environment variables: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `DB_MAX_CONNS`

**Implementation Guide**: See `docs/development/FILE_STORAGE.md` for complete setup instructions including adding file properties to your schema, validation configuration, and deployment examples.

---

### User System

**`metadata.civic_os_users`** (PUBLIC view) - User profile data visible to all authenticated users

Fields:
- `id` (UUID PK) - User identifier (from Keycloak 'sub' claim)
- `display_name` - User's display name (from Keycloak 'preferred_username')

This is a **view** combining data from `metadata.civic_os_users` (public profile) and `metadata.civic_os_users_private` (private contact info).

**`metadata.civic_os_users_private`** (PRIVATE table) - Sensitive user data with row-level security

Fields:
- `user_id` (UUID PK FK) - References civic_os_users.id
- `full_name` - Full legal name (from Keycloak 'name')
- `email` - Email address (from Keycloak 'email')
- `phone` - Phone number (from Keycloak custom attribute)

**Privacy Model**:
- Private fields are NULL in `civic_os_users` view unless:
  - User is viewing their own record (`user_id = current_user_id()`), OR
  - User has `civic_os_users_private:read` permission

**Data Sync**: User data is synced from Keycloak on login via `refresh_current_user()` RPC. This ensures Civic OS has current profile information without storing passwords.

---

### Dashboard System

**Status**: Phase 2 - Filtered list and map widgets complete, management UI in progress

**`metadata.dashboards`** - Dashboard definitions

Fields:
- `id` (SERIAL PK) - Unique dashboard identifier
- `display_name` - Dashboard name shown in selector
- `description` - Optional description
- `is_default` (BOOLEAN) - System default dashboard (only one should be true)
- `is_public` (BOOLEAN) - Visible to all users (false = owner-only)
- `created_by` (UUID FK) - Dashboard owner
- `sort_order` - Ordering in dashboard selector (lower numbers first)

**`metadata.widget_types`** - Registry of available widget types

Pre-populated types:
- `markdown` - Static content with markdown formatting (Phase 1, ✅ implemented)
- `filtered_list` - Dynamic entity lists with filters (Phase 2, ✅ implemented)
- `map` - Interactive maps with filtered geographic data (Phase 2, ✅ implemented)
- `calendar` - Interactive calendar for time_slot entities (Phase 2, ✅ implemented)
- `dashboard_navigation` - Sequential prev/next navigation for storymaps (Phase 2, ✅ implemented)
- `nav_buttons` - Flexible navigation buttons with icons and styles (Phase 2, ✅ implemented)
- `stat_card` - Single metric display with sparklines (Phase 5, planned)
- `query_result` - Results from database views or RPCs (Phase 5, planned)

**`metadata.dashboard_widgets`** - Widget configurations using hybrid storage pattern

Fields:
- `id` (SERIAL PK) - Unique widget identifier
- `dashboard_id` (FK) - Parent dashboard
- `widget_type` (FK) - Type from widget_types table
- `title` - Widget title displayed in card header
- `sort_order` - Position on dashboard (lower numbers first)
- `entity_key` - Optional table name for filtered_list and map widgets
- `refresh_interval_seconds` - Optional auto-refresh interval (NULL = no refresh, deferred to Phase 3)
- `width` - Widget width in DaisyUI grid units (1 = half-width, 2 = full-width)
- `height` - Widget height in DaisyUI grid units (1-3)
- `config` (JSONB) - Widget-specific configuration

**Hybrid Storage Pattern**: Common fields (entity_key, title, refresh_interval, width, height) are typed columns for efficient queries. Widget-specific settings (e.g., markdown content, filter expressions, map options) are stored in JSONB `config` field for flexibility.

**Creating Dashboards**:
```sql
-- 1. Create dashboard (use DO block for variable assignment)
DO $$
DECLARE v_dashboard_id INT;
BEGIN
  INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
  VALUES ('Operations Dashboard', 'Real-time system metrics', FALSE, TRUE, 10)
  RETURNING id INTO v_dashboard_id;

  -- 2. Add markdown widget
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'markdown',
    NULL,  -- No title for header-only markdown
    jsonb_build_object(
      'content', E'# Operations Dashboard\n\nMonitor system health and metrics below.',
      'enableHtml', false
    ),
    1, 2, 1  -- Full-width, single height unit
  );

  -- 3. Add filtered list widget
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'filtered_list',
    'Recent Issues',
    'issues',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', 1)
      ),
      'orderBy', 'created_at',
      'orderDirection', 'desc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'status_id', 'created_at')
    ),
    2, 1, 2  -- Half-width, double height
  );

  -- 4. Add map widget
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'map',
    'Issue Locations',
    'issues',
    jsonb_build_object(
      'entityKey', 'issues',
      'mapPropertyName', 'location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', 1)
      ),
      'showColumns', jsonb_build_array('display_name', 'severity'),
      'enableClustering', true,
      'clusterRadius', 50,
      'maxMarkers', 500
    ),
    3, 1, 2  -- Half-width, double height
  );

  -- 5. Add calendar widget
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, entity_key, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'calendar',
    'Upcoming Reservations',
    'reservations',
    jsonb_build_object(
      'entityKey', 'reservations',
      'timeSlotPropertyName', 'time_slot',
      'colorProperty', 'status_color',
      'defaultColor', '#3B82F6',
      'initialView', 'timeGridWeek',
      'showCreateButton', true,
      'maxEvents', 500,
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status', 'operator', 'neq', 'value', 'cancelled')
      ),
      'showColumns', jsonb_build_array('display_name', 'resource_id', 'status')
    ),
    4, 2, 2  -- Full-width, double height
  );

  -- 6. Add navigation buttons widget
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
  VALUES (
    v_dashboard_id,
    'nav_buttons',
    NULL,  -- Header is in config
    jsonb_build_object(
      'header', 'Quick Actions',
      'description', 'Navigate to commonly used areas',
      'buttons', jsonb_build_array(
        jsonb_build_object('text', 'New Issue', 'url', '/create/issues', 'icon', 'add_circle', 'variant', 'primary'),
        jsonb_build_object('text', 'View All', 'url', '/view/issues', 'icon', 'list'),
        jsonb_build_object('text', 'Reports', 'url', '/dashboard/2', 'icon', 'bar_chart', 'variant', 'ghost')
      )
    ),
    5, 2, 1  -- Full-width, single height
  );
END $$;
```

**Widget Config Examples**:

Markdown widget (`enableHtml` allows sanitized HTML via DOMPurify):
```json
{
  "content": "# Hello World\n\nMarkdown **formatting** supported.",
  "enableHtml": false
}
```

Filtered List widget:
```json
{
  "filters": [
    {"column": "status_id", "operator": "eq", "value": 1},
    {"column": "severity", "operator": "gte", "value": 3}
  ],
  "orderBy": "created_at",
  "orderDirection": "desc",
  "limit": 10,
  "showColumns": ["display_name", "status_id", "severity", "created_at"]
}
```

**Filter operators**: `eq` (equals), `neq` (not equals), `lt` (less than), `lte` (less than or equal), `gt` (greater than), `gte` (greater than or equal), `in` (in array), `is` (null check), `like` (pattern match), `ov` (overlaps for ranges)

Map widget (requires geography column with paired `_text` computed field):
```json
{
  "entityKey": "issues",
  "mapPropertyName": "location",
  "filters": [
    {"column": "status_id", "operator": "eq", "value": 1}
  ],
  "showColumns": ["display_name", "severity"],
  "enableClustering": true,
  "clusterRadius": 50,
  "maxMarkers": 500,
  "defaultZoom": 12,
  "defaultCenter": [42.3314, -83.0458]
}
```

Calendar widget (requires time_slot column):
```json
{
  "entityKey": "reservations",
  "timeSlotPropertyName": "time_slot",
  "colorProperty": "status_color",
  "defaultColor": "#3B82F6",
  "initialView": "timeGridWeek",
  "initialDate": "2025-03-15",
  "showCreateButton": true,
  "maxEvents": 1000,
  "filters": [
    {"column": "status", "operator": "neq", "value": "cancelled"}
  ],
  "showColumns": ["display_name", "resource_id", "status"]
}
```

**Calendar features**: Displays events with `time_slot` properties on interactive calendar with month/week/day views. Auto-fetches events when navigating calendar using the `ov` (overlaps) operator. Event clicks open detail page in new tab. Optional create button navigates to entity create form.

**Map clustering**: When `enableClustering=true`, nearby markers are grouped into clusters to improve performance and reduce visual clutter. Click clusters to zoom in and expand. `clusterRadius` controls grouping distance in pixels (default: 50).

**StoryMap Example**: See `examples/storymap/` for a complete Phase 2 demonstration. The Youth Soccer StoryMap shows program growth from 2018-2025 through four narrative dashboards with progressive clustering, filtered lists, and markdown narratives. This example demonstrates:
- Temporal filtering (dashboards for different years)
- Geographic visualization with clustering strategy (2018: no clustering, 2025: heavy clustering)
- Filtered list widgets showing teams and sponsors by season
- Map widgets displaying participant home locations
- Markdown narratives with editable placeholders

Setup: `cd examples/storymap && docker-compose up -d && npm run generate storymap && npm start`

**Adding Custom Widget Types**:
1. Insert into `metadata.widget_types`:
   ```sql
   INSERT INTO metadata.widget_types (name, description)
   VALUES ('chart', 'Interactive chart visualization');
   ```

2. Create Angular component implementing widget interface:
   ```typescript
   @Component({
     selector: 'app-chart-widget',
     // ... component implementation
   })
   export class ChartWidgetComponent {
     @Input() config!: ChartWidgetConfig;  // Type-safe config
     // ... rendering logic
   }
   ```

3. Register in `WidgetComponentRegistry` via `app.config.ts`:
   ```typescript
   export const appConfig: ApplicationConfig = {
     providers: [
       {
         provide: APP_INITIALIZER,
         useFactory: (registry: WidgetComponentRegistry) => () => {
           registry.register('chart', ChartWidgetComponent);
         },
         deps: [WidgetComponentRegistry],
         multi: true
       }
     ]
   };
   ```

4. Define TypeScript interface for widget config:
   ```typescript
   interface ChartWidgetConfig {
     chartType: 'line' | 'bar' | 'pie';
     dataSource: string;  // RPC function or view name
     xAxis: string;
     yAxis: string;
   }
   ```

See `docs/notes/DASHBOARD_DESIGN.md` for complete architecture, Phase 2-5 roadmap, and future features.

---

## Built-in PostgreSQL Functions

Civic OS provides helper functions for common integration tasks. These can be called via PostgREST API or used directly in SQL (RLS policies, triggers, seed scripts).

### JWT Helper Functions

Extract authenticated user data from Keycloak JWT tokens. The JWT is automatically included in PostgreSQL's `request.jwt.claims` via PostgREST.

**`current_user_id()`** → UUID
- Returns user's unique identifier from JWT 'sub' claim
- Returns NULL for anonymous requests (no JWT)
- **Most common use case**: Row Level Security policies

**`current_user_email()`** → TEXT
- Returns email address from JWT 'email' claim
- Returns NULL if not present

**`current_user_name()`** → TEXT
- Returns display name from JWT 'name' or 'preferred_username' claim
- Returns NULL if not present

**`current_user_phone()`** → TEXT (v0.6.0+)
- Returns phone number from JWT custom attribute
- Requires Keycloak configuration (see `docs/AUTHENTICATION.md` Step 5)
- Returns NULL if not configured or not present

**Examples**:

Row Level Security policy:
```sql
CREATE POLICY "Users see own records"
  ON my_table FOR SELECT TO authenticated
  USING (user_id = current_user_id());

CREATE POLICY "Users edit own records"
  ON my_table FOR UPDATE TO authenticated
  USING (user_id = current_user_id());
```

Default value for user_id columns:
```sql
CREATE TABLE issues (
  id BIGSERIAL PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  created_by UUID NOT NULL DEFAULT current_user_id(),
  updated_by UUID NOT NULL DEFAULT current_user_id()
);

-- Update updated_by on changes
CREATE TRIGGER set_updated_by BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION set_updated_by_current_user();
```

---

### RBAC Functions

Check permissions and roles from application code (via PostgREST) or RLS policies.

**`get_user_roles()`** → TEXT[]
- Returns array of role names from JWT 'roles' claim
- Returns empty array for anonymous requests
- **Use case**: Complex authorization logic in RLS policies

**`has_permission(table_name TEXT, permission TEXT)`** → BOOLEAN
- Checks if current user has specified permission on table
- Permission values: 'CREATE', 'READ', 'UPDATE', 'DELETE'
- Returns FALSE for anonymous requests
- **Use case**: Dynamic permission checks in RLS policies or application logic

**`is_admin()`** → BOOLEAN
- Checks if current user has 'admin' role
- Returns FALSE for anonymous requests
- **Use case**: Admin-only features and RLS policies

**Examples**:

RLS policy using permission check:
```sql
CREATE POLICY "Users with read permission can view"
  ON sensitive_table FOR SELECT
  USING (has_permission('sensitive_table', 'READ'));

CREATE POLICY "Admins bypass all restrictions"
  ON sensitive_table FOR ALL
  USING (is_admin());
```

Complex role-based logic:
```sql
CREATE POLICY "Moderators and admins can approve"
  ON submissions FOR UPDATE
  USING (
    status = 'pending' AND (
      'moderator' = ANY(get_user_roles()) OR
      is_admin()
    )
  );
```

---

### Admin Functions

Programmatically configure entity and property metadata. Alternative to using admin UI pages.

**`upsert_entity_metadata(...)`**
- Configures entity display settings, search fields, map/calendar visualization
- Upserts (INSERT ON CONFLICT UPDATE) for idempotency
- **Use case**: Seed scripts that configure multiple entities at once

Parameters:
- `p_table_name` TEXT - Table name
- `p_display_name` TEXT - Friendly name (NULL = no change)
- `p_description` TEXT - Description (NULL = no change)
- `p_sort_order` INT - Menu ordering (NULL = no change)
- `p_search_fields` TEXT[] - Full-text search columns (NULL = no change)
- `p_show_on_map` BOOLEAN - Enable map view (NULL = no change)
- `p_map_property_name` TEXT - Geography column name (NULL = no change)
- `p_show_calendar` BOOLEAN - Enable calendar view (NULL = no change)
- `p_calendar_property_name` TEXT - TimeSlot column name (NULL = no change)
- `p_calendar_color_property` TEXT - Color column name (NULL = no change)

**`upsert_property_metadata(...)`**
- Configures property labels, ordering, visibility, width
- Upserts (INSERT ON CONFLICT UPDATE) for idempotency
- **Use case**: Seed scripts that configure multiple properties at once

Parameters:
- `p_table_name` TEXT - Table name
- `p_column_name` TEXT - Column name
- `p_display_name` TEXT - Custom label (NULL = no change)
- `p_description` TEXT - Help text (NULL = no change)
- `p_sort_order` INT - Field ordering (NULL = no change)
- `p_column_width` INT - Form width: 1 or 2 (NULL = no change)
- `p_sortable` BOOLEAN - Enable sorting (NULL = no change)
- `p_filterable` BOOLEAN - Show in filter bar (NULL = no change)
- `p_show_on_list` BOOLEAN - Show on List page (NULL = no change)
- `p_show_on_create` BOOLEAN - Show in Create form (NULL = no change)
- `p_show_on_edit` BOOLEAN - Show in Edit form (NULL = no change)
- `p_show_on_detail` BOOLEAN - Show in Detail page (NULL = no change)

**`set_role_permission(p_role_id INT, p_table_name TEXT, p_permission TEXT, p_granted BOOLEAN)`**
- Grants or revokes permission for a role on a table
- Creates permission record if it doesn't exist
- **Use case**: Seed scripts that configure RBAC

**`create_role(p_display_name TEXT, p_description TEXT)`** → INT
- Creates a new role
- Returns role ID
- **Use case**: Seed scripts that define custom roles

**Examples**:

Seed script configuring entity metadata:
```sql
-- Configure issues entity
SELECT upsert_entity_metadata(
  'issues',                               -- table_name
  'Issues',                                -- display_name
  'Issue tracking system',                 -- description
  10,                                      -- sort_order
  ARRAY['display_name', 'description'],   -- search_fields
  TRUE, 'location',                        -- map enabled
  FALSE, NULL, NULL                        -- calendar disabled
);

-- Configure properties
SELECT upsert_property_metadata('issues', 'created_at', NULL, NULL, NULL, NULL, NULL, NULL, FALSE, FALSE, TRUE);  -- Hide from create/edit
SELECT upsert_property_metadata('issues', 'status_id', 'Status', NULL, 1, 2, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE);  -- Enable filtering
```

Seed script configuring RBAC:
```sql
-- Create custom role
SELECT create_role('moderator', 'Can review and approve content');

-- Grant permissions
SELECT set_role_permission(
  (SELECT id FROM metadata.roles WHERE display_name = 'moderator'),
  'submissions',
  'READ',
  TRUE
);

SELECT set_role_permission(
  (SELECT id FROM metadata.roles WHERE display_name = 'moderator'),
  'submissions',
  'UPDATE',
  TRUE
);
```

---

## Feature Configuration

### Full-Text Search

Enable full-text search on List pages by adding a generated tsvector column and configuring search fields.

**Steps**:

1. Add `civic_os_text_search` column (generated, indexed):
   ```sql
   ALTER TABLE issues
     ADD COLUMN civic_os_text_search tsvector
       GENERATED ALWAYS AS (
         to_tsvector('english',
           coalesce(display_name, '') || ' ' ||
           coalesce(description, '')
         )
       ) STORED;

   CREATE INDEX idx_issues_text_search ON issues USING GIN(civic_os_text_search);
   ```

2. Configure search fields in `metadata.entities`:
   ```sql
   UPDATE metadata.entities
   SET search_fields = ARRAY['display_name', 'description']
   WHERE table_name = 'issues';
   ```

3. Frontend automatically displays search input on List page when `search_fields` is populated.

**Performance**: GIN indexes are highly efficient for full-text search. Expect sub-second queries on tables with millions of rows.

---

### Import/Export System

List pages automatically include Import/Export buttons for bulk data operations. No configuration required—feature is enabled globally.

**Export Features**:
- Preserves active filters, search, and sort order
- Includes all fields (system fields + foreign key display names)
- Dual-column format for foreign keys: `status_id` (integer) + `status_id_name` (display name)
- 50,000 row limit (configurable in `list.page.ts`)

**Import Features**:
- Name-to-ID resolution: Enter "Open" instead of `status_id=1`
- Web Worker validation: Non-blocking UI, comprehensive error reporting
- Template generation: Includes reference sheets for lookup tables
- All-or-nothing transactions: Single row failure rejects entire batch

**Technical Limitations**:
- Many-to-many relationships not supported (use junction table import)
- 10MB file size limit (browser constraint)
- INSERT only (no updates)
- Requires CREATE permission on entity

**Use Cases**:
- Initial data migration from legacy systems
- Bulk data entry (e.g., importing 1000 issues from spreadsheet)
- Data export for external analysis

See `docs/development/IMPORT_EXPORT.md` for complete specification including validation rules, error handling, and template format.

---

### Calendar Views

Enable calendar visualization on List pages for entities with `time_slot` properties.

**Requirements**:
- Civic OS v0.9.0+ (includes `time_slot` domain and `btree_gist` extension)
- Table must have `time_slot` column (PostgreSQL tstzrange)
- Optional: `hex_color` column for event colors

**Configuration**:
```sql
-- Enable calendar on List page
UPDATE metadata.entities SET
  show_calendar = TRUE,
  calendar_property_name = 'time_slot',
  calendar_color_property = 'color'  -- Optional
WHERE table_name = 'reservations';
```

**Behavior**:
- List page shows toggle button to switch between table/calendar views
- Detail pages automatically show calendar sections for related entities with time_slot
- Calendar uses FullCalendar library with month/week/day views
- Events display entity's `display_name` as title

**Overlap Prevention** (optional):
```sql
-- Prevent double-booking via GIST exclusion constraint
ALTER TABLE reservations
  ADD CONSTRAINT no_overlaps
    EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&);
```

See `docs/development/CALENDAR_INTEGRATION.md` for complete implementation guide.

---

### Map Visualization

Enable map visualization on List pages for entities with `geography(Point, 4326)` properties.

**Requirements**:
- Table must have `geography(Point, 4326)` column (PostGIS)
- Computed field function returning WKT: `<column_name>_text()`

**Setup**:
```sql
-- 1. Add geography column
ALTER TABLE issues
  ADD COLUMN location geography(Point, 4326);

-- 2. Create computed field function (required for PostgREST)
CREATE OR REPLACE FUNCTION issues_location_text(issues)
RETURNS TEXT AS $$
  SELECT postgis.ST_AsText($1.location);
$$ LANGUAGE SQL STABLE;

-- 3. Enable map on List page
UPDATE metadata.entities SET
  show_on_map = TRUE,
  map_property_name = 'location'
WHERE table_name = 'issues';
```

**Behavior**:
- List page shows toggle button to switch between table/map views
- Map displays markers for all records with non-NULL location
- Clicking marker opens popup with entity link
- Dark mode automatically switches to ESRI World Dark Gray tiles

**Data Format**:
- Insert/Update: EWKT `"SRID=4326;POINT(lng lat)"`
- Read: WKT `"POINT(lng lat)"` (via computed field)

---

### Notification System

**Version**: v0.11.0+

Send multi-channel notifications (email, SMS) to users using database-managed templates and a River-based microservice.

**Features**:
- Database-managed templates with Go template syntax
- Multi-channel delivery (email via AWS SES, SMS in Phase 2)
- Template validation and HTML preview UI
- User notification preferences
- Polymorphic entity references (link notifications to any entity)
- Automatic retries with exponential backoff

**Requirements**:
- Civic OS v0.11.0+ (notification worker + schema)
- AWS SES account with verified sender email
- PostgreSQL database with River queue (`metadata.river_job`)

#### Email Sender Configuration

Configure the consolidated worker's email sender via environment variables:

```bash
# Required
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USERNAME=your-smtp-username
SMTP_PASSWORD=your-smtp-password

# Sender address (v0.25.0+ supports display names)
SMTP_FROM="Mott Park Reservations" <noreply@mottpark.org>

# Optional: Reply-To address (v0.25.0+)
SMTP_REPLY_TO=reservations@mottpark.org
```

**Display Name Support (v0.25.0+)**: Use RFC 5322 format for branded emails:
- Plain email: `SMTP_FROM=noreply@example.com`
- With name: `SMTP_FROM="Your App Name" <noreply@example.com>`

**Startup Validation**: Invalid `SMTP_FROM` or `SMTP_REPLY_TO` values cause the worker to fail immediately with a clear error, preventing silent email delivery failures.

See `docs/development/NOTIFICATIONS.md` for complete AWS SES setup and troubleshooting.

#### Creating Notification Templates

**Method 1: Template Management UI** (recommended for non-technical users)

1. Navigate to `/notifications/templates` (admin-only)
2. Click "Create Template"
3. Fill in template details:
   - **Name**: Unique identifier (e.g., `issue_created`)
   - **Description**: Human-readable description
   - **Entity Type**: Expected entity table name (documentation only)
   - **Subject**: Email subject line (Go template syntax)
   - **HTML Body**: Email HTML body (Go template with XSS protection)
   - **Text Body**: Plain text email fallback
   - **SMS** (optional): SMS message for Phase 2
4. Use live preview panel to test templates with sample data
5. Real-time validation shows syntax errors as you type
6. Save template

**Method 2: SQL INSERT** (recommended for seed scripts)

```sql
INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template
) VALUES (
    'issue_created',
    'Notify assigned user when new issue is created',
    'issues',
    -- Subject (text/template)
    'New issue assigned: {{.Entity.display_name}}',
    -- HTML (html/template with XSS protection)
    '<div style="font-family: Arial, sans-serif;">
      <h2 style="color: #2563eb;">New Issue Assigned</h2>
      <p>You have been assigned to: <strong>{{.Entity.display_name}}</strong></p>
      {{if .Entity.severity}}
      <p><strong>Severity:</strong> {{.Entity.severity}}/5</p>
      {{end}}
      {{if .Entity.description}}
      <p><strong>Description:</strong> {{.Entity.description}}</p>
      {{end}}
      <p>
        <a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}"
           style="display: inline-block; background-color: #2563eb; color: white;
                  padding: 12px 24px; text-decoration: none; border-radius: 4px;">
          View Issue
        </a>
      </p>
      <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">
        This is an automated notification.
      </p>
    </div>',
    -- Text (text/template, plain text fallback)
    'New Issue Assigned

You have been assigned to: {{.Entity.display_name}}
{{if .Entity.severity}}
Severity: {{.Entity.severity}}/5
{{end}}
{{if .Entity.description}}
Description: {{.Entity.description}}
{{end}}

View at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}

---
This is an automated notification.'
);
```

**Go Template Syntax Quick Reference**:

```handlebars
{{.Entity.field_name}}                  # Access entity data
{{.Metadata.site_url}}                  # Site URL for links

{{if .Entity.field}}                    # Conditional rendering
  Field value: {{.Entity.field}}
{{end}}

{{if eq .Entity.status "urgent"}}       # Comparison
  ⚠️ URGENT
{{else}}
  Status: {{.Entity.status}}
{{end}}

{{range .Entity.items}}                 # Iteration
  - {{.name}}
{{end}}
```

**Template Context**:
- `Entity` - Entity data passed to `create_notification()` as JSONB
- `Metadata.site_url` - Application URL from `SITE_URL` environment variable

See [Go template documentation](https://pkg.go.dev/text/template) for full syntax reference.

#### Sending Notifications

**Pattern 1: Automatic Notifications via Triggers** (recommended)

Create PostgreSQL triggers that automatically send notifications when events occur:

```sql
-- Send notification when issue is created with assigned user
CREATE OR REPLACE FUNCTION notify_issue_created()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_issue_data JSONB;
BEGIN
    -- Only send if issue has assigned user
    IF NEW.assigned_user_id IS NOT NULL THEN
        -- Build issue data with embedded status relationship
        SELECT jsonb_build_object(
            'id', NEW.id,
            'display_name', NEW.display_name,
            'description', NEW.description,
            'severity', NEW.severity,
            'status', jsonb_build_object(
                'id', s.id,
                'display_name', s.display_name,
                'color', s.color
            )
        )
        INTO v_issue_data
        FROM statuses s
        WHERE s.id = NEW.status_id;

        -- Create notification (auto-enqueues River job)
        PERFORM create_notification(
            p_user_id := NEW.assigned_user_id,
            p_template_name := 'issue_created',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data,
            p_channels := ARRAY['email']::TEXT[]
        );
    END IF;

    RETURN NEW;
END;
$$;

-- Attach trigger
CREATE TRIGGER issue_created_notification_trigger
    AFTER INSERT ON issues
    FOR EACH ROW
    EXECUTE FUNCTION notify_issue_created();
```

**Pattern 2: Manual Notification Calls**

Send notifications directly from application code or scheduled jobs:

```sql
-- Send notification to specific user
SELECT create_notification(
    p_user_id := '123e4567-e89b-12d3-a456-426614174000',
    p_template_name := 'issue_created',
    p_entity_type := 'issues',
    p_entity_id := '42',
    p_entity_data := jsonb_build_object(
        'id', 42,
        'display_name', 'Pothole on Main St',
        'severity', 5,
        'description', 'Large pothole needs immediate attention'
    ),
    p_channels := ARRAY['email']
);

-- Batch notifications (e.g., daily digest)
SELECT create_notification(
    p_user_id := user_id,
    p_template_name := 'daily_summary',
    p_entity_type := NULL,  -- No entity reference
    p_entity_id := NULL,
    p_entity_data := jsonb_build_object(
        'date', CURRENT_DATE,
        'unread_count', (SELECT COUNT(*) FROM notifications WHERE user_id = u.id AND read = false),
        'new_issues_count', (SELECT COUNT(*) FROM issues WHERE created_at::date = CURRENT_DATE)
    )
)
FROM civic_os_users u
WHERE u.daily_digest_enabled = TRUE;
```

#### Embedded Relationships in Notifications

When templates need related entity data (e.g., status display name), manually join and construct nested JSONB:

```sql
-- Template accesses nested status: {{.Entity.status.display_name}}
CREATE OR REPLACE FUNCTION notify_issue_status_changed()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_issue_data JSONB;
BEGIN
    -- Only notify if status changed and user assigned
    IF NEW.status_id IS DISTINCT FROM OLD.status_id
       AND NEW.assigned_user_id IS NOT NULL THEN

        -- Fetch issue with embedded status relationship
        SELECT jsonb_build_object(
            'id', NEW.id,
            'display_name', NEW.display_name,
            'status', jsonb_build_object(
                'id', s.id,
                'display_name', s.display_name,
                'color', s.color
            )
        )
        INTO v_issue_data
        FROM statuses s
        WHERE s.id = NEW.status_id;

        PERFORM create_notification(
            p_user_id := NEW.assigned_user_id,
            p_template_name := 'issue_status_changed',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data
        );
    END IF;

    RETURN NEW;
END;
$$;
```

**Template using nested data**:
```handlebars
Subject: Issue status updated: {{.Entity.display_name}}

HTML:
<p>Status changed to:
  <span style="background-color: {{.Entity.status.color}};
                color: white; padding: 4px 8px; border-radius: 4px;">
    {{.Entity.status.display_name}}
  </span>
</p>
```

#### User Notification Preferences

Users can manage notification preferences via `metadata.notification_preferences`:

```sql
-- Disable email notifications
UPDATE metadata.notification_preferences
SET enabled = FALSE
WHERE user_id = current_user_id() AND channel = 'email';

-- Use custom email address
UPDATE metadata.notification_preferences
SET email_address = 'custom@example.com'
WHERE user_id = current_user_id() AND channel = 'email';

-- View notification history
SELECT
    n.created_at,
    n.template_name,
    n.status,
    n.channels_sent,
    t.description
FROM metadata.notifications n
JOIN metadata.notification_templates t ON n.template_name = t.name
WHERE n.user_id = current_user_id()
ORDER BY n.created_at DESC
LIMIT 20;
```

**Default Preferences**: When users are created, a trigger automatically creates default preferences (email enabled). Custom applications can modify this behavior by updating the `create_default_notification_preferences()` trigger function.

#### Monitoring & Troubleshooting

**Check notification status**:
```sql
-- View recent notifications
SELECT
    n.id,
    n.user_id,
    u.email,
    n.template_name,
    n.status,
    n.error_message,
    n.created_at,
    n.sent_at
FROM metadata.notifications n
JOIN metadata.civic_os_users u ON n.user_id = u.id
ORDER BY n.created_at DESC
LIMIT 20;

-- Count notifications by status
SELECT status, COUNT(*)
FROM metadata.notifications
GROUP BY status;
```

**Check River job queue**:
```sql
-- Queue depth (pending notifications)
SELECT COUNT(*)
FROM metadata.river_job
WHERE kind = 'send_notification' AND state = 'available';

-- Failed jobs
SELECT id, state, errors, attempt, max_attempts
FROM metadata.river_job
WHERE kind = 'send_notification' AND state = 'retryable'
ORDER BY scheduled_at DESC
LIMIT 10;
```

**Worker logs**:
```bash
# View consolidated worker logs (includes S3, thumbnail, and notification workers)
docker logs -f civic-os-consolidated-worker

# Check worker is running
docker ps | grep consolidated-worker
```

**Common Issues**:
- **Notifications stuck in pending**: Worker not running or database connection failed
- **Template validation timeout**: ValidationWorker overloaded (check logs)
- **AWS SES authentication errors**: Verify IAM credentials and SES region
- **Emails not delivered**: Check SES sandbox mode (only verified recipients) or SPF/DKIM configuration

See `docs/development/NOTIFICATIONS.md` for complete troubleshooting guide with diagnostics and fixes.

#### Example: Complete Notification Setup

Full example for "Pothole Tracker" domain with two notification types:

```sql
-- 1. Create templates
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
('issue_created', 'Notify assigned user when issue created', 'issues',
    'New issue assigned: {{.Entity.display_name}}',
    '<h2>New Issue Assigned</h2><p>{{.Entity.display_name}}</p><p>Severity: {{.Entity.severity}}/5</p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a>',
    'New Issue: {{.Entity.display_name}}\nSeverity: {{.Entity.severity}}/5\nView: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}'
),
('issue_status_changed', 'Notify when status changes', 'issues',
    'Issue status updated: {{.Entity.display_name}}',
    '<h2>Status Updated</h2><p>{{.Entity.display_name}}</p><p>New Status: {{.Entity.status.display_name}}</p>',
    'Status Updated: {{.Entity.display_name}}\nNew Status: {{.Entity.status.display_name}}'
);

-- 2. Create trigger for issue creation
CREATE OR REPLACE FUNCTION notify_issue_created() RETURNS TRIGGER AS $$
DECLARE v_issue_data JSONB;
BEGIN
    IF NEW.assigned_user_id IS NOT NULL THEN
        SELECT jsonb_build_object('id', NEW.id, 'display_name', NEW.display_name, 'severity', NEW.severity)
        INTO v_issue_data;

        PERFORM create_notification(
            p_user_id := NEW.assigned_user_id,
            p_template_name := 'issue_created',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_created_notification_trigger
    AFTER INSERT ON issues FOR EACH ROW EXECUTE FUNCTION notify_issue_created();

-- 3. Create trigger for status changes
CREATE OR REPLACE FUNCTION notify_issue_status_changed() RETURNS TRIGGER AS $$
DECLARE v_issue_data JSONB;
BEGIN
    IF NEW.status_id IS DISTINCT FROM OLD.status_id AND NEW.assigned_user_id IS NOT NULL THEN
        SELECT jsonb_build_object('id', NEW.id, 'display_name', NEW.display_name,
            'status', jsonb_build_object('id', s.id, 'display_name', s.display_name))
        INTO v_issue_data FROM statuses s WHERE s.id = NEW.status_id;

        PERFORM create_notification(
            p_user_id := NEW.assigned_user_id,
            p_template_name := 'issue_status_changed',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_status_changed_notification_trigger
    AFTER UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION notify_issue_status_changed();

-- 4. Test notification
INSERT INTO issues (display_name, severity, status_id, assigned_user_id)
VALUES ('Test Issue', 3, 1, (SELECT id FROM civic_os_users LIMIT 1));

-- 5. Verify notification created
SELECT * FROM metadata.notifications ORDER BY created_at DESC LIMIT 1;
```

**Production Deployment**:
1. Apply v0.11.0 migration: `sqitch deploy v0-11-0-add-notifications`
2. Configure environment variables (`AWS_SES_FROM_EMAIL`, `SITE_URL`, AWS credentials)
3. Deploy notification worker service (see `docker-compose.yml` examples)
4. Verify AWS SES sender email and move out of sandbox mode
5. Configure SPF/DKIM DNS records for deliverability

See `docs/development/NOTIFICATIONS.md` for complete architecture, Go worker implementation, AWS SES setup, and Phase 2 roadmap (SMS, bounce handling, unsubscribe mechanism).

### Status Type System

**Version**: v0.15.0+

Framework-provided status and workflow system. Instead of creating separate status lookup tables (e.g., `issue_statuses`, `workpackage_statuses`), integrators use the centralized `metadata.statuses` table with `entity_type` discriminator for type safety.

**Features**:
- Colored badges with `hex_color` for visual status identification
- `is_initial` flag for default status on new records
- `is_terminal` flag for workflow end states
- `sort_order` for dropdown ordering
- `status_key` for stable programmatic references (v0.25.0+)
- Cache invalidation via `schema_cache_versions`
- Frontend auto-detects via `status_entity_type` in `metadata.properties`

**Requirements**:
- Civic OS v0.15.0+ (status schema + migrations)

#### Quick Setup

```sql
-- 1. Register entity type
INSERT INTO metadata.status_types (entity_type, description)
VALUES ('issue', 'Status values for issue tracking');

-- 2. Add status values
INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal)
VALUES
  ('issue', 'Open', '#F59E0B', 1, TRUE, FALSE),
  ('issue', 'In Progress', '#3B82F6', 2, FALSE, FALSE),
  ('issue', 'Resolved', '#22C55E', 3, FALSE, TRUE);

-- 3. Create table with FK (use helper function for default)
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  status_id INT NOT NULL DEFAULT public.get_initial_status('issue') REFERENCES metadata.statuses(id),
  display_name VARCHAR(255) NOT NULL,
  -- other columns...
);

-- 4. Configure column for frontend detection
UPDATE metadata.properties SET status_entity_type = 'issue'
WHERE table_name = 'issues' AND column_name = 'status_id';
```

#### Schema Reference

**`metadata.status_types`** - Registers valid entity types for statuses

| Column | Type | Description |
|--------|------|-------------|
| `entity_type` | NAME | Entity type identifier (PK) |
| `description` | TEXT | Human-readable description |

**`metadata.statuses`** - Status values per entity type

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | SERIAL | auto | Primary key |
| `entity_type` | NAME | required | FK to status_types |
| `status_key` | VARCHAR(50) | auto-generated | Stable snake_case identifier for code references (v0.25.0+) |
| `display_name` | VARCHAR(100) | required | Status label shown in UI |
| `color` | hex_color | '#6B7280' | Badge color (#RRGGBB) |
| `sort_order` | INT | 100 | Dropdown ordering |
| `is_initial` | BOOLEAN | FALSE | Default for new records |
| `is_terminal` | BOOLEAN | FALSE | Workflow end state |

#### Helper Functions

**`get_initial_status(entity_type)`** - Returns the status ID where `is_initial = TRUE` for the given entity type. Use as column default:

```sql
status_id INT NOT NULL DEFAULT public.get_initial_status('issue')
```

**`get_status_id(entity_type, status_key)`** (v0.25.0+) - Returns the status ID for a given entity type and status key. Use this in migrations and RPC functions instead of display_name lookups:

```sql
-- Instead of fragile display_name lookup:
-- UPDATE issues SET status_id = (SELECT id FROM metadata.statuses WHERE display_name = 'Pending')

-- Use stable status_key lookup:
UPDATE issues SET status_id = public.get_status_id('issue', 'pending');
```

#### Status Key (v0.25.0+)

The `status_key` column provides a stable, programmatic identifier for statuses that won't break when display names change. It's auto-generated from `display_name` on INSERT (converted to snake_case: "In Progress" → "in_progress").

**Benefits**:
- Display names can be updated without breaking code
- No hard-coded IDs that differ between environments
- Clear, readable identifiers in migrations and RPC functions

**Usage**:
```sql
-- When inserting, status_key is auto-generated if not provided:
INSERT INTO metadata.statuses (entity_type, display_name) VALUES ('issue', 'In Progress');
-- status_key automatically becomes 'in_progress'

-- Or provide explicitly:
INSERT INTO metadata.statuses (entity_type, display_name, status_key)
VALUES ('issue', 'In Progress', 'in_progress');

-- In RPC functions, use get_status_id() helper:
IF current_status_id = get_status_id('reservation', 'pending') THEN
  UPDATE reservations SET status_id = get_status_id('reservation', 'approved');
END IF;
```

See `docs/development/STATUS_TYPE_SYSTEM.md` for complete design documentation and `examples/community-center/` for working example.

### Entity Action Buttons

**Version**: v0.18.0+

Add metadata-driven action buttons to Detail pages that execute PostgreSQL RPC functions. Perfect for workflow transitions (Approve/Deny), status changes, or any custom business logic.

**Features**:
- Buttons appear in the Detail page action bar alongside Edit/Delete
- Conditional visibility (hide buttons based on record state)
- Conditional enablement (disable with tooltip when not applicable)
- Confirmation modals before execution
- Role-based permissions (managed via Permissions page)
- Customizable icons, colors, and messages
- Responsive overflow to "More" dropdown on small screens

**Requirements**:
- Civic OS v0.18.0+ (entity_actions schema + migrations)
- PostgreSQL RPC function that accepts `p_entity_id BIGINT` and returns `JSONB`

#### Quick Setup

**1. Create your RPC function:**

```sql
CREATE OR REPLACE FUNCTION public.approve_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Your business logic here
  UPDATE my_requests SET status = 'approved' WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Request approved successfully!',
    'refresh', true  -- Reload the page after action
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_request(BIGINT) TO authenticated;
```

**2. Register the action in metadata:**

```sql
INSERT INTO metadata.entity_actions (
  table_name,
  action_name,
  display_name,
  description,
  rpc_function,
  icon,
  button_style,
  sort_order,
  requires_confirmation,
  confirmation_message
) VALUES (
  'my_requests',
  'approve',
  'Approve',
  'Approve this request',
  'approve_request',
  'check_circle',
  'primary',
  10,
  TRUE,
  'Are you sure you want to approve this request?'
);
```

**3. Grant permission to roles:**

```sql
-- Grant to editor and admin roles
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'my_requests'
  AND ea.action_name = 'approve'
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;
```

#### RPC Function Requirements

Your RPC function must:
- Accept `p_entity_id BIGINT` as the first parameter
- Return `JSONB` with at least `success` (boolean) and `message` (string)
- Use `SECURITY DEFINER` if it needs elevated privileges

**Return Object Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the action succeeded |
| `message` | string | Message to display to user |
| `refresh` | boolean | If true, reload the page after action |
| `navigate` | string | URL to navigate to after action (optional) |

**Example with validation:**

```sql
CREATE OR REPLACE FUNCTION public.cancel_order(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order RECORD;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_entity_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  IF v_order.status = 'shipped' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot cancel shipped orders');
  END IF;

  UPDATE orders SET status = 'cancelled' WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Order cancelled', 'refresh', true);
END;
$$;
```

#### Visibility and Enabled Conditions

Control when buttons appear and when they're clickable using JSONB condition expressions.

**Condition Format:**
```json
{
  "field": "status_id",
  "operator": "eq",
  "value": 1
}
```

**Supported Operators:**

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equals | `{"field": "status_id", "operator": "eq", "value": 1}` |
| `ne` | Not equals | `{"field": "status_id", "operator": "ne", "value": 3}` |
| `in` | In array | `{"field": "status_id", "operator": "in", "value": [1, 2]}` |
| `gt`, `lt`, `gte`, `lte` | Comparisons | `{"field": "amount", "operator": "gt", "value": 100}` |
| `is_null` | Is null | `{"field": "cancelled_at", "operator": "is_null"}` |
| `is_not_null` | Is not null | `{"field": "approved_at", "operator": "is_not_null"}` |

**Example with conditions:**

```sql
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, rpc_function,
  icon, button_style, sort_order,
  visibility_condition,    -- When to SHOW the button
  enabled_condition,       -- When button is CLICKABLE
  disabled_tooltip         -- Tooltip when disabled
) VALUES (
  'reservation_requests',
  'approve',
  'Approve',
  'approve_reservation_request',
  'check_circle',
  'primary',
  10,
  -- Hide button if already approved (status_id = 2)
  '{"field": "status_id", "operator": "ne", "value": 2}'::jsonb,
  -- Only enable if pending (status_id = 1)
  '{"field": "status_id", "operator": "eq", "value": 1}'::jsonb,
  'Only pending requests can be approved'
);
```

#### Button Styling

Available `button_style` values (DaisyUI 5):

| Style | Use Case | Color |
|-------|----------|-------|
| `primary` | Main/recommended actions | Theme primary |
| `secondary` | Alternative actions | Theme secondary |
| `accent` | Highlighted actions | Theme accent |
| `success` | Positive outcomes | Green |
| `warning` | Caution actions | Yellow/Orange |
| `error` | Destructive actions | Red |
| `ghost` | Subtle/minimal | Transparent |
| `neutral` | Neutral actions | Gray |
| `info` | Informational | Blue |

**Icons**: Use any [Material Symbols](https://fonts.google.com/icons) name (e.g., `check_circle`, `cancel`, `event_busy`).

#### Schema Reference

**`metadata.entity_actions`** - Action definitions

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Primary key |
| `table_name` | VARCHAR | Entity this action applies to |
| `action_name` | VARCHAR | Unique identifier (e.g., 'approve') |
| `display_name` | VARCHAR | Button label |
| `description` | TEXT | Tooltip when enabled |
| `rpc_function` | VARCHAR | PostgreSQL function to call |
| `icon` | VARCHAR | Material Symbols icon name |
| `button_style` | VARCHAR | DaisyUI button color |
| `sort_order` | INT | Display order (lower = first) |
| `requires_confirmation` | BOOLEAN | Show confirmation modal |
| `confirmation_message` | TEXT | Modal message |
| `visibility_condition` | JSONB | When to show button |
| `enabled_condition` | JSONB | When button is clickable |
| `disabled_tooltip` | TEXT | Tooltip when disabled |
| `default_success_message` | TEXT | Fallback success message |
| `refresh_after_action` | BOOLEAN | Reload page after action |
| `show_on_detail` | BOOLEAN | Show on Detail page (default: true) |

**`metadata.entity_action_roles`** - Permission grants

| Column | Type | Description |
|--------|------|-------------|
| `entity_action_id` | INT | FK to entity_actions |
| `role_id` | SMALLINT | FK to roles |
| `created_at` | TIMESTAMPTZ | Grant timestamp |

**Note**: Admins can execute any action regardless of role grants.

#### Managing Permissions via UI

Entity action permissions can be managed on the **Permissions page** (`/permissions`):

1. Select a role from the dropdown
2. Click the "Entity Actions" tab
3. Check/uncheck actions to grant/revoke permission

#### Complete Example

See `examples/community-center/init-scripts/13_entity_actions.sql` for a complete implementation with:
- Approve/Deny/Cancel workflow for reservation requests
- Status-based visibility and enabled conditions
- Triggers that create/delete reservations on approval/cancellation
- Role permission grants

### Recurring Time Slots

**Version**: v0.19.0+

Enable RFC 5545 RRULE-compliant recurring schedules for time-slotted entities. Supports patterns like "Every Tuesday and Thursday at 6pm", "First Monday of each month", or "Daily for 10 occurrences".

**Features**:
- Entity-level configuration via `supports_recurring` and `recurring_property_name`
- RRULE validation with DoS prevention (max 1000 occurrences, 5-year horizon)
- Series management UI at `/admin/recurring-schedules` (editor/admin only)
- Conflict preview before series creation
- Edit scope dialogs: "This only", "This and future", "All"
- Exception handling (cancel, reschedule, modify individual occurrences)
- Go worker for background instance expansion

**Requirements**:
- Civic OS v0.19.0+ (recurring schema + migrations)
- Entity must have a `time_slot` column
- `btree_gist` extension (included in Civic OS)

#### Enabling Recurring for an Entity

```sql
-- 1. Enable recurring in metadata.entities
UPDATE metadata.entities SET
  supports_recurring = TRUE,
  recurring_property_name = 'time_slot'
WHERE table_name = 'reservation_requests';

-- Or via upsert_entity_metadata RPC
SELECT upsert_entity_metadata(
  p_table_name := 'reservation_requests',
  p_display_name := 'Reservation Requests',
  p_description := 'Requests for resource reservations',
  p_sort_order := 10,
  p_supports_recurring := TRUE,
  p_recurring_property_name := 'time_slot'
);
```

#### Granting Series Permissions

Series management requires permissions on the metadata tables:

```sql
-- Grant to editor role
DO $$
DECLARE
  v_editor_id SMALLINT;
BEGIN
  SELECT id INTO v_editor_id FROM metadata.roles WHERE display_name = 'editor';

  -- Series groups (containers)
  PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'read', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'create', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'update', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'delete', TRUE);

  -- Series (RRULE definitions)
  PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'read', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'create', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'update', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'delete', TRUE);

  -- Instances (junction to entities)
  PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'read', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'create', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'update', TRUE);
  PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'delete', TRUE);
END $$;
```

#### Creating a Recurring Series

```sql
-- Create weekly yoga class (Tuesdays and Thursdays, 6-7pm)
SELECT create_recurring_series(
  p_group_name := 'Weekly Yoga Class',
  p_group_description := 'Community yoga sessions',
  p_group_color := '#10B981',
  p_entity_table := 'reservation_requests',
  p_entity_template := jsonb_build_object(
    'resource_id', 1,
    'purpose', 'Weekly Yoga Class',
    'requested_by', 'user-uuid-here',
    'attendee_count', 15
  ),
  p_rrule := 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=12',
  p_dtstart := '2025-01-07T18:00:00'::timestamptz,
  p_duration := 'PT1H',  -- 1 hour duration
  p_timezone := 'America/New_York',
  p_time_slot_property := 'time_slot',
  p_expand_now := TRUE,
  p_skip_conflicts := TRUE
);
```

#### Core Tables

| Table | Purpose |
|-------|---------|
| `metadata.time_slot_series_groups` | User-facing containers with name, description, color |
| `metadata.time_slot_series` | RRULE definitions, entity templates, version tracking |
| `metadata.time_slot_instances` | Junction mapping series occurrences to entity records |

#### Key RPCs

| Function | Purpose |
|----------|---------|
| `create_recurring_series()` | Create group + series + expand instances |
| `expand_series_instances()` | On-demand expansion with conflict detection |
| `preview_recurring_conflicts()` | Check conflicts before creation |
| `split_series_from_date()` | "This and future" edits |
| `update_series_template()` | "All" edits |
| `cancel_series_occurrence()` | Mark single instance as cancelled |

#### Complete Example

See `examples/community-center/init-scripts/14_recurring_reservations.sql` for a complete implementation with:
- Entity configuration for recurring reservation requests
- Permission grants for editor role
- Sample series (Weekly Yoga, Monthly Board Meeting)
- RRULE patterns for weekly and monthly recurrence

See `docs/notes/RECURRING_TIMESLOT_DESIGN.md` for complete architecture documentation.

### Entity Notes System

**Version**: v0.16.0+

Add first-class notes/comments to any entity via metadata configuration. Supports both human-authored notes and system-generated notes (e.g., status change audit trail).

**Features**:
- Opt-in per entity via `enable_notes` flag in `metadata.entities`
- Virtual permissions pattern (`{entity}:notes`) for fine-grained access control
- Markdown support (bold, italic, links) with sanitized rendering
- System notes with "Auto" badge for trigger-generated content
- User display with full name and avatar
- Excel export with optional "Notes" worksheet
- RLS-enforced edit/delete (own notes only)

**Requirements**:
- Civic OS v0.16.0+ (notes schema + migrations)
- Entity must exist in `metadata.entities`

#### Enabling Notes for an Entity

```sql
-- 1. Enable notes for the entity
UPDATE metadata.entities
SET enable_notes = TRUE
WHERE table_name = 'reservations';

-- 2. Grant permissions to roles (virtual permission pattern)
SELECT set_role_permission('editor', 'reservations:notes', 'create', TRUE);
SELECT set_role_permission('editor', 'reservations:notes', 'read', TRUE);
SELECT set_role_permission('user', 'reservations:notes', 'read', TRUE);
```

After enabling, the Notes section appears on Detail pages for that entity. Users with `read` permission can view notes; users with `create` permission can add notes and edit/delete their own.

#### Permission Model

Notes use virtual permissions with restricted operations:

| Permission | Effect |
|------------|--------|
| `{entity}:notes:read` | View all notes for entity records |
| `{entity}:notes:create` | Add new notes, edit/delete own notes |

**Note**: `update` and `delete` are not separate permissions. Users with `create` permission can edit/delete only their own notes (enforced by RLS).

The Permissions admin page (`/permissions`) automatically shows only Read/Create checkboxes for `:notes` permissions.

#### System Notes (Audit Trail)

Create automatic notes when entity state changes using PostgreSQL triggers:

```sql
-- Generic status change note function (reusable)
CREATE OR REPLACE FUNCTION add_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_status TEXT;
    v_new_status TEXT;
BEGIN
    SELECT display_name INTO v_old_status FROM metadata.statuses WHERE id = OLD.status_id;
    SELECT display_name INTO v_new_status FROM metadata.statuses WHERE id = NEW.status_id;

    PERFORM create_entity_note(
        p_entity_type := TG_TABLE_NAME::NAME,
        p_entity_id := NEW.id::TEXT,
        p_content := format('Status changed from **%s** to **%s**', v_old_status, v_new_status),
        p_note_type := 'system',
        p_author_id := current_user_id()
    );

    RETURN NEW;
END;
$$;

-- Attach to specific entity
CREATE TRIGGER reservations_status_change_note
    AFTER UPDATE OF status_id ON reservations
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION add_status_change_note();
```

System notes display with an "Auto" badge and distinct styling to differentiate from human notes.

#### Excel Export with Notes

When exporting entities with notes enabled:
1. User clicks Export button
2. Modal appears with "Include notes" checkbox (checked by default)
3. If checked, export includes a second "Notes" worksheet

Notes worksheet columns:
| Column | Description |
|--------|-------------|
| Record ID | The entity record ID (e.g., reservation ID) |
| Note ID | Unique note identifier |
| Author | User's full name (falls back to display name) |
| Date | Note creation timestamp |
| Type | "Note" for human notes, "System" for auto-generated |
| Content | Note text (markdown stripped for Excel) |

#### NotesService API

```typescript
import { NotesService } from './services/notes.service';

// Get notes for a single entity record
notesService.getNotes('reservations', '123')
  .subscribe(notes => console.log(notes));

// Get notes for multiple entity records (batch)
notesService.getNotesForEntities('reservations', ['123', '456', '789'])
  .subscribe(notes => console.log(notes));

// Create a note
notesService.createNote('reservations', '123', 'This is my note')
  .subscribe(response => console.log(response));

// Update own note
notesService.updateNote(noteId, 'Updated content')
  .subscribe(response => console.log(response));

// Delete own note
notesService.deleteNote(noteId)
  .subscribe(response => console.log(response));
```

#### EntityNote Interface

```typescript
interface EntityNote {
  id: number;
  entity_type: string;
  entity_id: string;
  author_id: string;
  author?: {
    id: string;
    display_name: string;
    full_name?: string;
  };
  content: string;
  note_type: 'note' | 'system';
  is_internal: boolean;
  created_at: string;
  updated_at: string;
}
```

See `examples/community-center/init-scripts/11_enable_notes.sql` for a complete working example with status change triggers.

### Static Text Blocks

**Version**: v0.17.0+

Add static markdown content to Detail, Create, and Edit pages without database columns. Useful for rental agreements, terms of service, section headers, submission guidelines, help text, and contact information.

**Features**:
- Full Markdown support (headers, lists, bold, italic, links)
- Sort order integration with properties (interspersed positioning)
- Per-page visibility (`show_on_detail`, `show_on_create`, `show_on_edit`)
- Column width control (1-8 grid columns, 8 = full width)
- Drag-and-drop reordering in Property Management UI

**Requirements**:
- Civic OS v0.17.0+ (static text schema + migrations)

#### Adding Static Text

```sql
-- Add rental agreement at bottom of detail/create pages
INSERT INTO metadata.static_text (
  table_name, content, sort_order, column_width,
  show_on_detail, show_on_create, show_on_edit
) VALUES (
  'reservation_requests',
  '## Rental Agreement

By submitting this reservation request, you agree to:
1. Pay all associated fees on time
2. Follow facility rules and guidelines
3. Leave the space in its original condition

*Contact staff with questions.*',
  999,    -- High sort_order = appears after properties
  2,      -- Column width: 2 = full width (default)
  TRUE,   -- Show on detail pages
  TRUE,   -- Show on create forms
  FALSE   -- Hide on edit forms
);

-- Add submission guidelines at TOP of create form only
INSERT INTO metadata.static_text (
  table_name, content, sort_order, column_width,
  show_on_detail, show_on_create, show_on_edit
) VALUES (
  'reservation_requests',
  '### Before You Submit

Please have the following ready:
- Preferred date and time slot
- Purpose of reservation
- Contact phone number',
  5,      -- Low sort_order = appears before properties
  2,
  FALSE,  -- Don't show on detail
  TRUE,   -- Show on create
  FALSE   -- Don't show on edit
);
```

#### Schema Reference

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | SERIAL | auto | Primary key |
| `table_name` | NAME | required | Target entity table name |
| `content` | TEXT | required | Markdown content (max 10,000 chars) |
| `sort_order` | INT | 100 | Position relative to properties |
| `column_width` | SMALLINT | 2 | Width: 1-8 (8 = full width) |
| `show_on_detail` | BOOLEAN | TRUE | Show on detail pages |
| `show_on_create` | BOOLEAN | FALSE | Show on create forms |
| `show_on_edit` | BOOLEAN | FALSE | Show on edit forms |

#### Column Width Examples

| Width | Grid Columns | Use Case |
|-------|--------------|----------|
| 1 | 1/8 | Narrow hint |
| 2 | 2/8 (quarter) | Short text |
| 4 | 4/8 (half) | Side-by-side with property |
| 8 | 8/8 (full) | Full agreements, section dividers |

#### Managing via Property Management UI

Static text blocks appear in the Property Management page (`/property-management`) alongside entity properties. They are styled with a distinct background and can be reordered via drag-and-drop. Sort order changes are saved to the database in real-time.

See `docs/design/STATIC_TEXT_FEATURE.md` for complete implementation details and `examples/community-center/init-scripts/12_static_text_example.sql` for a working example.

### Payment System

**Version**: v0.13.0+

Enable secure payment processing for any entity using metadata-driven configuration with Stripe integration. Payments are displayed as badges on List pages and detailed payment flows on Detail pages.

**Features**:
- Metadata-driven payment initiation (no hardcoded table names)
- Domain-specific payment logic via RPC functions
- Stripe payment intent creation via River-based Go microservice
- Payment status tracking (`pending_intent`, `pending`, `succeeded`, `failed`, `canceled`)
- Automatic retry on failed payments
- Webhook-based status updates
- Support for immediate or deferred capture

**Requirements**:
- Civic OS v0.13.0+ (payment metadata + schema)
- Stripe account with API keys
- PostgreSQL database with River queue (`metadata.river_job`)
- Payment worker service (part of consolidated-worker-go)

#### How It Works

The payment system uses **metadata-driven configuration** to enable payments on any entity without hardcoding table names in the frontend.

**Architecture Overview**:

1. **Payment Infrastructure** (v0.13.0 migrations):
   - `payments.transactions` table - Stores all payment records
   - `payments.payment_transactions` view - Public view with user data joined
   - `metadata.entities.payment_initiation_rpc` column - Stores RPC function name
   - `metadata.entities.payment_capture_mode` column - Stores capture timing
   - `public.schema_entities` view - **Exposes payment metadata to frontend**

2. **Domain-Specific Integration** (your init scripts):
   - Add `payment_transaction_id UUID` FK column to your entity table
   - Create payment initiation RPC with domain-specific cost calculation
   - Configure `payment_initiation_rpc` and `payment_capture_mode` in `metadata.entities`

3. **Frontend Detection** (automatic):
   - Frontend reads `schema_entities` view via PostgREST
   - Detects `Payment` property type from `payment_transaction_id` column
   - Checks `entity.payment_initiation_rpc` to enable "Pay Now" button
   - Calls configured RPC when user clicks button

**Critical: View vs Table Distinction**

The frontend queries `public.schema_entities` **VIEW**, not `metadata.entities` **TABLE** directly. This separation provides:
- **Security**: Views enforce RLS and filter sensitive data
- **Abstraction**: View definitions can change without altering frontend code
- **Performance**: Views aggregate data from multiple tables in one query

The v0.13.0 migration updates BOTH:
- `metadata.entities` table (adds `payment_initiation_rpc`, `payment_capture_mode` columns)
- `public.schema_entities` view (exposes new columns to frontend)

**Without the view update**, the frontend would never receive payment metadata even if it exists in the database table.

#### Adding Payments to an Entity

Follow this pattern to enable payments for any entity (e.g., `reservation_requests`, `orders`, `invoices`):

**Step 1: Add payment_transaction_id column**

```sql
-- Add UUID FK to payments.transactions
ALTER TABLE public.reservation_requests
  ADD COLUMN payment_transaction_id UUID
    REFERENCES payments.transactions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reservation_requests.payment_transaction_id IS
'Link to payment record in payments.transactions. Null if payment not yet initiated.';

-- Create index for payment lookups (required for performance)
CREATE INDEX idx_reservation_requests_payment_id
  ON public.reservation_requests(payment_transaction_id)
  WHERE payment_transaction_id IS NOT NULL;
```

**Step 2: Create domain-specific payment initiation RPC**

All payment RPCs **must follow this standardized pattern**:
- **Parameter**: `p_entity_id` (BIGINT or TEXT depending on entity PK type)
- **Return**: UUID (payment_id from `payments.transactions`)
- **Security**: `SECURITY DEFINER` with proper authorization checks
- **Helpers**: Use `payments.check_existing_payment()` and `payments.create_and_link_payment()` to reduce boilerplate

**Helper Functions** (provided by v0.13.0 migration):

These helper functions reduce boilerplate code (~50 lines per RPC) and prevent common integration errors like duplicate charges or orphaned payment records. **All payment RPCs should use these helpers** instead of implementing idempotency and linking logic manually.

1. **`payments.check_existing_payment(payment_id UUID) RETURNS TEXT`**

   Handles idempotency logic for payment creation. Returns status indicating whether to create new payment, reuse existing, or reject as duplicate.

   **Parameters**:
   - `payment_id` - Existing `payment_transaction_id` from entity (may be NULL)

   **Return Values**:
   - `'create_new'` - No existing payment or previous payment failed/canceled, safe to create new payment
   - `'reuse'` - Payment exists in `pending_intent` or `pending` status, return existing payment_id to user (payment in progress)
   - `'duplicate'` - Payment already succeeded, raise exception to prevent double-charging

   **Usage**:
   ```sql
   v_idempotency_status := payments.check_existing_payment(v_entity.payment_transaction_id);

   IF v_idempotency_status = 'reuse' THEN
     RETURN v_entity.payment_transaction_id;  -- Payment already in progress
   END IF;

   IF v_idempotency_status = 'duplicate' THEN
     RAISE EXCEPTION 'Payment already succeeded for this entity';
   END IF;
   -- v_idempotency_status = 'create_new', proceed to create payment
   ```

   **Why This Matters**: Without proper idempotency checks, users clicking "Pay Now" multiple times could be charged twice. This helper ensures:
   - In-progress payments are reused (prevents duplicate Stripe PaymentIntents)
   - Succeeded payments cannot be retried (prevents double-charging)
   - Failed/canceled payments can be retried (allows recovery from errors)

2. **`payments.create_and_link_payment(...) RETURNS UUID`**

   Creates payment record in `payments.transactions` and atomically links it to your entity table. Handles all boilerplate for status, currency, provider, and user_id initialization.

   **Full Signature**:
   ```sql
   payments.create_and_link_payment(
     entity_table_name NAME,           -- Entity table name (e.g., 'reservation_requests')
     entity_pk_column NAME,             -- Entity PK column name (e.g., 'id')
     entity_pk_value ANYELEMENT,        -- Entity PK value (e.g., 123 or '550e8400-e29b-41d4-a716-446655440000')
     payment_fk_column NAME,            -- Payment FK column name (e.g., 'payment_transaction_id')
     amount NUMERIC,                    -- Payment amount in dollars (e.g., 50.00)
     description TEXT,                  -- Payment description for Stripe (e.g., 'Reservation for Main Hall')
     user_id UUID DEFAULT current_user_id(),  -- User making payment (defaults to current user)
     currency TEXT DEFAULT 'USD'        -- Currency code (defaults to USD)
   ) RETURNS UUID                       -- Returns payment_id from payments.transactions
   ```

   **Parameters Explained**:
   - `entity_table_name` - Your entity's table name (qualified with schema if not `public`)
   - `entity_pk_column` - Primary key column of your entity (usually `'id'`)
   - `entity_pk_value` - The specific entity ID (BIGINT, INT, UUID, or TEXT depending on your PK type)
   - `payment_fk_column` - Name of the UUID FK column linking to `payments.transactions` (usually `'payment_transaction_id'`)
   - `amount` - Payment amount as NUMERIC (e.g., `50.00` for $50.00)
   - `description` - Human-readable description shown in Stripe Dashboard and receipts
   - `user_id` - (Optional) Override user making payment (defaults to `current_user_id()`)
   - `currency` - (Optional) Currency code (defaults to `'USD'`)

   **Usage Example**:
   ```sql
   RETURN payments.create_and_link_payment(
     'reservation_requests',           -- Table name
     'id',                              -- PK column
     p_entity_id,                       -- PK value (from RPC parameter)
     'payment_transaction_id',          -- FK column
     v_cost,                            -- Amount (calculated earlier)
     format('Reservation for %s', v_resource_name)  -- Description
     -- user_id defaults to current_user_id()
     -- currency defaults to 'USD'
   );
   ```

   **What It Does Atomically**:
   - Inserts payment record with `status = 'pending_intent'`, `provider = 'stripe'`
   - Updates entity table to link payment: `UPDATE {table} SET {fk_column} = payment_id WHERE {pk_column} = {pk_value}`
   - Returns payment UUID for RPC to return to frontend
   - Trigger automatically enqueues River job for Stripe PaymentIntent creation

   **Why This Matters**: Manual payment creation requires careful attention to:
   - Setting correct initial status (`pending_intent`, not `pending`)
   - Atomically linking payment to entity (prevents orphaned payments)
   - Using correct user_id (prevents payments attributed to wrong user)
   - Handling different PK types (BIGINT, UUID, etc.) without SQL injection

   This helper handles all edge cases correctly and prevents common errors like orphaned payments or wrong user attribution.

**Example RPC (using helpers)**:

```sql
CREATE OR REPLACE FUNCTION public.initiate_reservation_request_payment(
  p_entity_id BIGINT  -- Standardized parameter name
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request RECORD;
  v_cost NUMERIC(10,2);
  v_idempotency_status TEXT;
  v_description TEXT;
BEGIN
  -- 1. Fetch entity data with row lock (prevent race conditions)
  SELECT rr.*, res.display_name AS resource_name, res.hourly_rate
  INTO v_request
  FROM public.reservation_requests rr
  JOIN public.resources res ON rr.resource_id = res.id
  WHERE rr.id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation request not found: %', p_entity_id;
  END IF;

  -- 2. Authorize: Only entity owner can initiate payment
  IF v_request.requested_by != current_user_id() THEN
    RAISE EXCEPTION 'You can only make payments for your own reservation requests';
  END IF;

  -- 3. Check for existing payment (GENERALIZED HELPER)
  v_idempotency_status := payments.check_existing_payment(v_request.payment_transaction_id);

  IF v_idempotency_status = 'reuse' THEN
    RETURN v_request.payment_transaction_id;  -- Payment in progress
  END IF;

  IF v_idempotency_status = 'duplicate' THEN
    RAISE EXCEPTION 'Payment already succeeded for this request';
  END IF;
  -- v_idempotency_status = 'create_new', fall through

  -- 4. Business validation (domain-specific)
  IF v_request.status_id != 1 THEN
    RAISE EXCEPTION 'Can only pay for pending requests';
  END IF;

  -- 5. Calculate cost (domain-specific logic)
  v_cost := public.calculate_reservation_cost(v_request.resource_id, v_request.time_slot);

  IF v_cost <= 0 THEN
    RAISE EXCEPTION 'Request does not require payment (cost: $%)', v_cost;
  END IF;

  -- 6. Create and link payment (GENERALIZED HELPER)
  v_description := format('Reservation Request for %s - %s',
    v_request.resource_name, v_request.purpose);

  RETURN payments.create_and_link_payment(
    'reservation_requests',      -- Entity table
    'id',                         -- Entity PK column
    p_entity_id,                  -- Entity PK value
    'payment_transaction_id',     -- Payment FK column
    v_cost,                       -- Amount
    v_description                 -- Description
    -- user_id defaults to current_user_id()
    -- currency defaults to 'USD'
  );
END;
$$;

COMMENT ON FUNCTION public.initiate_reservation_request_payment IS
'Initiate payment for reservation request. Uses helper functions to reduce boilerplate
and prevent common errors. Only request owner can initiate. Follows standardized payment
RPC pattern: accepts p_entity_id parameter, returns UUID.';

GRANT EXECUTE ON FUNCTION public.initiate_reservation_request_payment TO authenticated;
```

**Step 3: Configure payment metadata**

This enables the "Pay Now" button on Detail pages:

```sql
-- Configure payment initiation for reservation_requests entity
UPDATE metadata.entities
SET
  payment_initiation_rpc = 'initiate_reservation_request_payment',
  payment_capture_mode = 'immediate'  -- or 'deferred' for manual capture later
WHERE table_name = 'reservation_requests';

-- Configure payment property display (optional - customize labels/visibility)
INSERT INTO metadata.properties (
  table_name, column_name,
  display_name, description,
  sort_order,
  show_on_list, show_on_create, show_on_edit, show_on_detail
) VALUES (
  'reservation_requests', 'payment_transaction_id',
  'Payment', 'Payment transaction for this reservation request',
  100,  -- Show at bottom
  TRUE, FALSE, FALSE, TRUE  -- List + Detail only (not create/edit)
) ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;
```

**Step 4: Grant permissions**

```sql
-- Allow authenticated users to view their own payment transactions
GRANT SELECT ON payments.transactions TO authenticated;

-- RLS policy: Users can only see their own payments
CREATE POLICY "Users see own payments" ON payments.transactions
  FOR SELECT TO authenticated
  USING (user_id = current_user_id());
```

#### Payment Workflow

1. **User creates entity** (e.g., reservation_request) - `payment_transaction_id` is NULL
2. **User clicks "Pay Now"** on Detail page - Framework calls configured RPC (`payment_initiation_rpc`)
3. **RPC validates and creates payment** - Record inserted with `status = 'pending_intent'`
4. **Trigger enqueues River job** - Payment worker creates Stripe PaymentIntent
5. **Worker updates with client_secret** - Status changes to `pending`, UI opens payment modal
6. **User completes payment** - Stripe Elements collects card details
7. **Stripe webhook updates status** - `succeeded`, `failed`, or `canceled`
8. **Domain logic runs** - Your app approves request, sends confirmation, etc.

#### Payment Capture Modes

**Immediate Capture** (default):
```sql
payment_capture_mode = 'immediate'
```
- Funds captured immediately when payment succeeds
- Best for: Digital goods, instant services, non-refundable items

**Deferred Capture**:
```sql
payment_capture_mode = 'deferred'
```
- Funds authorized but not captured (held for up to 7 days)
- Manual capture via Stripe Dashboard or API
- Best for: Reservations that may be canceled, pre-orders, hotel bookings

#### Webhook Architecture

Stripe webhooks update payment status after user completes payment. The webhook flow uses **HTTP endpoints** (not PostgREST RPC) due to Stripe's signature verification requirements.

**Why HTTP Instead of PostgREST?**

Stripe webhooks require access to the **raw request body** for signature verification using HMAC-SHA256. PostgREST processes JSON payloads and doesn't expose the raw body to RPC functions, making signature verification impossible. The payment worker runs a dedicated HTTP server to handle webhook requests directly.

**Webhook Flow**:

1. **Stripe sends webhook** → HTTP POST to `https://your-domain.com/webhooks/stripe`
2. **Worker verifies signature** → Uses `STRIPE_WEBHOOK_SECRET` to verify request authenticity
3. **Worker updates database** → Transaction: insert `metadata.webhooks` + update `payments.transactions` status
4. **Worker responds 200 OK** → Stripe marks webhook as delivered

**Architecture Components**:

```
Stripe → [HTTP: /webhooks/stripe] → Payment Worker → PostgreSQL
                                     - Signature verification
                                     - Idempotent processing
                                     - Transactional updates
```

**Setting Up Webhooks**:

**1. Configure Webhook URL in Stripe Dashboard**

Production:
- URL: `https://your-domain.com/webhooks/stripe`
- Events to send: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`
- Copy the **Signing secret** (starts with `whsec_`)

Development:
- Use Stripe CLI for local testing: `stripe listen --forward-to http://localhost:8081/webhooks/stripe`
- CLI prints signing secret to console

**2. Set Environment Variable**

```bash
# Production (from Stripe Dashboard webhook settings)
STRIPE_WEBHOOK_SECRET=whsec_abc123...

# Development (from Stripe CLI output)
STRIPE_WEBHOOK_SECRET=whsec_xyz789...
```

**3. Verify Worker Configuration**

Check payment worker logs on startup:
```
[Init] Stripe Webhook Secret: whsec_***xyz789
[Init] ✓ Webhook server initialized
[Init] Starting HTTP webhook server...
HTTP Server: Listening on :8080/webhooks/stripe
```

**Testing Webhooks Locally**:

Use Stripe CLI to forward webhooks from Stripe's test environment to your local worker:

```bash
# Start Stripe listener (forwards webhooks to local worker)
stripe listen --forward-to http://localhost:8081/webhooks/stripe

# In another terminal, trigger test webhook events
stripe trigger payment_intent.succeeded
stripe trigger payment_intent.payment_failed

# Check worker logs for webhook processing
docker logs -f civic-os-consolidated-worker | grep Webhook
```

**Expected output** (successful webhook):
```
[Webhook] Processing event: id=evt_abc123, type=payment_intent.succeeded
[Webhook] Created webhook record: abc-123-def-456
[Webhook] Marking payment pi_xyz789 as succeeded
[Webhook] ✓ Payment pi_xyz789 marked as succeeded
[Webhook] ✓ Event evt_abc123 processed successfully
```

**Webhook Idempotency**:

The webhook handler automatically prevents duplicate processing:
- `metadata.webhooks` table has unique constraint on `(provider, provider_event_id)`
- Duplicate webhooks return 200 OK without processing (Stripe requires 200 for idempotency)
- Check `metadata.webhooks.processed = TRUE` to see which events succeeded

**Verifying Webhook Delivery**:

```sql
-- Check recent webhook events
SELECT
  id,
  event_type,
  signature_verified,
  processed,
  processed_at,
  error_message,
  created_at
FROM metadata.webhooks
WHERE provider = 'stripe'
ORDER BY created_at DESC
LIMIT 10;

-- Find unprocessed webhooks (should be empty in healthy system)
SELECT * FROM metadata.webhooks
WHERE provider = 'stripe' AND processed = FALSE;
```

**Stripe Dashboard**:
- Go to Developers → Webhooks → [Your endpoint]
- View webhook delivery history and retry failed deliveries
- Check response codes (200 = success, 500 = error)

**Common Webhook Issues**:
- **Webhooks not arriving**: Verify endpoint URL in Stripe Dashboard (must be publicly accessible)
- **Signature verification fails**: `STRIPE_WEBHOOK_SECRET` doesn't match webhook signing secret
- **"Payment not found" warnings**: Orphaned PaymentIntent from retry (safe to ignore - see Troubleshooting)

#### Monitoring & Troubleshooting

**Check payment status**:
```sql
-- View recent payments with user details
SELECT
  p.id,
  p.created_at,
  u.display_name AS user_name,
  u.email,
  p.amount,
  p.currency,
  p.status,
  p.description,
  p.error_message
FROM payments.transactions p
JOIN metadata.civic_os_users u ON p.user_id = u.id
ORDER BY p.created_at DESC
LIMIT 20;

-- Count payments by status
SELECT status, COUNT(*), SUM(amount) AS total_amount
FROM payments.transactions
GROUP BY status;
```

**Check River job queue**:
```sql
-- Queue depth (pending payment intent creation)
SELECT COUNT(*)
FROM metadata.river_job
WHERE kind = 'create_payment_intent' AND state = 'available';

-- Failed jobs
SELECT id, state, errors, attempt, max_attempts, args
FROM metadata.river_job
WHERE kind IN ('create_payment_intent', 'handle_payment_webhook')
  AND state = 'retryable'
ORDER BY scheduled_at DESC
LIMIT 10;
```

**Worker logs**:
```bash
# View payment worker logs
docker logs -f civic-os-consolidated-worker | grep -i payment

# Check worker is running
docker ps | grep consolidated-worker
```

**Troubleshooting Guide**:

**Issue 1: Payment Stuck in `pending_intent` Status**

**Symptom**: Payment record created but `provider_client_secret` remains NULL, modal never opens

**Root Causes**:
- Payment worker not running
- Invalid Stripe API key
- River job failed to enqueue
- Job stuck in retry queue

**Diagnostic Steps**:

1. Check if payment worker is running:
```bash
docker ps | grep consolidated-worker
# Should show container with "Up" status

# Check worker logs for errors
docker logs civic-os-consolidated-worker | tail -50
```

2. Query River job queue for stuck jobs:
```sql
-- Check if job was created for this payment
SELECT
  j.id,
  j.state,
  j.attempt,
  j.max_attempts,
  j.errors,
  j.scheduled_at,
  j.args->>'payment_id' AS payment_id
FROM metadata.river_job j
WHERE j.kind = 'create_payment_intent'
  AND j.args->>'payment_id' = 'YOUR_PAYMENT_UUID'  -- Replace with actual payment_id
ORDER BY j.created_at DESC;

-- State meanings:
-- 'available' = waiting to be picked up by worker
-- 'running' = currently processing
-- 'completed' = successfully processed
-- 'retryable' = failed but will retry
-- 'discarded' = failed max attempts
```

3. Check Stripe API key configuration:
```bash
# Verify environment variable is set
docker exec civic-os-consolidated-worker printenv STRIPE_API_KEY
# Should print: sk_test_... or sk_live_...
```

4. Examine job errors:
```sql
-- View error details from failed jobs
SELECT
  id,
  state,
  errors,  -- JSON array of error messages
  attempt,
  max_attempts,
  created_at,
  scheduled_at
FROM metadata.river_job
WHERE kind = 'create_payment_intent'
  AND state IN ('retryable', 'discarded')
ORDER BY created_at DESC
LIMIT 5;
```

**Fix**:
- Worker not running → Start worker: `docker-compose up -d civic-os-consolidated-worker`
- Invalid API key → Update `STRIPE_API_KEY` environment variable and restart worker
- Job discarded → Check `errors` column for Stripe API error, fix root cause, then manually retry payment (user clicks "Pay Now" again)

---

**Issue 2: Payment Modal Doesn't Open (Client Secret NULL)**

**Symptom**: User clicks "Pay Now" but nothing happens, or error appears in browser console

**Root Cause**: CreateIntentJob succeeded but didn't update `provider_client_secret` (should never happen with helper functions)

**Diagnostic Steps**:

1. Check payment record:
```sql
-- Verify client secret was populated
SELECT
  id,
  status,
  provider_payment_id,  -- Stripe PaymentIntent ID (pi_...)
  provider_client_secret,  -- Client secret for Stripe Elements (should NOT be NULL)
  created_at,
  updated_at
FROM payments.transactions
WHERE id = 'YOUR_PAYMENT_UUID';
```

2. Check browser console (F12):
```
Error: Missing clientSecret
  or
Error: Invalid publishable key
```

3. Verify Stripe publishable key:
```typescript
// Check src/environments/environment.ts
stripe: {
  publishableKey: 'pk_test_...'  // Should match your Stripe account
}
```

**Fix**:
- `provider_client_secret` NULL → Check worker logs for CreateIntentJob errors, Stripe API may have rejected intent creation
- "Invalid publishable key" → Update `environment.ts` with correct Stripe publishable key (must match secret key's account)

---

**Issue 3: Webhook Events Not Processing**

**Symptom**: Payment completes in Stripe UI but status never updates to `succeeded` in database

**Root Causes**:
- Webhook URL not configured in Stripe Dashboard
- Incorrect `STRIPE_WEBHOOK_SECRET`
- Worker HTTP server not accessible from internet (production) or Stripe CLI not running (development)

**Diagnostic Steps**:

1. Check if webhook record was created:
```sql
-- Check recent webhook events
SELECT
  id,
  event_type,
  signature_verified,
  processed,
  error_message,
  created_at
FROM metadata.webhooks
WHERE provider = 'stripe'
ORDER BY created_at DESC
LIMIT 10;

-- If no records → webhooks not reaching worker
-- If signature_verified = FALSE → wrong STRIPE_WEBHOOK_SECRET
-- If processed = FALSE → check error_message column
```

2. Check Stripe Dashboard webhook delivery:
- Go to Developers → Webhooks → [Your endpoint]
- Click on recent events to see response codes
- 200 = success, 401 = signature verification failed, 500 = worker error

3. Verify webhook endpoint configuration:
```bash
# Production: Check environment variable
docker exec civic-os-consolidated-worker printenv STRIPE_WEBHOOK_SECRET
# Should print: whsec_...

# Development: Verify Stripe CLI is running
ps aux | grep "stripe listen"
```

4. Test webhook processing manually:
```bash
# Trigger test webhook
stripe trigger payment_intent.succeeded

# Check worker logs immediately
docker logs -f civic-os-consolidated-worker | grep Webhook
```

**Fix**:
- No webhook records → Configure webhook URL in Stripe Dashboard (production) or start `stripe listen` (development)
- Signature verification fails → Copy correct signing secret from Stripe Dashboard webhook settings
- Worker error → Check `error_message` in `metadata.webhooks` table, worker logs for stack trace

---

**Issue 4: Orphaned PaymentIntent Warning in Logs**

**Symptom**: Worker logs show "⚠ Payment pi_xyz789 not found (likely orphaned from retry)"

**Root Cause**: User retried failed payment, creating new payment record with new Stripe PaymentIntent. Old PaymentIntent may still complete if user had payment form open.

**Is This Normal?** YES - This is expected behavior and safe to ignore.

**Why It Happens**:
1. User initiates payment → Creates payment record A with PaymentIntent A
2. Payment fails (card declined, network error, etc.)
3. User clicks "Retry Payment" → Creates NEW payment record B with NEW PaymentIntent B
4. Stripe webhook for OLD PaymentIntent A still arrives (user had form open, finally submitted)
5. Worker can't find payment record for PaymentIntent A (it was replaced by B)
6. Worker logs warning and returns 200 OK (tells Stripe "handled successfully, don't retry")

**Diagnostic Query**:
```sql
-- Find abandoned payment records (replaced by retries)
SELECT
  p1.id AS old_payment_id,
  p1.provider_payment_id AS old_payment_intent,
  p1.status AS old_status,
  p1.created_at AS old_created_at,
  p2.id AS new_payment_id,
  p2.provider_payment_id AS new_payment_intent,
  p2.status AS new_status,
  p2.created_at AS new_created_at
FROM payments.transactions p1
JOIN payments.transactions p2 ON p1.user_id = p2.user_id
WHERE p1.status IN ('failed', 'canceled')
  AND p2.status IN ('succeeded', 'pending')
  AND p2.created_at > p1.created_at
  AND p1.description = p2.description  -- Same entity
ORDER BY p1.created_at DESC;
```

**Fix**: No action required - this is intentional audit trail preservation.

---

**Issue 5: Payment Already Succeeded Error**

**Symptom**: User clicks "Pay Now" but gets error "Payment already succeeded for this request"

**Root Cause**: Idempotency check detected completed payment, preventing duplicate charge (CORRECT BEHAVIOR)

**Is This an Error?** NO - This is the helper function protecting against double-charging.

**Diagnostic Query**:
```sql
-- Verify payment succeeded
SELECT
  id,
  status,
  amount,
  description,
  provider_payment_id,
  created_at,
  updated_at
FROM payments.transactions
WHERE id = (
  SELECT payment_transaction_id
  FROM reservation_requests  -- Replace with your entity table
  WHERE id = YOUR_ENTITY_ID
);
```

**Fix**:
- If status = 'succeeded' → Payment completed successfully, no action needed
- If status = 'failed'/'canceled' → This shouldn't happen (indicates bug in `check_existing_payment` logic)

---

**General Debugging Tips**:

1. **Enable debug logging** in worker (if available):
```bash
# Set log level to debug
docker-compose exec civic-os-consolidated-worker sh -c 'export LOG_LEVEL=debug'
```

2. **Query payment timeline**:
```sql
-- See full lifecycle of a payment
SELECT
  'Payment Created' AS event,
  p.created_at AS timestamp,
  p.status
FROM payments.transactions p
WHERE p.id = 'YOUR_PAYMENT_UUID'

UNION ALL

SELECT
  'Job Enqueued' AS event,
  j.created_at AS timestamp,
  j.state AS status
FROM metadata.river_job j
WHERE j.kind = 'create_payment_intent'
  AND j.args->>'payment_id' = 'YOUR_PAYMENT_UUID'

UNION ALL

SELECT
  'Webhook Received' AS event,
  w.created_at AS timestamp,
  w.event_type AS status
FROM metadata.webhooks w
WHERE w.payload->>'data'->>'object'->>'id' = 'YOUR_STRIPE_PAYMENT_INTENT_ID'

ORDER BY timestamp;
```

3. **Check Stripe Dashboard** for payment details, error messages, and webhook delivery status

See `docs/development/PAYMENT_POC_IMPLEMENTATION.md` for complete architecture, testing guide, and Phase 2 roadmap (polymorphic payments, multiple payments per entity).

#### Example: Complete Payment Setup

Full example for "Community Center" reservation system:

```sql
-- 1. Add payment column to reservation_requests (already done in 01_reservations_schema.sql)
ALTER TABLE public.reservation_requests
  ADD COLUMN payment_transaction_id UUID
    REFERENCES payments.transactions(id) ON DELETE SET NULL;

-- 2. Create cost calculation helper (domain logic)
CREATE FUNCTION public.calculate_reservation_cost(
  p_resource_id INT,
  p_time_slot time_slot
) RETURNS NUMERIC(10,2) AS $$
DECLARE
  v_hourly_rate MONEY;
  v_duration_hours NUMERIC;
BEGIN
  SELECT hourly_rate INTO v_hourly_rate
  FROM public.resources WHERE id = p_resource_id;

  IF v_hourly_rate IS NULL OR v_hourly_rate::numeric <= 0 THEN
    RETURN 0.00;  -- Free resource
  END IF;

  v_duration_hours := EXTRACT(EPOCH FROM (
    upper(p_time_slot::tstzrange) - lower(p_time_slot::tstzrange)
  )) / 3600.0;

  RETURN ROUND(v_hourly_rate::numeric * v_duration_hours, 2);
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. Create payment initiation RPC (see Step 2 above for full implementation)
CREATE FUNCTION public.initiate_reservation_request_payment(p_entity_id BIGINT)
RETURNS UUID AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Configure metadata
UPDATE metadata.entities
SET
  payment_initiation_rpc = 'initiate_reservation_request_payment',
  payment_capture_mode = 'immediate'
WHERE table_name = 'reservation_requests';

-- 5. Test payment flow
-- (a) Create test resource with hourly rate
INSERT INTO resources (display_name, hourly_rate) VALUES ('Test Room', 50.00);

-- (b) Create reservation request
INSERT INTO reservation_requests (resource_id, requested_by, time_slot, purpose)
VALUES (
  (SELECT id FROM resources WHERE display_name = 'Test Room'),
  current_user_id(),
  '[2025-03-15 14:00:00-05, 2025-03-15 16:00:00-05)'::time_slot,
  'Team Meeting'
);

-- (c) Initiate payment (simulates "Pay Now" button click)
SELECT public.initiate_reservation_request_payment(
  (SELECT id FROM reservation_requests ORDER BY created_at DESC LIMIT 1)
);

-- (d) Verify payment created
SELECT * FROM payments.transactions ORDER BY created_at DESC LIMIT 1;
```

**Production Deployment**:
1. Apply v0.13.0 migration: `sqitch deploy v0-13-0-add-payment-metadata`
2. Configure environment variables (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`)
3. Deploy consolidated worker service (includes payment workers)
4. Configure Stripe webhook endpoint: `https://your-domain.com/rpc/process_payment_webhook`
5. Test with Stripe test mode before going live
6. Monitor payment success rate and failed jobs

See `examples/community-center/init-scripts/10_payment_integration.sql` for working reference implementation.

#### Processing Fees

**Version**: v0.21.0+

Enable transparent, configurable processing fees that pass credit card costs to customers. Fees are calculated in the payment worker, stored in the database for auditing, and displayed as a breakdown in the checkout UI.

**Formula**: `total = base + (base × percent/100) + flat_cents/100`

**Example**: $100 base + 2.9% + $0.30 = $103.20 total

**Configuration** (Environment Variables):

| Variable | Default | Description |
|----------|---------|-------------|
| `PROCESSING_FEE_ENABLED` | `false` | Enable/disable fee pass-through |
| `PROCESSING_FEE_PERCENT` | `0` | Percentage fee (e.g., `2.9` for 2.9%) |
| `PROCESSING_FEE_FLAT_CENTS` | `0` | Flat fee in cents (e.g., `30` for $0.30) |
| `PROCESSING_FEE_REFUNDABLE` | `false` | Whether fee is refundable |

**Refund Behavior**:

- `PROCESSING_FEE_REFUNDABLE=false` (default): Max refund = base amount only. Processing fee is retained even on full refund.
- `PROCESSING_FEE_REFUNDABLE=true`: Max refund = total amount. Fee is included in refunds.

**Database Columns** (added by v0.21.0 migration):

| Column | Type | Description |
|--------|------|-------------|
| `processing_fee` | NUMERIC(10,2) | Calculated fee amount |
| `total_amount` | NUMERIC(10,2) | Generated: `amount + processing_fee` |
| `fee_percent` | NUMERIC(5,3) | Rate applied (for audit trail) |
| `fee_flat_cents` | INTEGER | Flat fee applied (for audit trail) |
| `fee_refundable` | BOOLEAN | Whether fee was refundable at payment time |
| `max_refundable` | NUMERIC(10,2) | Generated: max refundable amount |

**Frontend Display**:

When processing fees are enabled, the checkout modal automatically shows a fee breakdown:

```
Payment Summary
─────────────────────
Amount:           $100.00
Processing Fee:     $3.20
─────────────────────
Total:            $103.20
```

If fees are disabled or zero, only the total is displayed (no breakdown).

**Deployment**:

1. **Deploy v0.21.0 migration** - Adds fee columns with safe defaults (`processing_fee = 0`)
2. **Deploy payment worker** - With `PROCESSING_FEE_ENABLED=false` initially
3. **Deploy frontend** - Handles both old and new payment data gracefully
4. **Enable fees** - Set `PROCESSING_FEE_ENABLED=true` with desired rates

**Rollback**: Set `PROCESSING_FEE_ENABLED=false` - new payments have no fee, existing fee data preserved.

**Example Configuration** (Kubernetes ConfigMap):

```yaml
# k8s/configmap.yaml
data:
  PROCESSING_FEE_ENABLED: "true"
  PROCESSING_FEE_PERCENT: "2.9"
  PROCESSING_FEE_FLAT_CENTS: "30"
  PROCESSING_FEE_REFUNDABLE: "false"
```

**Important Notes**:

- Fee configuration is stored per-payment (`fee_percent`, `fee_flat_cents`, `fee_refundable`), so changing config doesn't affect past payments
- The `max_refundable` computed column ensures refund validation respects the fee policy at time of payment
- Stripe's minimum payment is $0.50 - verify your base amounts meet this after fees are added
- Fee calculation uses banker's rounding for consistent cent-level precision

### Scheduled Jobs System

**Version**: v0.22.0+

Execute SQL functions on a cron-based schedule using a metadata-driven job system. Perfect for daily cleanup tasks, periodic notifications, scheduled reports, or any recurring database operations.

**Features**:
- Metadata-driven job configuration (no code changes needed)
- Cron expression scheduling (5-field format)
- Per-job timezone support for DST handling
- Automatic catch-up for missed jobs (worker downtime)
- Run history with timing and results
- RPC pattern for structured results

**Requirements**:
- Civic OS v0.22.0+ (scheduled jobs schema)
- Consolidated worker service (includes scheduler)
- PostgreSQL database with River queue (`metadata.river_job`)

#### How It Works

The scheduled jobs system uses a **Scheduler + Executor pattern**:

1. **Scheduler** runs every minute via Go ticker (in consolidated-worker only)
   - Reads all enabled jobs from `metadata.scheduled_jobs`
   - Parses cron expressions with timezone awareness
   - Finds any due or overdue jobs (not just jobs due that minute)
   - Queues execution jobs for each due job in River queue

2. **Executor Worker** (River job) receives queued jobs
   - Executes the configured SQL function dynamically
   - Records execution in `metadata.scheduled_job_runs`
   - Updates `last_run_at` on the job configuration
   - Logs success/failure with timing

**Catch-up Behavior**: If the worker was down at 8 AM when a job was scheduled, it will run that job when it comes back up. Duplicate prevention via `unique_key` ensures the same scheduled time is never executed twice.

> **Scaling Note**: The scheduled jobs scheduler runs in a single consolidated-worker instance. If you scale to multiple instances, the scheduler runs on each, but job deduplication prevents duplicate execution. For large-scale deployments, see `docs/notes/SCHEDULED_JOBS_DESIGN.md` for guidance on River leader election configuration.

#### Quick Setup

**Step 1: Create your scheduled function**

All scheduled functions **must** return JSONB with `success` (boolean) and `message` (string):

```sql
CREATE OR REPLACE FUNCTION run_daily_cleanup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_deleted INT;
BEGIN
    -- Your cleanup logic
    DELETE FROM some_temp_table
    WHERE created_at < NOW() - INTERVAL '30 days';

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'message', format('Deleted %s old records', v_deleted),
        'details', jsonb_build_object('deleted_count', v_deleted)
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', SQLERRM,
        'details', jsonb_build_object('sqlstate', SQLSTATE)
    );
END;
$$;
```

**Function Contract:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | boolean | Yes | Whether the job completed successfully |
| `message` | string | Yes | Human-readable result description |
| `details` | object | No | Additional structured data for debugging |

**How Results Are Stored in `scheduled_job_runs`:**

| Scenario | `success` | `message` | `details` |
|----------|-----------|-----------|-----------|
| Function returns normally | From function | From function | Entire function response |
| Function throws exception | `false` | PostgreSQL error text | `NULL` |

> **Best Practice**: Always wrap your function in an exception handler. This gives you control over error messages and allows you to populate `details` with debugging info. Without a handler, unhandled exceptions result in `details = NULL`.

**Step 2: Register the job**

```sql
INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES (
    'daily_cleanup',
    'run_daily_cleanup',
    '0 3 * * *',           -- 3 AM daily
    'America/New_York',    -- Eastern time
    'Clean up temporary records older than 30 days'
);
```

**Step 3: Monitor execution**

```sql
-- Quick status overview
SELECT name, enabled, last_run_at, last_run_success, total_runs, success_rate_percent
FROM scheduled_job_status;

-- Recent run history
SELECT started_at, completed_at, success, message, triggered_by
FROM metadata.scheduled_job_runs
WHERE job_id = (SELECT id FROM metadata.scheduled_jobs WHERE name = 'daily_cleanup')
ORDER BY started_at DESC
LIMIT 10;
```

#### Cron Expression Reference

Standard 5-field cron format: `minute hour day-of-month month day-of-week`

| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Daily at 8:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 * * 0` | Weekly on Sunday at midnight |
| `0 9 1 * *` | Monthly on the 1st at 9:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |

#### Function Contract

Scheduled functions **MUST** follow this pattern:

```sql
CREATE OR REPLACE FUNCTION my_scheduled_job()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Do work...
    RETURN jsonb_build_object(
        'success', true,
        'message', 'Processed N records',
        'details', jsonb_build_object('key', 'value')  -- optional
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', SQLERRM
    );
END;
$$;
```

**Key points**:
- Function must return JSONB with at least `success` (boolean) and `message` (string)
- Use `SECURITY DEFINER` to run with elevated privileges if needed
- Use `SET search_path` to control schema resolution
- Always wrap in exception handler to gracefully report errors
- Return `success: false` with error details instead of raising exceptions

#### Manual Trigger

Admins can manually trigger any job via RPC:

```sql
SELECT trigger_scheduled_job('daily_cleanup');
-- Returns: {"success": true, "run_id": 42, "job_name": "daily_cleanup", ...}
```

This is useful for testing or running jobs outside their normal schedule.

#### Best Practices

**Idempotency**: Design functions to be idempotent since the system provides at-least-once delivery:

```sql
-- Good: Uses INSERT ... ON CONFLICT
INSERT INTO processed_items (item_id, processed_at)
SELECT id, NOW() FROM items WHERE status = 'pending'
ON CONFLICT (item_id) DO NOTHING;

-- Good: Uses row-level locking to prevent double-processing
UPDATE items SET status = 'processing'
WHERE id IN (
    SELECT id FROM items WHERE status = 'pending'
    FOR UPDATE SKIP LOCKED
    LIMIT 100
);
```

**Execution Time**: Keep scheduled functions fast (< 30 seconds). For longer operations:
- Break into smaller batches
- Use River jobs for parallelization
- Run more frequently with smaller workloads

**Error Handling**: Always catch exceptions and return structured errors:

```sql
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', SQLERRM,
        'details', jsonb_build_object(
            'sqlstate', SQLSTATE,
            'context', pg_exception_context()
        )
    );
```

#### Database Schema

**`metadata.scheduled_jobs`** - Job configuration:

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Primary key |
| `name` | VARCHAR(100) | Unique job identifier |
| `description` | TEXT | Human-readable description |
| `function_name` | VARCHAR(200) | SQL function to call |
| `schedule` | VARCHAR(100) | Cron expression |
| `timezone` | VARCHAR(100) | Timezone for schedule interpretation (default: UTC) |
| `enabled` | BOOLEAN | Whether job is active (default: true) |
| `last_run_at` | TIMESTAMPTZ | Last execution timestamp |

**`metadata.scheduled_job_runs`** - Execution history:

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL | Primary key |
| `job_id` | INT | Foreign key to scheduled_jobs |
| `started_at` | TIMESTAMPTZ | When execution started |
| `completed_at` | TIMESTAMPTZ | When execution finished |
| `duration_ms` | INT | Execution time in milliseconds |
| `success` | BOOLEAN | Whether function returned success |
| `message` | TEXT | Result message from function |
| `details` | JSONB | Full result from function |
| `scheduled_for` | TIMESTAMPTZ | When this run was supposed to happen |
| `triggered_by` | VARCHAR(50) | `scheduler`, `manual`, or `catchup` |

#### Observability

```sql
-- View pending/running scheduled job executions
SELECT id, kind, args, state, attempt, created_at
FROM metadata.river_job
WHERE kind = 'scheduled_job_execute'
ORDER BY created_at DESC;

-- Average execution time by job (last 7 days)
SELECT
    sj.name,
    COUNT(*) as total_runs,
    AVG(duration_ms) as avg_duration_ms,
    MAX(duration_ms) as max_duration_ms,
    SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as success_rate
FROM metadata.scheduled_job_runs r
JOIN metadata.scheduled_jobs sj ON r.job_id = sj.id
WHERE r.started_at > NOW() - INTERVAL '7 days'
GROUP BY sj.name;
```

See `docs/notes/SCHEDULED_JOBS_DESIGN.md` for complete architecture documentation.

---

### System Introspection (v0.23.0+)

System Introspection provides auto-generated documentation and dependency visualization for RPC functions, database triggers, and notification workflows. This enables end-users to understand what functions do without exposing source code.

**Key Features**:
- **RPC Registry**: Document public functions with descriptions, parameters, and return types
- **Trigger Documentation**: Explain what happens automatically when data changes
- **Entity Effects**: Track which entities each function/trigger modifies (auto-detected via static analysis)
- **Notification Mapping**: Document when and to whom notifications are sent
- **Dependency Graph**: Visualize FK relationships and behavioral dependencies
- **Permission-Filtered**: Users only see documentation for entities they can access

**Public Views** (permission-filtered, accessible via PostgREST):

| View | Description | Access |
|------|-------------|--------|
| `schema_functions` | RPC function documentation with entity effects | All users (filtered) |
| `schema_triggers` | Trigger documentation with affected entities | All users (filtered) |
| `schema_entity_dependencies` | FK + behavioral relationships between entities | All users (filtered) |
| `schema_notifications` | Notification trigger documentation | All users (filtered) |
| `schema_cache_versions` | Cache versioning for frontend invalidation | All users |
| `schema_permissions_matrix` | RBAC overview (all entities × all roles) | Admin only |
| `schema_scheduled_functions` | Scheduled job execution status | Admin only |

**Quick Start - Register an RPC Function**:

```sql
-- Auto-register with static analysis for entity effects
SELECT metadata.auto_register_function(
    'approve_request',           -- function_name
    'Approve Request',           -- display_name
    'Approves a pending request and notifies the user.', -- description
    'workflow'                   -- category: workflow|crud|utility|payment|notification
);

-- Add parameter documentation
UPDATE metadata.rpc_functions
SET parameters = '[
    {"name": "p_request_id", "type": "BIGINT", "description": "Request to approve"}
]'::jsonb,
    returns_type = 'JSONB',
    returns_description = 'Object with success status and message',
    minimum_role = 'manager'
WHERE function_name = 'approve_request';
```

**Register a Database Trigger**:

```sql
INSERT INTO metadata.database_triggers
    (trigger_name, table_name, schema_name, timing, events, function_name,
     display_name, description, purpose)
VALUES
    ('validate_booking', 'reservations', 'public', 'BEFORE', ARRAY['INSERT', 'UPDATE'],
     'validate_booking_fn', 'Validate Booking',
     'Ensures booking time slots don''t overlap and are within business hours.',
     'validation');
```

**Register Trigger Entity Effects** (for cross-table effects):

```sql
INSERT INTO metadata.trigger_entity_effects
    (trigger_name, trigger_table, trigger_schema, affected_table, effect_type, description)
VALUES
    ('create_audit_note', 'orders', 'public', 'audit_log', 'create',
     'Creates audit log entry when order status changes');
```

**Register Notification Triggers**:

```sql
INSERT INTO metadata.notification_triggers
    (trigger_type, source_function, source_table, template_id,
     trigger_condition, recipient_description, description)
SELECT
    'rpc',                              -- trigger_type: rpc|trigger|manual
    'approve_request',                  -- source RPC function
    'requests',                         -- source table
    t.id,                               -- template ID (from notification_templates)
    'When a request is approved',       -- human-readable condition
    'The user who submitted the request',
    'Sends approval confirmation email with next steps.'
FROM metadata.notification_templates t
WHERE t.name = 'request_approved';
```

**Bulk Register All Public Functions**:

```sql
-- Auto-discovers all public schema functions and analyzes their entity effects
SELECT * FROM metadata.auto_register_all_rpcs();
```

**Static Analysis**: The `auto_register_function()` helper automatically parses function source code to detect entity effects (INSERT, UPDATE, DELETE, SELECT patterns). Manually add effects for complex cases:

```sql
INSERT INTO metadata.rpc_entity_effects
    (function_name, entity_table, effect_type, description, is_auto_detected)
VALUES
    ('process_order', 'inventory', 'update',
     'Decrements inventory counts for ordered items', false);
```

**Cache Invalidation**: The `introspection` cache version updates automatically when introspection tables change. Frontend can poll `schema_cache_versions` to detect when to refresh documentation.

**API Response Reference** (for script writers and automation):

`GET /schema_functions` - Returns array of function documentation:
```json
[{
  "function_name": "approve_request",
  "schema_name": "public",
  "display_name": "Approve Request",
  "description": "Approves a pending request and notifies the user.",
  "category": "workflow",
  "parameters": [
    {"name": "p_request_id", "type": "BIGINT", "description": "Request to approve"}
  ],
  "returns_type": "JSONB",
  "returns_description": "Object with success status and message",
  "is_idempotent": false,
  "minimum_role": "manager",
  "entity_effects": [
    {"table": "requests", "effect": "update", "auto_detected": true, "description": null},
    {"table": "notifications", "effect": "create", "auto_detected": false, "description": "Sends approval email"}
  ],
  "hidden_effects_count": 0,
  "has_active_schedule": false,
  "can_execute": true
}]
```

`GET /schema_triggers` - Returns array of trigger documentation:
```json
[{
  "trigger_name": "validate_booking",
  "table_name": "reservations",
  "schema_name": "public",
  "timing": "BEFORE",
  "events": ["INSERT", "UPDATE"],
  "function_name": "validate_booking_fn",
  "display_name": "Validate Booking",
  "description": "Ensures booking time slots don't overlap.",
  "purpose": "validation",
  "is_enabled": true,
  "entity_effects": [
    {"table": "audit_log", "effect": "create", "description": "Logs validation failures"}
  ],
  "hidden_effects_count": 0
}]
```

`GET /schema_entity_dependencies` - Returns dependency graph edges:
```json
[{
  "source_entity": "orders",
  "target_entity": "products",
  "relationship_type": "foreign_key",
  "via_column": "product_id",
  "via_object": null,
  "category": "structural"
},
{
  "source_entity": "orders",
  "target_entity": "inventory",
  "relationship_type": "rpc_modifies",
  "via_column": null,
  "via_object": "process_order",
  "category": "behavioral"
}]
```

`GET /schema_notifications` - Returns notification trigger documentation:
```json
[{
  "trigger_name": "notify_on_approve",
  "trigger_type": "rpc",
  "source_function": "approve_request",
  "source_table": "requests",
  "template_name": "request_approved",
  "template_entity_type": "requests",
  "trigger_condition": "When a request is approved",
  "recipient_description": "The user who submitted the request",
  "description": "Sends approval confirmation email."
}]
```

`GET /schema_permissions_matrix` (admin only) - Returns RBAC grid:
```json
[{
  "table_name": "orders",
  "entity_name": "Orders",
  "role_id": 2,
  "role_name": "user",
  "can_create": true,
  "can_read": true,
  "can_update": false,
  "can_delete": false
}]
```

`GET /schema_scheduled_functions` (admin only) - Returns scheduled job info:
```json
[{
  "function_name": "run_daily_tasks",
  "display_name": "Daily Tasks",
  "description": "Runs cleanup and reminder jobs.",
  "category": "utility",
  "job_name": "daily_tasks",
  "cron_schedule": "0 8 * * *",
  "timezone": "America/Detroit",
  "schedule_enabled": true,
  "last_run_at": "2025-01-15T08:00:00Z",
  "last_run_success": true,
  "success_rate_percent": 98.5
}]
```

See `docs/notes/SYSTEM_INTROSPECTION_DESIGN.md` for complete architecture and `examples/mottpark/init-scripts/13_mpra_introspection.sql` for a complete working example.

### iCal Calendar Feeds (v0.27.0+)

Provide subscribable calendar feeds for any entity with time-based data. Users can subscribe in Google Calendar, Apple Calendar, Outlook, or any iCal-compatible application.

**Features**:
- RFC 5545 compliant VEVENT generation
- Core helper functions for building custom feeds
- UTC timestamp conversion for universal compatibility
- Special character escaping per iCal spec
- RLS-enforced data access (SECURITY INVOKER)

**Requirements**:
- Civic OS v0.27.0+ (iCal helper migrations)
- Entity with `time_slot` or `timestamptz` columns for event times
- PostgREST 12+ (uses domain-based media type handlers)

**How it Works**: The `wrap_ical_feed()` function returns the `"*/*"` domain type (any media type handler), which responds to ALL Accept headers including requests with no Accept header. This ensures universal compatibility with all calendar applications (iOS, macOS, Google Calendar, Outlook). Content-Type is set to `text/calendar; charset=utf-8` via the PostgREST `response.headers` GUC.

#### Core Helper Functions

Civic OS provides three helper functions in the `metadata` schema:

| Function | Purpose |
|----------|---------|
| `escape_ical_text(text)` | Escape special characters (commas, semicolons, backslashes, newlines) |
| `format_ical_event(uid, summary, dtstart, dtend, description, location)` | Generate a single VEVENT block |
| `wrap_ical_feed(events, calendar_name)` | Wrap VEVENT blocks in a VCALENDAR container |

#### Creating a Calendar Feed RPC

Create a PostgreSQL function that queries your entity and builds the iCal feed:

```sql
CREATE OR REPLACE FUNCTION public.my_events_ical_feed(
  p_start_date DATE DEFAULT (CURRENT_DATE - interval '30 days')::date,
  p_end_date DATE DEFAULT (CURRENT_DATE + interval '1 year')::date
) RETURNS "*/*"  -- Any media type handler for universal calendar client compatibility
LANGUAGE plpgsql
SECURITY INVOKER  -- Respects RLS policies
AS $$
DECLARE
  v_events TEXT := '';
  v_event RECORD;
BEGIN
  FOR v_event IN
    SELECT
      id,
      title,
      lower(time_slot) as start_time,  -- Extract start from tstzrange
      upper(time_slot) as end_time,    -- Extract end from tstzrange
      description,
      location
    FROM my_events
    WHERE time_slot && tstzrange(p_start_date::timestamptz, p_end_date::timestamptz)
    ORDER BY lower(time_slot)
  LOOP
    v_events := v_events || metadata.format_ical_event(
      p_uid := 'my-event-' || v_event.id || '@my-domain.org',
      p_summary := v_event.title,
      p_dtstart := v_event.start_time,
      p_dtend := v_event.end_time,
      p_description := v_event.description,
      p_location := v_event.location
    ) || chr(13) || chr(10);
  END LOOP;

  RETURN metadata.wrap_ical_feed(v_events, 'My Calendar');
END;
$$;

-- Grant access (web_anon for public feeds, authenticated for private)
GRANT EXECUTE ON FUNCTION public.my_events_ical_feed(DATE, DATE) TO web_anon;
GRANT EXECUTE ON FUNCTION public.my_events_ical_feed(DATE, DATE) TO authenticated;
```

#### Subscription URL Patterns

Users subscribe via the PostgREST RPC endpoint:

| URL Pattern | Purpose |
|-------------|---------|
| `/rpc/my_events_ical_feed` | All events (default date range) |
| `/rpc/my_events_ical_feed?p_start_date=2025-01-01&p_end_date=2025-12-31` | Specific date range |
| `/rpc/my_events_ical_feed?p_resource_id=5` | Filtered by resource (if implemented) |

**Example subscription URLs**:
- Google Calendar: Add calendar → From URL → paste your API endpoint
- Apple Calendar: File → New Calendar Subscription → paste URL
- Outlook: Add calendar → Subscribe from web → paste URL

#### Best Practices

1. **UID Format**: Use globally unique identifiers like `entity-type-id@your-domain.org`
2. **Date Range**: Default to 30 days past through 1 year future for reasonable data volume
3. **Security**: Use `SECURITY INVOKER` to respect RLS policies; grant to `web_anon` only for public data
4. **Caching**: Calendar apps typically refresh every 15-60 minutes; stale data is expected
5. **Optional Filters**: Add parameters like `p_resource_id` or `p_category` for filtered feeds

#### Complete Example

See `examples/community-center/init-scripts/18_ical_feed_example.sql` for a complete implementation with:
- Public events feed for community center reservations
- Resource filtering parameter
- Date range parameters
- Usage examples with curl and calendar apps

---

## Database Patterns

### Custom Domains

Create custom PostgreSQL domains for property types to enable automatic UI generation.

**Existing Domains** (included in Civic OS):
- `hex_color` - RGB color values (#RRGGBB)
- `email_address` - Email validation
- `phone_number` - US phone numbers (10 digits)
- `time_slot` - Timestamp ranges (wrapper for tstzrange)

**Creating Custom Domains**:
```sql
-- Example: US ZIP code domain
CREATE DOMAIN zip_code AS VARCHAR(10)
  CHECK (VALUE ~ '^\d{5}(-\d{4})?$');

-- Example: Percentage domain
CREATE DOMAIN percentage AS NUMERIC(5,2)
  CHECK (VALUE >= 0 AND VALUE <= 100);
```

**Frontend Integration** (requires code changes):
1. Add new type to `EntityPropertyType` enum in `src/app/interfaces/entity.ts`
2. Update `SchemaService.getPropertyType()` to detect domain via `udt_name`
3. Add rendering logic to `DisplayPropertyComponent`
4. Add input control to `EditPropertyComponent`

---

### Junction Tables (Many-to-Many)

Civic OS automatically detects junction tables and renders many-to-many relationships on Detail pages.

**Requirements**:
1. **Composite Primary Key** (NOT surrogate id)
2. **Two Foreign Keys** to related entities
3. **Indexes on Both FKs** (required for inverse relationships)
4. **ON DELETE CASCADE** (optional, for automatic cleanup)

**Example**:
```sql
CREATE TABLE issue_tags (
  issue_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, tag_id)  -- Composite key prevents duplicates
);

-- REQUIRED: Index both FKs for performance
CREATE INDEX idx_issue_tags_issue_id ON issue_tags(issue_id);
CREATE INDEX idx_issue_tags_tag_id ON issue_tags(tag_id);
```

**Why Composite Keys**: Prevents duplicate relationships (e.g., adding same tag to issue twice). Surrogate IDs allow duplicates, breaking the M:M contract.

**UI Behavior**:
- Detail pages show M:M editor component with checkboxes
- Changes saved immediately (not on form submit)
- Users need CREATE and DELETE permissions on junction table

See `docs/notes/MANY_TO_MANY_DESIGN.md` for implementation details.

---

### Indexes & Performance

**Critical Indexes**:

1. **Foreign Key Indexes** (NOT auto-created by PostgreSQL):
   ```sql
   CREATE INDEX idx_issues_status_id ON issues(status_id);
   CREATE INDEX idx_issues_assigned_to ON issues(assigned_to);
   ```
   Required for: Inverse relationships, JOIN performance, cascading deletes

2. **GIST Indexes** (for geometry and ranges):
   ```sql
   CREATE INDEX idx_issues_location ON issues USING GIST(location);
   CREATE INDEX idx_reservations_time_slot ON reservations USING GIST(time_slot);
   ```
   Required for: Map queries, time_slot overlap checks, spatial searches

3. **GIN Indexes** (for full-text search):
   ```sql
   CREATE INDEX idx_issues_text_search ON issues USING GIN(civic_os_text_search);
   ```
   Required for: Full-text search performance

**Index Maintenance**:
```sql
-- Reindex after major data changes
REINDEX INDEX idx_issues_text_search;

-- Analyze tables for query planner
ANALYZE issues;
```

---

### Row Level Security Policies

Use RLS to enforce data access controls at the database level (defense in depth).

#### Best Practice: Granular CRUD Policies

**Every table should have separate policies for SELECT, INSERT, UPDATE, and DELETE** that use `has_permission()`. This enables the Permissions UI (`/permissions`) to control access without modifying RLS policies.

```sql
-- Enable RLS
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;

-- SELECT: Users with read permission
CREATE POLICY "my_table: authorized read" ON my_table
  FOR SELECT TO authenticated
  USING (has_permission('my_table', 'read'));

-- INSERT: Users with create permission
CREATE POLICY "my_table: authorized insert" ON my_table
  FOR INSERT TO authenticated
  WITH CHECK (has_permission('my_table', 'create'));

-- UPDATE: Users with update permission
CREATE POLICY "my_table: authorized update" ON my_table
  FOR UPDATE TO authenticated
  USING (has_permission('my_table', 'update'))
  WITH CHECK (has_permission('my_table', 'update'));

-- DELETE: Users with delete permission
CREATE POLICY "my_table: authorized delete" ON my_table
  FOR DELETE TO authenticated
  USING (has_permission('my_table', 'delete'));
```

**Why granular policies?**
- **UI Administration**: Permissions page can toggle access per role without SQL changes
- **Audit Trail**: Delete can be admin-only while allowing manager updates
- **Clarity**: Easy to understand which roles can do what
- **Avoid `FOR ALL`**: Coarse-grained policies can't be controlled via UI

#### Common Patterns

1. **Users see own records** (combine with permission-based):
   ```sql
   CREATE POLICY "my_table: read own or authorized" ON my_table
     FOR SELECT TO authenticated
     USING (
       created_by = current_user_id()
       OR has_permission('my_table', 'read')
     );
   ```

2. **Public read, authenticated write** (lookup tables):
   ```sql
   CREATE POLICY "my_table: public read" ON my_table
     FOR SELECT TO web_anon, authenticated
     USING (true);

   CREATE POLICY "my_table: admin insert" ON my_table
     FOR INSERT TO authenticated
     WITH CHECK (is_admin());
   ```

3. **Conditional access** (published vs draft):
   ```sql
   CREATE POLICY "articles: view published or own" ON articles
     FOR SELECT TO authenticated
     USING (
       status = 'published'
       OR created_by = current_user_id()
       OR has_permission('articles', 'read')
     );
   ```

**Enable RLS**:
```sql
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
```

**Important**: Always test RLS policies with different user roles. Use `SET ROLE` to impersonate users in psql.

---

## Production Considerations

### Sqitch Migrations

Civic OS uses Sqitch for versioned schema migrations. All core Civic OS schema is managed via migrations in `postgres/migrations/`.

**Important for Integrators**:
- **DO NOT** modify core migrations (anything in `postgres/migrations/`)
- **DO** create separate migrations for your domain-specific tables
- **DO** run migrations via the migrations container for version compatibility

**Quick Commands**:
```bash
# Deploy migrations to production
./scripts/migrate-production.sh v0.9.0 $DATABASE_URL

# Verify migrations
sqitch verify prod

# Rollback if needed
sqitch revert prod --to @HEAD^
```

See `postgres/migrations/README.md` for complete documentation.

---

### Deployment

Civic OS provides production-ready Docker containers for all components:
- **Frontend** (Angular app): `ghcr.io/civic-os/frontend:latest`
- **PostgREST** API: `ghcr.io/civic-os/postgrest:latest`
- **Migrations** (Sqitch): `ghcr.io/civic-os/migrations:latest`
- **Consolidated Worker** (Go + River): `ghcr.io/civic-os/consolidated-worker:latest` - Handles S3 presigning, thumbnail generation, and notifications in a single service

> **Note:** For production deployments, pin to specific versions (e.g., `v0.14.0`) to ensure reproducible builds. Check [GitHub Releases](https://github.com/civic-os/civic-os-frontend/releases) for available versions.

**Runtime Configuration**: All instances use environment variables for configuration (PostgREST URL, Keycloak settings, S3 credentials, etc.). No rebuild required for deployment.

**Consolidated Worker Architecture (v0.11.0+)**: File storage, thumbnail generation, and notification features run in a single Go microservice with a shared PostgreSQL connection pool (4 connections vs 12 with separate services). Uses PostgreSQL-based River job queue for reliable background processing. See File Storage System and Notification System sections above for architecture details.

See `docs/deployment/PRODUCTION.md` for complete deployment guide including:
- Environment variable configuration
- Docker Compose examples
- Kubernetes manifests
- SSL/TLS setup
- Monitoring and logging

---

### Performance Tuning

**Database**:
- Connection pooling: PgBouncer recommended for high traffic
- Query optimization: Use EXPLAIN ANALYZE for slow queries
- Vacuum strategy: Configure autovacuum for large tables
- Indexes: Monitor with `pg_stat_user_indexes`, drop unused indexes

**PostgREST**:
- Connection pool: Configure `db-pool` for concurrent requests
- Request limits: Set `max-rows` to prevent unbounded queries
- JWT caching: Enable `jwt-cache-max-lifetime` for performance

**Frontend**:
- CDN: Serve static assets from CDN in production
- Compression: Enable gzip/brotli in nginx/CDN
- Lazy loading: Angular already implements lazy-loaded routes

**File Storage Microservices** (v0.10.0+):
- **Thumbnail Worker**: Tune `THUMBNAIL_MAX_WORKERS` based on available memory
  - Low memory (512Mi): 2-3 workers
  - Medium (1Gi): 5-7 workers (default: 5)
  - High (2Gi): 10-12 workers
- **S3 Signer**: Lightweight service, default settings typically sufficient
- **River Job Queue**: Monitor `metadata.river_job` table for stuck jobs, configure retries

---

### Backup & Recovery

**Database Backups**:
```bash
# Full backup
pg_dump -Fc civic_os > civic_os_backup.dump

# Restore
pg_restore -d civic_os civic_os_backup.dump

# Continuous archiving (WAL)
# Configure in postgresql.conf
archive_mode = on
archive_command = 'cp %p /backup/wal/%f'
```

**S3 File Storage**:
- Enable S3 versioning for file recovery
- Configure lifecycle policies for cost optimization
- Regular S3 bucket sync to backup location

---

### Monitoring

**Key Metrics**:
- Database: Connection count, query latency, table sizes
- PostgREST: Request rate, error rate, response time
- Frontend: Page load time, API call latency
- File Storage Microservices (v0.10.0+):
  - S3 Signer: Job queue depth, presigned URL generation time
  - Thumbnail Worker: Processing time per file, memory usage, failed jobs
  - River Queue: Monitor `metadata.river_job` for stuck jobs (state = 'running' for >10 min)

**Recommended Tools**:
- Database: pg_stat_statements, pg_stat_activity
- APM: New Relic, Datadog, or Grafana + Prometheus
- Logs: ELK stack or CloudWatch

---

## Additional Resources

- **CLAUDE.md** - Developer quick-reference for building Civic OS apps
- **docs/deployment/PRODUCTION.md** - Production deployment guide
- **docs/AUTHENTICATION.md** - Keycloak setup and RBAC configuration
- **docs/development/FILE_STORAGE.md** - File storage architecture and setup
- **docs/development/GO_MICROSERVICES_GUIDE.md** - Go microservices architecture (River job queue)
- **docs/development/CALENDAR_INTEGRATION.md** - Calendar system implementation
- **docs/development/IMPORT_EXPORT.md** - Import/Export specification
- **docs/notes/DASHBOARD_DESIGN.md** - Dashboard system architecture
- **postgres/migrations/README.md** - Sqitch migrations guide

For questions or support, see the project README or file an issue on GitHub.
