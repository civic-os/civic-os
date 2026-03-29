# Soft Delete (Archive) System Design

**Version**: Proposed for v0.42.0+
**Status**: Design
**Related**: Entity Notes soft delete (`v0-16-0`), Status terminal states (`v0-15-0`), Bulk Actions (future)

## Overview

### Problem

Civic OS currently performs hard deletes via `HTTP DELETE` to PostgREST. Once a record is deleted, it's gone. This is problematic for government and civic applications where:

- Audit trails require visibility into what was removed and when
- Accidental deletions need a recovery path
- Compliance may require data retention even after "deletion"
- Users need to distinguish between "no longer active" and "permanently removed"

### Design Goals

1. **Convention-based opt-in**: Any table with a `deleted_at TIMESTAMPTZ` column automatically gets soft delete behavior — no metadata configuration required
2. **RLS-enforced visibility**: Archived records are invisible to users without DELETE permission at the database level, not the application level
3. **Permission reuse**: The existing DELETE permission controls archive, unarchive, and visibility of archived records — no new permissions
4. **Minimal query changes**: Normal users require zero frontend query modifications (RLS handles filtering). Only DELETE-permission users need frontend filter logic (for the toggle)
5. **Automatic UX adaptation**: "Delete" becomes "Archive" in the UI automatically when an entity supports soft delete

### Relationship to Existing Patterns

| Pattern | Purpose | Mechanism | Scope |
|---|---|---|---|
| **Soft Delete (this design)** | Reversible removal with audit trail | `deleted_at` column + RLS | Framework-level, any entity |
| **Entity Notes `deleted_at`** | Soft delete for notes specifically | `deleted_at` + VIEW filter | Single table (`metadata.entity_notes`) |
| **Terminal Status (`is_terminal`)** | Workflow end state | Status flag, no RLS | Per-status-type, display only |
| **Active/Inactive flags** | Business logic toggle | `active`/`is_active` BOOLEAN | Ad-hoc, per-application |

This design **does not replace** the other patterns. Terminal statuses remain a workflow concept (a "Closed" issue is still visible, just done). Active/inactive flags remain application-specific business logic. This design elevates the entity_notes `deleted_at` pattern into a framework convention.

## Database Layer

### Column Convention

Any public table that includes this column opts into soft delete:

```sql
deleted_at TIMESTAMPTZ DEFAULT NULL
```

- `NULL` = active record
- `NOT NULL` = archived record (timestamp records when it was archived)
- The framework detects this column automatically via `schema_properties` — no `metadata.entities` flag needed
- `deleted_at` is hidden from user-facing UI (`show_on_list`, `show_on_create`, `show_on_edit`, `show_on_detail` all FALSE in `schema_properties` smart defaults)

### Migration Helper Function

Following the `enable_entity_notes()` pattern:

```sql
CREATE OR REPLACE FUNCTION public.enable_soft_delete(p_table_name NAME)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_fk_column RECORD;
BEGIN
  -- 1. Add deleted_at column if not exists
  EXECUTE format(
    'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL',
    p_table_name
  );

  -- 2. Create partial indexes on all FK columns (WHERE deleted_at IS NULL)
  --    These accelerate the common case: listing active records filtered by FK
  FOR v_fk_column IN
    SELECT kcu.column_name
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.table_constraints tc
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = p_table_name::TEXT
      AND tc.constraint_type = 'FOREIGN KEY'
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%I_%I_active ON public.%I(%I) WHERE deleted_at IS NULL',
      p_table_name, v_fk_column.column_name,
      p_table_name, v_fk_column.column_name
    );
  END LOOP;

  -- 3. Add RLS policy: hide archived records from users without DELETE permission
  --    This is additive — existing SELECT policies still apply
  EXECUTE format(
    'CREATE POLICY soft_delete_visibility ON public.%I
       FOR SELECT USING (
         deleted_at IS NULL
         OR has_permission(%L, ''delete'')
       )',
    p_table_name, p_table_name
  );

  -- 4. Block UPDATE on archived records (prevent editing archived data)
  --    RESTRICTIVE ensures this is an additional constraint on top of existing UPDATE policies
  EXECUTE format(
    'CREATE POLICY soft_delete_no_edit ON public.%I
       AS RESTRICTIVE
       FOR UPDATE USING (
         deleted_at IS NULL
       )',
    p_table_name
  );

  -- 5. Block hard DELETE (convert to archive via RPC instead)
  --    Drop any existing permissive DELETE policy and add restrictive one
  EXECUTE format(
    'CREATE POLICY soft_delete_no_hard_delete ON public.%I
       AS RESTRICTIVE
       FOR DELETE USING (FALSE)',
    p_table_name
  );

  -- 6. Hide deleted_at from UI forms
  INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
  VALUES (p_table_name, 'deleted_at', FALSE, FALSE, FALSE, FALSE)
  ON CONFLICT (table_name, column_name)
  DO UPDATE SET show_on_list = FALSE, show_on_create = FALSE, show_on_edit = FALSE, show_on_detail = FALSE;
END;
$$;
```

