# Custom Pages Design

**Status**: Design — ready for implementation review
**Created**: 2026-08-08
**Target version**: TBD

**Related docs**:
- `CLAUDE.md` — Framework overview, property type system
- `docs/INTEGRATOR_GUIDE.md` — Integrator-facing configuration reference
- `docs/notes/ADMIN_PAGE_PITFALLS.md` — VIEW + RPC patterns for admin pages

---

## Table of Contents

- [Overview](#overview)
- [Design Goals](#design-goals)
- [Architecture](#architecture)
- [Core Concepts](#core-concepts)
- [Database Schema](#database-schema)
- [Frontend Architecture](#frontend-architecture)
- [Entity Actions Upgrade](#entity-actions-upgrade)
- [Worked Example: Childcare Check-In](#worked-example-childcare-check-in)
- [Permissions](#permissions)
- [Edge Cases & Constraints](#edge-cases--constraints)
- [Future Enhancements](#future-enhancements)

---

## Overview

### Problem Statement

Civic OS auto-generates CRUD pages from database schema. Every page is bound to a single entity and operates in a single mode: List and Detail are read-only, Create and Edit are write-only. This covers standard data management well, but two patterns common in purpose-built applications are missing:

1. **Mixed read/write on one page**: Showing some fields as read-only context alongside editable form inputs. Example: editing a work order while seeing the client's contact info and job history.

2. **Multi-source read, single-target write**: Assembling a page from data across multiple tables but submitting to a different target. Example: a check-in tablet that displays child info from several tables but writes an attendance record.

Dashboards provide multi-source reads but are read-only. Virtual Entities (VIEWs with INSTEAD OF triggers) can join tables but treat all columns the same way — all readable or all writable. Guided Forms are multi-step but still one-entity-per-step.

### Solution

**Custom Pages** are a new entity variant where:

- A PostgreSQL **VIEW defines the page shape** (columns = fields), reusing the entire `schema_properties` pipeline
- A **context RPC** replaces the standard PostgREST GET for data loading, enabling multi-source assembly
- A **submit RPC** replaces the standard PostgREST PATCH for form submission, enabling writes to any target
- The `is_readonly` flag on `metadata.properties` controls whether each field renders as display or input
- **RPC parameter introspection** via a new `schema_rpc_parameters` VIEW determines which form fields are included in the submit payload

The key insight: a custom page IS an entity in the schema system. It gets property type detection, display name overrides, validation rules, static text blocks, translations, and admin page configuration — all for free.

**Key architectural decisions:**

- **The VIEW defines the shape, not the RPC.** The RPC returns data matching the VIEW's columns. The schema system handles layout. This avoids duplicating the entire property metadata system inside RPC JSON responses.
- **`is_readonly` is a property-level flag, not a section concept.** Fields can freely interleave readonly context and writable inputs. No nested section/field metadata hierarchy.
- **RPC parameter introspection is the submit contract.** The frontend auto-discovers which writable fields to POST by matching column names to the submit RPC's function signature. The RPC signature is the source of truth.
- **No lookup phase.** Multi-step workflows (lookup → context → submit) are modeled as separate custom pages linked by `navigate_to`. Each page does one thing.

---

## Design Goals

1. **Minimal new surface area**: Three new columns on `metadata.entities`, one on `metadata.properties`, one new VIEW, one junction table for permissions. (See [Appendix: Separate Table Alternative](#appendix-separate-table-alternative) for a cleaner separation to reconsider before v1.0.)
2. **Reuse the schema pipeline**: Property types, validation, static text, translations, admin pages — all work unchanged.
3. **RPC is the controller**: All data assembly and business logic stays in PostgreSQL. The frontend is a generic renderer.
4. **Integrator familiarity**: Configuring a custom page uses the same tools as configuring any entity — VIEWs, metadata overrides, RPCs.
5. **Incremental adoption**: Custom pages coexist with entity pages. Adding `context_rpc` to an entity opts it into the custom page system; everything else is optional.

---

## Architecture

### Data Flow Comparison

**Standard Entity Page (Edit)**:
```
Route params → SchemaService.getEntity()
             → SchemaService.getPropsForEdit()
             → DataService.getData() [PostgREST GET]
             → EditPropertyComponent for all fields
             → DataService.updateData() [PostgREST PATCH]
```

**Custom Page**:
```
Route params → SchemaService.getEntity()
             → SchemaService.getProps() [all properties, no filter]
             → DataService.executeRpc(context_rpc) [RPC GET]
             → DisplayPropertyComponent (is_readonly = true)
               EditPropertyComponent   (is_readonly = false)
             → Introspect schema_rpc_parameters for submit_rpc
             → DataService.executeRpc(submit_rpc) [matched params only]
```

### Detection & Routing

An entity is a custom page when `context_rpc IS NOT NULL` on `metadata.entities`.

| Route | Behavior |
|-------|----------|
| `/page/:entityKey` | Custom page, no ID (pure form or user-context page) |
| `/page/:entityKey/:id` | Custom page with ID (context loaded for specific record) |
| `/view/:entityKey` on a custom page entity | **Redirects** to `/page/:entityKey` |
| `/edit/:entityKey/:id` on a custom page entity | **Redirects** to `/page/:entityKey/:id` |
| `/create/:entityKey` on a custom page entity | **Redirects** to `/page/:entityKey` |

The sidebar uses the same detection: if `context_rpc IS NOT NULL`, the nav link points to `/page/:entityKey` instead of `/view/:entityKey`.

---

## Core Concepts

### `is_readonly` Property Flag

A new boolean column on `metadata.properties` (default `FALSE`).

**On custom pages**: Controls whether a field renders via `DisplayPropertyComponent` (readonly) or `EditPropertyComponent` (writable). Readonly fields provide context; writable fields collect input.

**On standard entity Edit pages**: Also respected — a property with `is_readonly = true` renders as display on the Edit page. Useful for Virtual Entity VIEWs where some joined columns should be visible but not editable.

This is a single concept applied in two contexts, not a custom-page-only feature.

### Field Visibility

Custom pages show **all properties** from the VIEW. No `show_on_page` flag is needed because the VIEW itself is the curation — the integrator includes only the columns they want on the page. This differs from entity pages where a table might have 20+ columns and `show_on_list`, `show_on_edit`, etc. filter which appear in each context.

### Context RPC

The context RPC loads data for the page. It replaces the standard PostgREST `GET /entity?id=eq.X` query.

**Signature conventions:**
- Accepts `p_id` (integer or UUID) when the page has an ID in the route
- Accepts no parameters when the page has no ID
- Returns a row (or JSON) with keys matching the VIEW's column names
- Called via PostgREST: `POST /rpc/{context_rpc}` with `{ "p_id": 42 }`

**What it enables:**
- Joining data from multiple tables that aren't related by simple FKs
- Computing derived values (aggregates, age calculations, status summaries)
- Applying per-user filtering or authorization logic
- Returning context that depends on the current user (`current_user_id()`)

For no-ID pages (e.g., a "Submit Feedback" form), the context RPC is called with no arguments and can return default values, the current date, user info, or other contextual data for readonly fields.

### Submit RPC

The submit RPC handles form submission. It replaces the standard PostgREST `PATCH /entity?id=eq.X`.

**Signature conventions:**
- Parameter names follow the `p_{column_name}` convention
- `p_id` parameter (if present) receives the entity ID from the route
- Parameters with defaults are optional form fields
- Returns `EntityActionResult` JSON: `{ success, message, navigate_to, refresh, field_errors }`

**Submit payload construction:**
1. Frontend reads `schema_rpc_parameters` for the submit RPC's function name
2. Collects all writable field values (where `is_readonly = false`)
3. Matches writable fields to RPC parameters: column `action` → parameter `p_action`
4. Only matched fields are included in the POST body
5. Writable fields that don't match any RPC parameter are client-side only (e.g., a "confirm" checkbox)

### Post-Submit Behavior

The submit RPC returns `EntityActionResult`, which the frontend already handles:

| Result field | Behavior |
|-------------|----------|
| `navigate_to` | Navigate to the specified path |
| `navigate_to` (same as current URL) | **Reset**: clear writable fields, re-call context_rpc |
| `refresh: true` | Re-call context_rpc, keep form values |
| `message` | Display success/error toast |
| `field_errors` | Map errors to form fields (see below) |

**Self-navigation as reset**: When `navigate_to` points to the current page URL, the frontend clears all writable fields to their defaults and re-invokes the context RPC. This provides "reset and go again" behavior (ideal for kiosk flows) without a new result field.

### Field-Level Errors

A new optional field on `EntityActionResult`:

```typescript
interface EntityActionResult {
    success: boolean;
    message?: string;
    navigate_to?: string;
    refresh?: boolean;
    data?: any;
    // NEW — maps field names to error messages
    field_errors?: Record<string, string>;
}
```

When the submit RPC returns `field_errors`, the frontend maps each key to the corresponding form control and displays the error inline. Keys use VIEW column names (not `p_`-prefixed RPC parameter names).

```json
{
  "success": false,
  "message": "Please fix the errors below",
  "field_errors": {
    "action": "Cannot check in — child is already checked in"
  }
}
```

This enhancement benefits both custom pages and entity actions.

---

## Database Schema

### New Columns on `metadata.entities`

```sql
ALTER TABLE metadata.entities ADD COLUMN context_rpc TEXT;
ALTER TABLE metadata.entities ADD COLUMN submit_rpc TEXT;
ALTER TABLE metadata.entities ADD COLUMN submit_label TEXT;
```

| Column | Type | Purpose |
|--------|------|---------|
| `context_rpc` | `TEXT` | RPC function name for loading page data. **When NOT NULL, identifies entity as a custom page.** |
| `submit_rpc` | `TEXT` | RPC function name for form submission. NULL for read-only custom pages. |
| `submit_label` | `TEXT` | Submit button text (e.g., "Check In", "Submit Report"). Defaults to "Submit" in frontend. |

### New Column on `metadata.properties`

```sql
ALTER TABLE metadata.properties ADD COLUMN is_readonly BOOLEAN DEFAULT FALSE;
```

Used by custom pages to distinguish context (display) fields from form (input) fields. Also respected on standard entity Edit pages.

### New VIEW: `schema_rpc_parameters`

```sql
CREATE VIEW schema_rpc_parameters AS
SELECT
    r.routine_name    AS function_name,
    p.parameter_name,
    p.data_type,
    p.udt_name,
    p.ordinal_position::INT,
    p.parameter_default IS NOT NULL AS has_default
FROM information_schema.routines r
JOIN information_schema.parameters p
    ON p.specific_name = r.specific_name
WHERE r.routine_schema = 'public'
    AND p.parameter_mode = 'IN'
ORDER BY r.routine_name, p.ordinal_position;
```

Queryable via PostgREST: `GET /schema_rpc_parameters?function_name=eq.submit_checkin`

Follows the same pattern as `schema_properties` and `schema_entities` — a VIEW over `information_schema` that exposes database catalog data through the API.

### New Table: `metadata.custom_page_roles`

One new junction table for RBAC permissions (see [Permissions](#permissions) section for full details):

```sql
CREATE TABLE metadata.custom_page_roles (
    custom_page_entity NAME NOT NULL,
    role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('navigate', 'submit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (custom_page_entity, role_id, permission)
);
```

All other configuration uses existing metadata infrastructure — custom pages are registered in `metadata.entities`, fields come from `schema_properties` + `metadata.properties`, and RPC parameter discovery comes from `schema_rpc_parameters`.

---

## Frontend Architecture

### Custom Page Component

A new Angular page component at route `/page/:entityKey/:id?`.

**Responsibilities:**
1. Load entity metadata via `SchemaService.getEntity(entityKey)`
2. Detect custom page (`context_rpc` present) — if not, redirect to `/view/`
3. Load all properties via `SchemaService` (no `show_on_*` filtering)
4. Call context RPC via `DataService.executeRpc(context_rpc, { p_id })` — omit `p_id` when not in route
5. Build form controls for writable properties (`is_readonly = false`)
6. Render mixed layout: `DisplayPropertyComponent` for readonly, `EditPropertyComponent` for writable
7. Load submit RPC parameters via `SchemaService` (from `schema_rpc_parameters`)
8. On submit: collect writable values, match to RPC params, POST to submit RPC
9. Handle `EntityActionResult`: navigate, reset, refresh, or display field errors

**Reused components:**
- `DisplayPropertyComponent` — all property types (FK names, statuses, colors, maps, etc.)
- `EditPropertyComponent` — all input types (dropdowns, date pickers, text, etc.)
- `StaticTextComponent` — section dividers and content blocks between fields
- `CosModalComponent` — success/error modals
- `SaveProgressComponent` — multi-step save indicator (if needed)
- `TranslatePipe` — i18n for labels

**Not supported in v1** (standard entity page features that don't apply):
- M:M relationship editors
- Photo gallery editors
- File upload fields
- Inline M:M editors
- Entity notes
- Entity action buttons
- Inverse relationships (related records)

These could be added incrementally if use cases arise.

### Route Guard & Redirect

A route guard (or logic within existing guards) handles the redirect:

- If entity has `context_rpc IS NOT NULL` and route is `/view/` or `/edit/` → redirect to `/page/`
- If entity does NOT have `context_rpc` and route is `/page/` → redirect to `/view/`

This ensures users always land on the correct page type regardless of how they navigated.

### Sidebar Integration

The sidebar already iterates entities with `show_in_sidebar = true`. The template adds a condition:

```
routerLink = entity.context_rpc ? '/page/' + entity.table_name
                                : '/view/' + entity.table_name
```

No new sidebar section — custom pages appear alongside regular entities, sorted by `sort_order`.

### SchemaService Changes

**New method**: `getRpcParams(functionName: string)` — fetches and caches `schema_rpc_parameters` for a given function. Returns parameter names, types, and default info.

**Existing method changes**: None. `getEntity()`, `getProps*()`, property type detection, and metadata caching all work unchanged on custom page entities.

---

## Entity Actions Upgrade

The `schema_rpc_parameters` VIEW benefits entity actions too. Today, entity action parameters are fully manually defined in `metadata.entity_action_params`. With introspection, this becomes an overlay pattern matching properties:

| Layer | Properties | Entity Action Params |
|-------|-----------|---------------------|
| **Base (auto-detected)** | `information_schema.columns` → `schema_properties` | `information_schema.parameters` → `schema_rpc_parameters` |
| **Overlay (manual config)** | `metadata.properties` | `metadata.entity_action_params` |

**Before** (current — every param manually defined):
```sql
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, rpc_function)
VALUES ('requests', 'approve', 'Approve', 'approve_request');

-- Must manually define EVERY parameter
INSERT INTO metadata.entity_action_params
    (action_id, param_name, param_type, display_name, required, sort_order)
VALUES
    (1, 'p_entity_id', 'number', 'Request ID', true, 1),
    (1, 'p_reason', 'text', 'Reason', true, 2),
    (1, 'p_notify', 'boolean', 'Send Notification', false, 3);
```

**After** (with introspection — overlay only where needed):
```sql
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, rpc_function)
VALUES ('requests', 'approve', 'Approve', 'approve_request');

-- Parameters auto-discovered from function signature
-- Only override display metadata where defaults aren't sufficient
INSERT INTO metadata.entity_action_params (action_id, param_name, display_name)
VALUES (1, 'p_reason', 'Reason for Approval');
-- p_entity_id auto-detected as integer, auto-bound to record ID
-- p_notify auto-detected as boolean with default, auto-labeled
```

**Auto-detection rules for RPC parameters:**
- `p_entity_id` → always bound to the current record ID, hidden from form
- Parameter `data_type` maps to `ActionParamType` (e.g., `text` → `text`, `boolean` → `boolean`, `integer` → `number`)
- Parameters with defaults → not required
- Parameters without defaults → required
- `display_name` auto-generated from parameter name: `p_reason` → `Reason`
- All auto-detected values can be overridden via `metadata.entity_action_params` entries

This is a backward-compatible enhancement — existing manually-defined params continue to work. The introspection provides defaults; the overlay refines them.

**Implementation note**: This upgrade can be phased independently of custom pages. Both consume `schema_rpc_parameters`, but the entity actions upgrade is a separate body of work.

---

## Worked Example: Childcare Check-In

A childcare center wants a tablet-based check-in/out flow. This is modeled as two custom pages linked by navigation.

### Page 1: Student Lookup

**Purpose**: Parent enters a child's PIN → navigates to check-in page.

```sql
-- Shape VIEW: one form field, minimal context
CREATE VIEW student_lookup AS
SELECT
    NULL::TEXT    AS pin,
    current_date AS today
WHERE false;

-- Context RPC: returns today's date for display
CREATE FUNCTION get_student_lookup_context()
RETURNS JSON AS $$
    SELECT json_build_object('today', current_date);
$$ LANGUAGE sql STABLE;

-- Submit RPC: validates PIN, returns navigation target
CREATE FUNCTION submit_student_lookup(p_pin TEXT)
RETURNS JSON AS $$
DECLARE
    v_child_id INTEGER;
BEGIN
    SELECT id INTO v_child_id FROM children WHERE pin = p_pin;

    IF v_child_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'field_errors', json_build_object('pin', 'No child found with that PIN')
        );
    END IF;

    RETURN json_build_object(
        'success', true,
        'navigate_to', '/page/child-checkin/' || v_child_id
    );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
```

**Metadata configuration:**
```sql
INSERT INTO metadata.entities (table_name, display_name, context_rpc, submit_rpc, submit_label, show_in_sidebar)
VALUES ('student_lookup', 'Student Lookup', 'get_student_lookup_context', 'submit_student_lookup', 'Look Up', true);

-- today is readonly context, pin is the form input
UPDATE metadata.properties SET is_readonly = true
WHERE table_name = 'student_lookup' AND column_name = 'today';
```

### Page 2: Check-In / Check-Out

**Purpose**: Shows child context, collects check-in/out action.

```sql
-- Shape VIEW: joins child, classroom, and latest attendance
CREATE VIEW child_checkin AS
SELECT
    c.id,
    c.display_name  AS child_name,
    cl.display_name AS classroom,
    c.allergy_notes,
    a.status        AS current_status,
    a.checked_in_at AS last_check_in,
    -- Form-only fields
    NULL::TEXT       AS action,
    NULL::TEXT       AS notes
FROM children c
LEFT JOIN classrooms cl ON cl.id = c.classroom_id
LEFT JOIN LATERAL (
    SELECT status, created_at AS checked_in_at
    FROM attendance
    WHERE child_id = c.id
    ORDER BY created_at DESC LIMIT 1
) a ON true;

-- Context RPC: loads child data for display
CREATE FUNCTION get_checkin_context(p_id INTEGER)
RETURNS JSON AS $$
    SELECT row_to_json(v) FROM child_checkin v WHERE id = p_id;
$$ LANGUAGE sql STABLE SECURITY INVOKER;

-- Submit RPC: creates attendance record
CREATE FUNCTION submit_checkin(p_id INTEGER, p_action TEXT, p_notes TEXT DEFAULT NULL)
RETURNS JSON AS $$
DECLARE
    v_child RECORD;
BEGIN
    SELECT * INTO v_child FROM children WHERE id = p_id;

    INSERT INTO attendance (child_id, status, notes, recorded_by)
    VALUES (p_id, p_action, p_notes, current_user_id());

    RETURN json_build_object(
        'success', true,
        'message', v_child.display_name || ' has been ' ||
                   CASE p_action WHEN 'check_in' THEN 'checked in' ELSE 'checked out' END,
        'navigate_to', '/page/student-lookup'
    );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
```

**Metadata configuration:**
```sql
INSERT INTO metadata.entities (table_name, display_name, context_rpc, submit_rpc, submit_label)
VALUES ('child_checkin', 'Check In / Out', 'get_checkin_context', 'submit_checkin', 'Confirm');

-- Mark context fields as readonly
UPDATE metadata.properties SET is_readonly = true
WHERE table_name = 'child_checkin'
AND column_name IN ('child_name', 'classroom', 'allergy_notes', 'current_status', 'last_check_in');

-- Configure the action dropdown via options_source_rpc
UPDATE metadata.properties SET options_source_rpc = 'get_checkin_actions'
WHERE table_name = 'child_checkin' AND column_name = 'action';

-- Custom display names
UPDATE metadata.properties SET display_name = 'Child', sort_order = 1, column_width = 1
WHERE table_name = 'child_checkin' AND column_name = 'child_name';

UPDATE metadata.properties SET display_name = 'Classroom', sort_order = 2, column_width = 1
WHERE table_name = 'child_checkin' AND column_name = 'classroom';
```

### Permission & Grant Configuration

```sql
-- RBAC: grant page access to roles
SELECT grant_custom_page_permission('student_lookup', role_id, 'navigate')
FROM metadata.roles WHERE role_key = 'check_in_operator';
SELECT grant_custom_page_permission('student_lookup', role_id, 'submit')
FROM metadata.roles WHERE role_key = 'check_in_operator';
SELECT grant_custom_page_permission('child_checkin', role_id, 'navigate')
FROM metadata.roles WHERE role_key = 'check_in_operator';
SELECT grant_custom_page_permission('child_checkin', role_id, 'submit')
FROM metadata.roles WHERE role_key = 'check_in_operator';

-- Supervisor: can view but not submit
SELECT grant_custom_page_permission('student_lookup', role_id, 'navigate')
FROM metadata.roles WHERE role_key = 'supervisor';
SELECT grant_custom_page_permission('child_checkin', role_id, 'navigate')
FROM metadata.roles WHERE role_key = 'supervisor';

-- Database grants for SECURITY INVOKER RPCs
GRANT SELECT ON children, classrooms, attendance TO check_in_operator, supervisor;
GRANT INSERT ON attendance TO check_in_operator;
GRANT EXECUTE ON FUNCTION get_student_lookup_context TO check_in_operator, supervisor;
GRANT EXECUTE ON FUNCTION submit_student_lookup TO check_in_operator;
GRANT EXECUTE ON FUNCTION get_checkin_context TO check_in_operator, supervisor;
GRANT EXECUTE ON FUNCTION submit_checkin TO check_in_operator;
```

### User Flow

```
1. Parent navigates to /page/student-lookup
2. Page shows: today's date (readonly) + PIN input field
3. Parent types PIN → submits
4. Submit RPC validates → navigates to /page/child-checkin/42
5. Page shows: child name, classroom, allergies (readonly) + action dropdown, notes (writable)
6. Parent selects "Check In" → submits
7. Submit RPC creates attendance record → navigates to /page/student-lookup
8. Page resets for next child
```

---

## Permissions

Custom pages use a **dedicated RBAC permission model** following the entity action pattern (`metadata.entity_action_roles`). Two permission types control page-level access; underlying data access is enforced by SECURITY INVOKER RPCs + table grants + RLS.

### Two-Layer Model

| Layer | Controls | Mechanism |
|-------|----------|-----------|
| **RBAC (page access)** | Who can see the page, who can submit | `metadata.custom_page_roles` junction table |
| **Database (data access)** | What rows/columns the user can read/write | SECURITY INVOKER RPCs + table grants + RLS |

This mirrors entity pages where RBAC gates the CRUD buttons but RLS filters the actual data.

### Permission Types

| Permission | Gates | Effect when missing |
|-----------|-------|-------------------|
| `navigate` | Sidebar visibility + page access | Page invisible, route inaccessible |
| `submit` | Form submission | All fields render as display, submit button hidden |

| Role config | Experience |
|------------|-----------|
| Neither | Page invisible, cannot access |
| `navigate` only | Page visible, full readonly mode |
| `navigate` + `submit` | Full access — context + form + submit |
| `submit` only | No effect (can't reach the page) |

### Database Schema

**Junction table:**
```sql
CREATE TABLE metadata.custom_page_roles (
    custom_page_entity NAME NOT NULL,  -- table_name of the custom page VIEW
    role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('navigate', 'submit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (custom_page_entity, role_id, permission)
);

CREATE INDEX idx_custom_page_roles_role ON metadata.custom_page_roles(role_id);
```

**Permission check function:**
```sql
CREATE FUNCTION has_custom_page_permission(p_table_name TEXT, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT
        public.is_admin()
        OR EXISTS (
            SELECT 1
            FROM metadata.custom_page_roles cpr
            JOIN metadata.roles r ON r.id = cpr.role_id
            WHERE cpr.custom_page_entity = p_table_name
              AND cpr.permission = p_permission
              AND r.role_key = ANY(public.get_user_roles())
        )
$$;
```

**Computed columns in `schema_entities`:**
```sql
-- Added to schema_entities VIEW definition
CASE WHEN me.context_rpc IS NOT NULL
     THEN has_custom_page_permission(tables.table_name::TEXT, 'navigate')
     END AS can_navigate,
CASE WHEN me.submit_rpc IS NOT NULL
     THEN has_custom_page_permission(tables.table_name::TEXT, 'submit')
     END AS can_submit
```

These are cached by the frontend alongside existing entity metadata — no extra queries.

### Admin UI Integration

**Admin RPCs** (following the `grant_entity_action_permission` / `revoke_entity_action_permission` pattern):
```sql
get_custom_page_roles(p_role_id INT)
    → TABLE(custom_page_entity NAME, permission TEXT)

grant_custom_page_permission(p_table_name TEXT, p_role_id INT, p_permission TEXT)
    → JSONB {success}

revoke_custom_page_permission(p_table_name TEXT, p_role_id INT, p_permission TEXT)
    → JSONB {success}
```

**Permissions page**: A new "Custom Pages" tab alongside "Table Permissions", "Actions", and "Role Delegation". Displays a matrix of roles × custom pages with navigate/submit checkboxes:

```
                    Child Check-In    Student Lookup
                    nav    submit     nav    submit
 ─────────────────────────────────────────────────
 admin              ✓       ✓         ✓       ✓
 check_in_operator  ✓       ✓         ✓       ✓
 supervisor         ✓       ✗         ✓       ✗
 user               ✗       ✗         ✗       ✗
```

### Frontend Usage

**Sidebar visibility**: `show_in_sidebar AND entity.can_navigate`

**Submit button visibility**: `entity.can_submit`

**`SchemaEntityTable` additions:**
```typescript
can_navigate?: boolean;  // Has 'navigate' permission for this custom page
can_submit?: boolean;    // Has 'submit' permission for this custom page
```

### SECURITY INVOKER Convention

Custom page RPCs use `SECURITY INVOKER` (consistent with the project convention for VIEWs). The RPC runs with the caller's permissions — the context RPC's queries respect SELECT grants and RLS, the submit RPC's writes respect INSERT/UPDATE grants and RLS. No privilege escalation.

The RBAC layer (`custom_page_roles`) controls **page access**. The database layer (grants + RLS) controls **data access**. Both must pass for the user to see data or submit forms.

### Relationship to Entity Permissions

Custom pages don't use the standard `select`/`insert`/`update`/`delete` entity permission model from `metadata.permissions`. The shape VIEW typically isn't granted directly to roles for PostgREST access — data flows through RPCs. The `can_navigate` and `can_submit` columns replace the CRUD permission matrix for custom pages.

---

## Edge Cases & Constraints

### VIEW Column Types

The shape VIEW's columns determine property type detection via `SchemaService.getPropertyType()`. Most types work naturally:

| VIEW column definition | Detected type | Works? |
|-----------------------|---------------|--------|
| `c.display_name AS child_name` | TextShort | Yes |
| `c.classroom_id` (FK) | ForeignKeyName | Yes — FK auto-detected from VIEW's column lineage |
| `c.status_id` (with status config) | Status | Yes — if `metadata.properties` has `status_entity_type` |
| `NULL::TEXT AS notes` | TextShort | Yes |
| `c.photo_url` (FileImage) | FileImage | Needs metadata override |
| `count(*)::INT AS visit_count` | IntegerNumber | Yes |
| `c.allergy_notes` (TextLong) | Depends on `udt_name` | May need metadata override |

Computed or NULL-cast columns lose FK lineage from `information_schema`. For these, the integrator configures the property type via `metadata.properties` overrides — the same pattern used for Virtual Entities today.

### Form-Only Fields

Columns like `NULL::TEXT AS action` exist in the VIEW purely to give them schema presence. They have no data source — the context RPC returns `null` for them, and their values flow only to the submit RPC.

This is an intentional pattern, not a hack. The VIEW defines the page's complete field set; the split between "has data" and "collects input" is handled by `is_readonly`, not by the VIEW's query logic.

### No-ID Pages

When the route has no `:id` parameter:
- The context RPC is called with no arguments
- The submit RPC is called without `p_id`
- The RPC signatures must not require `p_id` (no parameter, or parameter with a default)

The `schema_rpc_parameters` introspection handles this naturally — if `p_id` isn't in the function signature, the frontend doesn't send it.

### Custom Pages Without Submit

If `submit_rpc IS NULL`, the page is read-only:
- All fields render as display (regardless of `is_readonly`)
- No form controls, no submit button
- Useful for composed read-only views (e.g., a cross-entity summary dashboard-style page)

This is distinct from a Virtual Entity Detail page: the custom page uses a context RPC for data loading (enabling complex multi-source assembly), while a Virtual Entity uses standard PostgREST queries.

---

## Future Enhancements

These are explicitly out of scope for v1 but identified as natural extensions:

### File & Photo Gallery Support
File uploads and photo gallery editors on custom pages. Would require the submit RPC to handle file reference IDs, and the frontend to coordinate upload + submit flows.

### M:M Relationship Editors
Allowing custom pages to include M:M editors for junction table management. Would reuse existing `ManyToManyEditorComponent`.

### Conditional Field Visibility
Fields that show/hide based on other field values. Could reuse the `ActionCondition` system already used by entity action visibility/enabled conditions:
```json
{ "visible_when": { "field": "action", "operator": "eq", "value": "check_out" } }
```

### Context Refresh on Field Change
Re-calling the context RPC when a writable field changes, to update readonly fields. Could reuse the `depends_on_columns` pattern from FK cascading dropdowns.

### Kiosk Mode
A `?kiosk=true` query parameter or entity flag that hides the sidebar and navbar for tablet/terminal deployments. A separate concern from the custom page data flow.

### Entity Action Buttons on Custom Pages
Allowing `metadata.entity_actions` to target custom page entities, rendering action buttons alongside the submit button.

### Multiple Submit Actions
Supporting multiple submit RPCs on one page (e.g., "Approve" and "Reject" buttons). Could be modeled as entity actions rather than multiple submit RPCs.

---

## Appendix: Separate Table Alternative

**Status**: Deferred — reconsider before v1.0

The current design stores custom page configuration on `metadata.entities` (Approach A). An alternative is a dedicated `metadata.custom_pages` table (Approach B). This appendix documents the tradeoffs for future review.

### Why This Matters

Custom pages share ~5 columns with entities (`display_name`, `description`, `sort_order`, `show_in_sidebar`, `table_name`) but don't use ~15 entity-specific columns (map, calendar, payment, notes, recurring, guided form, search, etc.). Placing custom pages on the entities table means those ~15 columns sit NULL on every custom page row, and the `SchemaEntityTable` interface carries fields that are meaningless for custom pages.

### What Approach B Looks Like

```sql
CREATE TABLE metadata.custom_pages (
    page_key     NAME PRIMARY KEY,       -- VIEW name
    display_name TEXT NOT NULL,
    description  TEXT,
    icon         TEXT,
    context_rpc  TEXT NOT NULL,
    submit_rpc   TEXT,
    submit_label TEXT DEFAULT 'Submit',
    show_in_sidebar BOOLEAN DEFAULT TRUE,
    sort_order   INT DEFAULT 100,
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE VIEW schema_custom_pages
WITH (security_invoker = true) AS
SELECT
    cp.*,
    has_custom_page_permission(cp.page_key::TEXT, 'navigate') AS can_navigate,
    has_custom_page_permission(cp.page_key::TEXT, 'submit') AS can_submit
FROM metadata.custom_pages cp;
```

The property pipeline (`schema_properties`, `metadata.properties`) is unaffected — it's keyed by `table_name`/`page_key` regardless.

### Comparison

| Dimension | A: On `metadata.entities` | B: Separate table |
|-----------|--------------------------|-------------------|
| New schema objects | 3 columns | 1 table + 1 VIEW |
| NULL noise | ~15 irrelevant columns per row | None |
| Detection | Implicit (`context_rpc IS NOT NULL`) | Explicit (row exists in `custom_pages`) |
| Property pipeline | Works unchanged | Works unchanged |
| Sidebar | Single data source | Merge two sources (concat + sort) |
| Admin UI | Entity Management page covers it | Needs separate admin page |
| TypeScript interface | Reuses `SchemaEntityTable` (growing) | Clean `CustomPage` interface |
| Code volume | Less | More |
| Conceptual clarity | Custom page = entity variant | Custom page = peer of entities |

### Decision

Approach A chosen for initial implementation because it requires less code and follows the Virtual Entity precedent. However, custom pages share much less with entities (~30%) than Virtual Entities do (~90%), which makes the "entity variant" framing weaker.

**Revisit trigger**: If `metadata.entities` or `SchemaEntityTable` accumulates more entity-specific columns before v1.0, or if the implicit detection causes integrator confusion, migrate to Approach B. The migration would be:
1. Create `metadata.custom_pages` table
2. Copy rows where `context_rpc IS NOT NULL` from `metadata.entities`
3. Remove `context_rpc`/`submit_rpc`/`submit_label` columns from `metadata.entities`
4. Update frontend to load from `schema_custom_pages`
5. Property pipeline unchanged (keyed by VIEW name either way)
