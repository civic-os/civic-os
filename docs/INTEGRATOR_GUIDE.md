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

### Dashboard System (Preview)

**Status**: Phase 1 - Core infrastructure complete, management UI in progress

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
- `markdown` - Static content with markdown formatting (Phase 1, implemented)
- `filtered_list` - Dynamic entity lists with filters (Phase 2, planned)
- `stat_card` - Single metric display with sparklines (Phase 5, planned)
- `query_result` - Results from database views or RPCs (Phase 5, planned)

**`metadata.dashboard_widgets`** - Widget configurations using hybrid storage pattern

Fields:
- `id` (SERIAL PK) - Unique widget identifier
- `dashboard_id` (FK) - Parent dashboard
- `widget_type` (FK) - Type from widget_types table
- `title` - Widget title displayed in card header
- `sort_order` - Position on dashboard (lower numbers first)
- `entity_key` - Optional table name for filtered_list widgets
- `refresh_interval_seconds` - Optional auto-refresh interval (NULL = no refresh)
- `config` (JSONB) - Widget-specific configuration

**Hybrid Storage Pattern**: Common fields (entity_key, title, refresh_interval) are typed columns for efficient queries. Widget-specific settings (e.g., markdown content, filter expressions, chart options) are stored in JSONB `config` field for flexibility.

**Creating Dashboards**:
```sql
-- 1. Create dashboard
INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, created_by, sort_order)
VALUES ('Operations Dashboard', 'Real-time system metrics', FALSE, TRUE, current_user_id(), 10)
RETURNING id;  -- Returns dashboard_id (e.g., 5)

-- 2. Add markdown widget
INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order)
VALUES (
  5,  -- dashboard_id from above
  'markdown',
  'Welcome Message',
  '{"content": "# Operations Dashboard\n\nMonitor system health and metrics below.", "enableHtml": false}',
  1
);

-- 3. Add another markdown widget
INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order)
VALUES (
  5,
  'markdown',
  'System Status',
  '{"content": "**Status**: All systems operational\n\n**Last Check**: 2025-11-04", "enableHtml": false}',
  2
);
```

**Widget Config Examples**:

Markdown widget (`enableHtml` allows sanitized HTML via DOMPurify):
```json
{
  "content": "# Hello World\n\nMarkdown **formatting** supported.",
  "enableHtml": false
}
```

Filtered List widget (Phase 2, not yet implemented):
```json
{
  "entityKey": "issues",
  "filters": [{"property": "status_id", "value": "1"}],
  "columns": ["id", "display_name", "created_at"],
  "limit": 10
}
```

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

**Common Patterns**:

1. **Users see own records**:
   ```sql
   CREATE POLICY "users_own_records" ON issues
     FOR SELECT TO authenticated
     USING (created_by = current_user_id());
   ```

2. **Permission-based access**:
   ```sql
   CREATE POLICY "permission_read" ON issues
     FOR SELECT USING (has_permission('issues', 'READ'));

   CREATE POLICY "permission_update" ON issues
     FOR UPDATE USING (has_permission('issues', 'UPDATE'));
   ```

3. **Role-based access**:
   ```sql
   CREATE POLICY "moderators_all" ON submissions
     FOR ALL TO authenticated
     USING ('moderator' = ANY(get_user_roles()) OR is_admin());
   ```

4. **Conditional access**:
   ```sql
   CREATE POLICY "view_published_or_own" ON articles
     FOR SELECT TO authenticated
     USING (
       status = 'published' OR
       created_by = current_user_id() OR
       is_admin()
     );
   ```

**Enable RLS**:
```sql
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
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
- **Frontend** (Angular app): `ghcr.io/civic-os/frontend:v0.10.0`
- **PostgREST** API: `ghcr.io/civic-os/postgrest:v0.10.0`
- **Migrations** (Sqitch): `ghcr.io/civic-os/migrations:v0.10.0`
- **Consolidated Worker** (Go + River): `ghcr.io/civic-os/consolidated-worker:v0.11.0` - Handles S3 presigning, thumbnail generation, and notifications in a single service

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