**Usage:**

```sql
-- Enable soft delete on any table
SELECT enable_soft_delete('issues');
SELECT enable_soft_delete('permits');

-- Document the decision
SELECT create_schema_decision(
  'issues', 'Enable soft delete',
  'Government records require audit trail and recovery capability'
);
```

### Why No Partial Index on Primary Key

A primary key lookup (`WHERE id = 5`) is a point query — PostgreSQL uses the PK index to find exactly one row and applies `deleted_at IS NULL` as a cheap heap filter on that single tuple. A partial PK index saves zero work.

Partial indexes matter on columns used in **range scans** for list queries (FK columns, sort columns, search vectors) where the planner scans potentially thousands of rows.

### Hard Delete Prevention

The `RESTRICTIVE` DELETE policy (`USING (FALSE)`) blocks all `HTTP DELETE` requests via PostgREST. This means:

- Applications **cannot** accidentally hard-delete records on soft-delete entities
- Archive/unarchive happens exclusively through the RPC functions (see below)
- If a future need arises for permanent purge (data retention policy), a separate admin-only RPC can be created that bypasses RLS

## RLS Policy Pattern

The `enable_soft_delete()` function creates three policies:

| Policy | Operation | Rule | Mode | Purpose |
|---|---|---|---|---|
| `soft_delete_visibility` | SELECT | `deleted_at IS NULL OR has_permission(table, 'delete')` | PERMISSIVE | Hide archived from non-deleters |
| `soft_delete_no_edit` | UPDATE | `deleted_at IS NULL` | RESTRICTIVE | Block editing archived records |
| `soft_delete_no_hard_delete` | DELETE | `FALSE` | RESTRICTIVE | Prevent all hard deletes |

**Interaction with existing RLS policies:**

- These policies are **additive** to any existing SELECT/UPDATE/DELETE policies on the table
- PostgreSQL's RLS evaluation: a row must pass ALL restrictive policies AND at least one permissive policy
- The SELECT visibility policy is **permissive** — it works alongside existing `has_permission(table, 'select')` policies
- The UPDATE policy is **restrictive** — it adds a `deleted_at IS NULL` constraint on top of existing update policies, so archived records can't be edited even by users who normally have UPDATE permission
- The DELETE policy is **restrictive** — it overrides any permissive DELETE policies, ensuring hard deletes are blocked

### Performance Consideration

`has_permission()` executes a JOIN across `roles → permission_roles → permissions` on every row evaluation. For tables with many archived records and users with DELETE permission, this could be expensive on large result sets.

**Mitigation**: The partial indexes on FK columns (`WHERE deleted_at IS NULL`) ensure that the common case (active records only) uses efficient index scans. The `has_permission()` evaluation only applies to users who can see archived records, and these are typically power users viewing smaller, filtered result sets.

## API Layer: Generic RPCs

### archive_entity

```sql
CREATE OR REPLACE FUNCTION public.archive_entity(
  p_entity_type NAME,
  p_entity_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Validate: entity supports soft delete (has deleted_at column)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_entity_type::TEXT
      AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION 'Entity % does not support soft delete', p_entity_type;
  END IF;

  -- Validate: caller has DELETE permission
  IF NOT has_permission(p_entity_type::TEXT, 'delete') THEN
    RAISE EXCEPTION 'Insufficient permissions to archive %', p_entity_type
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  -- Archive the record
  EXECUTE format(
    'UPDATE public.%I SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
    p_entity_type
  ) USING p_entity_id;

  -- Future: INSERT INTO metadata.entity_notes for audit trail
  -- 'Record archived by ' || current_user_email()
END;
$$;
```

### unarchive_entity

```sql
CREATE OR REPLACE FUNCTION public.unarchive_entity(
  p_entity_type NAME,
  p_entity_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Same validations as archive_entity...

  -- Unarchive the record (SECURITY DEFINER bypasses soft_delete_no_edit policy)
  EXECUTE format(
    'UPDATE public.%I SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL',
    p_entity_type
  ) USING p_entity_id;
END;
$$;
```

**Design notes:**

- `SECURITY DEFINER` is required because the `soft_delete_no_edit` RLS policy blocks UPDATE on archived records — the unarchive RPC needs to bypass this
- Both RPCs use dynamic SQL (`EXECUTE format(...)`) following the same pattern as `enable_entity_notes()`
- The `p_entity_id` parameter is TEXT for flexibility with both integer and UUID primary keys
- The `AND deleted_at IS NULL` / `AND deleted_at IS NOT NULL` guards prevent double-archiving or double-restoring

### Future Extensions

- **`deleted_by UUID`**: Add an audit column tracking who archived the record. The RPC sets this via `current_user_id()`
- **System note on archive**: Auto-create an entity note (if notes are enabled) recording the archive event
- **Bulk archive RPC**: `archive_entities(p_entity_type, p_entity_ids TEXT[])` for batch operations

## Schema Detection

### schema_entities VIEW Change

Detection is computed in the `schema_entities` VIEW itself, keeping the source of truth at the database level — consistent with how `show_calendar`, `enable_notes`, and other entity flags work:

```sql
-- Added to schema_entities VIEW SELECT clause
EXISTS (
  SELECT 1 FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = tables.table_name::text
    AND c.column_name = 'deleted_at'
    AND c.udt_name = 'timestamptz'
) AS supports_soft_delete
```

### SchemaEntityTable Interface

Add `supports_soft_delete` to the TypeScript interface:

```typescript
// In SchemaEntityTable interface (src/app/interfaces/entity.ts)
supports_soft_delete?: boolean;  // v0.42.0 — auto-detected from deleted_at column
```

No frontend detection logic needed — `SchemaService` receives it directly from the VIEW response.

### Property Visibility

The `enable_soft_delete()` helper sets `show_on_list/create/edit/detail = FALSE` for the `deleted_at` column, so it won't appear in forms or tables. However, the List page needs access to the raw value for:

- Visual treatment of archived rows (opacity/strikethrough)
- Filter bar Active/Archived logic

The List page adds `deleted_at` to the PostgREST `select` fields when the entity supports soft delete **and** the user has DELETE permission.

## Frontend Changes

### Filter Bar Integration

The archive filter lives inside the existing filter dropdown, not as a standalone toggle. This keeps the UX consistent — users go to one place for all filtering.

**New section at top of filter dropdown** (before column filters):

```
┌─────────────────────────────────┐
│  ☑ Active    ☐ Archived        │  ← New "Visibility" section
│─────────────────────────────────│
│  Status         Priority        │  ← Existing column filters
│  ☑ Open         ☑ High         │
│  ☐ Closed       ☐ Medium       │
│  ...            ☐ Low          │
└─────────────────────────────────┘
```

**Visibility rules:**
- Only shown when: entity has `supportsSoftDelete = true` AND user has DELETE permission on the entity
- Users without DELETE permission never see this section (RLS already hides archived records from them)

**Three states:**

| Active | Archived | PostgREST Filter | Filter Chip |
|---|---|---|---|
| ☑ | ☐ | `deleted_at=is.null` | (none — this is the default, no chip needed) |
| ☑ | ☑ | (no deleted_at filter) | "Showing archived" |
| ☐ | ☑ | `deleted_at=not.is.null` | "Archived only" |

**Default behavior**: Active checked, Archived unchecked. This means DELETE-permission users see the same results as everyone else by default, with the option to reveal archived records.

**Archived-only mode** (Active unchecked, Archived checked) enables review workflows: a manager reviewing what was archived last month, bulk restoring mistakenly archived records, etc.

### List Page Changes

- Pass `supportsSoftDelete` and `hasDeletePermission` to FilterBar component
- When soft delete is supported and user has DELETE permission, include `deleted_at` in select fields
- Apply default filter `deleted_at=is.null` (same as default checkbox state)
- **Visual treatment for archived rows**: When showing both active and archived, archived rows get reduced opacity (`opacity-50`) and an "Archived" badge. This is a CSS class applied based on the row's `deleted_at` value.

### Detail Page Changes

**For soft-delete entities:**

- **Archive button** replaces Delete button
  - Label: "Archive" (not "Delete")
  - Icon: `archive` (Material Symbols)
  - Confirmation modal: "Archive this {entity display name}? It can be restored later."
  - Calls `archiveRecord()` on DataService

- **On archived records:**
  - **Banner**: "This record was archived on {formatted date}." with a Restore button
  - **Edit button**: Hidden (archived records can't be edited — RLS also enforces this)
  - **Restore button**: Calls `restoreRecord()` on DataService, refreshes page
  - **Archive button**: Hidden (already archived)

**For non-soft-delete entities:** No changes. Delete button works as before (hard delete).

### DataService Changes

```typescript
// New methods
archiveRecord(entityType: string, id: string | number): Observable<ApiResponse> {
  return this.http.post(getPostgrestUrl() + 'rpc/archive_entity', {
    p_entity_type: entityType,
    p_entity_id: String(id)
  });
}

restoreRecord(entityType: string, id: string | number): Observable<ApiResponse> {
  return this.http.post(getPostgrestUrl() + 'rpc/unarchive_entity', {
    p_entity_type: entityType,
    p_entity_id: String(id)
  });
}
```

Existing `deleteData()` remains unchanged for non-soft-delete entities.

## Bulk Actions (Future)

The List page currently has no multi-select or bulk action UI. When bulk actions are implemented:

- **Bulk Archive**: Select multiple records → "Archive Selected" action
- **Bulk Restore**: In archived-only view → "Restore Selected" action
- Both require DELETE permission
- The archive RPC can be extended with a batch variant: `archive_entities(p_entity_type, p_entity_ids TEXT[])`

This should be noted in the bulk actions design when that feature is built.

## Index Strategy

### Indexes Created by `enable_soft_delete()`

For each FK column on the table:

```sql
CREATE INDEX idx_{table}_{fk_column}_active
  ON public.{table}({fk_column})
  WHERE deleted_at IS NULL;
```

### What's NOT Indexed

- **Primary key**: Point queries don't benefit from partial indexes
- **Full-table indexes**: Existing indexes remain for queries that include archived records (admin "show all" mode)

### Integrator Guidance

If your soft-delete entity has additional columns used in list filters or sort orders, consider adding partial indexes manually:

```sql
-- Example: frequently sorted by created_at
CREATE INDEX idx_issues_created_active ON issues(created_at DESC)
  WHERE deleted_at IS NULL;

-- Example: full-text search on active records only
CREATE INDEX idx_issues_search_active ON issues
  USING GIN(civic_os_text_search)
  WHERE deleted_at IS NULL;
```

## Terminal Status Default Filtering

This is a **related but distinct** UX pattern. While soft delete uses RLS to enforce visibility, terminal status filtering is purely a frontend convenience.

### Concept

Entities with status columns often accumulate "done" records (Closed, Completed, Resolved) that clutter the default list view. Terminal status filtering hides these by default.

### Proposed Approach

- **Filter bar integration**: For status-enabled entities, add a "Show closed" checkbox (or "Open" / "Closed" checkbox pair, mirroring the Active/Archived pattern)
- **Default**: Terminal statuses excluded from the default filter
- **No RLS**: All users can see terminal-status records — this is a display preference, not a permission gate
- **Optional metadata flag**: `metadata.entities.hide_terminal_by_default BOOLEAN DEFAULT FALSE` — integrators opt in per entity

### Differences from Soft Delete

| Aspect | Soft Delete | Terminal Status |
|---|---|---|
| Visibility control | RLS (database-enforced) | Frontend filter (preference) |
| Permission gate | DELETE permission required | No permission gate |
| Default behavior | Hidden for all users | Hidden only if entity opts in |
| Recovery action | "Restore" (unarchive) | Change status (re-open) |

## Edge Cases and Cascade Behavior

### Archiving a Parent Record

Archiving a parent does **not** cascade to children. A permit with 5 inspections: archiving the permit leaves the inspections visible. This is intentional:

- Cascade archives are hard to undo correctly
- Related records may have independent business value
- The FK reference to an archived parent is displayed with a visual indicator (dimmed name, "archived" badge)

### FK References to Archived Records

When a FK dropdown (on Create/Edit pages) references a table with soft delete:

- **Users without DELETE permission**: RLS hides archived options — dropdown only shows active records. No frontend change needed.
- **Users with DELETE permission**: Dropdown shows all records. This is acceptable since these are power users. If needed, a future enhancement could add a `deleted_at=is.null` filter to FK option queries.

### FK Display on List/Detail Pages

When a record references an archived FK target:

- The referenced name still displays (the JOIN resolves because the current user may or may not have DELETE permission)
- If the user can see the archived record: normal display
- If the user cannot see it (no DELETE permission): the JOIN returns NULL, display shows the raw ID or "Unknown" — **this is a known limitation** that may need a VIEW-based solution for FK display names

### Many-to-Many Relationships

Junction table rows are preserved when either side is archived. The junction table itself does not have `deleted_at`. The many-to-many editor on a Detail page respects RLS: if a related record is archived, it won't appear in the editor for non-DELETE users.

### Entity Notes on Archived Records

Notes attached to an archived record remain accessible. If a DELETE-permission user navigates to an archived record's detail page, they see the full note history. Entity notes have their own `deleted_at` column (independent of the parent entity's archive state).

### Search, Dashboards, and Export

- **Full-text search**: RLS handles filtering — no change needed
- **Dashboard widgets**: RLS handles filtering — no change needed
- **Excel export**: Exports respect current list page filters. Default (Active only) excludes archived. "Show Archived" toggle includes them.
- **Excel import**: Import always creates active records (`deleted_at = NULL`). No change needed.

### Recurring Series

Archiving a series template vs. individual instances is a separate concern. The recurring series system already has scope-aware cancellation ("This only", "This and future", "All"). Soft delete on the parent entity (if it has `deleted_at`) follows the standard pattern — archive the entity, leave series/instances untouched.
