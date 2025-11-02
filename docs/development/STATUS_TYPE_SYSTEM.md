# Status Type System Design

**Version:** 0.10.0
**Status:** Design Specification
**Author:** Civic OS Core Team
**Last Updated:** 2025-01-02

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [Integration Guide](#integration-guide)
5. [Frontend Implementation](#frontend-implementation)
6. [Admin UI Specification](#admin-ui-specification)
7. [Migration Strategy](#migration-strategy)
8. [Future: Workflow Engine](#future-workflow-engine)

---

## Overview

### Problem Statement

Current Civic OS applications require integrators to create separate lookup tables for statuses:
```sql
CREATE TABLE issue_statuses (...);
CREATE TABLE workpackage_statuses (...);
CREATE TABLE request_statuses (...);
```

This creates:
- **Schema clutter**: Multiple small lookup tables in `public` schema
- **Boilerplate**: Repetitive table creation for each entity
- **No standardization**: Each integrator implements status differently
- **Limited workflow support**: No framework-level transition rules

### Solution: Framework-Level Status Type

Elevate Status to a **first-class framework type** (like File and User):
- Single `metadata.statuses` table provided by framework
- Integrators add status **values** for their entities via UI
- Composite FK pattern ensures type safety: `Status<Issue>` ≠ `Status<WorkPackage>`
- Foundation for future workflow engine

### Design Principles

1. **Clear Boundary**: Framework creates tables, integrators add values
2. **Type Safety**: Composite FKs prevent cross-entity status references
3. **Zero Boilerplate**: No status table creation required
4. **Schema Clarity**: `metadata` schema for types, `public` schema for entities
5. **Future-Proof**: Foundation for state machine workflows

---

## Architecture

### Architectural Layers

#### Framework Layer (`metadata` schema)
**Provided by Civic OS migrations:**
```sql
metadata.statuses              -- Status definitions
metadata.status_transitions    -- Workflow rules
metadata.validate_status_transition()  -- Validation RPC
```

#### Application Layer (`public` schema)
**Created by integrators:**
```sql
public.issues (
  status_id INT,
  status_entity_type TEXT GENERATED ALWAYS AS ('issue') STORED,
  FOREIGN KEY (status_id, status_entity_type) → metadata.statuses
)
```

#### Configuration Layer
**Managed via Admin UI or SQL:**
```sql
-- Add status values for 'issue' entity
INSERT INTO metadata.statuses (entity_type, display_name, ...)
VALUES ('issue', 'New', ...);

-- Define allowed transitions
INSERT INTO metadata.status_transitions (...)
VALUES ('issue', 1, 2, ...);
```

### Comparison to Existing System Types

| Type | Framework Table | Discriminator | Usage Pattern |
|------|----------------|---------------|---------------|
| **File** | `metadata.files` | `mimetype` | `file_id UUID REFERENCES metadata.files(id)` |
| **User** | `metadata.civic_os_users` | (none) | `user_id UUID REFERENCES metadata.civic_os_users(id)` |
| **Status** | `metadata.statuses` | `entity_type` | `status_id INT, status_entity_type TEXT, FK(status_id, status_entity_type) → metadata.statuses(id, entity_type)` |

All three are:
- ✅ Provided by framework migrations
- ✅ Referenced by application tables (public → metadata)
- ✅ Extended by integrators (add rows)
- ✅ Never structurally modified by integrators

---

## Database Schema

### Core Tables

#### `metadata.statuses`

**Purpose:** Stores all status definitions for all entity types.

```sql
CREATE TABLE metadata.statuses (
  -- Identity
  id SERIAL,
  entity_type TEXT NOT NULL,              -- Discriminator: 'issue', 'work_package', etc.

  -- Display properties
  display_name VARCHAR(50) NOT NULL,
  description TEXT,
  color hex_color NOT NULL DEFAULT '#3B82F6',
  sort_order INT NOT NULL,

  -- Status properties
  is_initial BOOLEAN DEFAULT FALSE,       -- Default status for new records
  is_terminal BOOLEAN DEFAULT FALSE,      -- Cannot transition from here

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  PRIMARY KEY (id, entity_type),          -- Composite PK for type safety
  UNIQUE (id),                            -- Also maintain unique ID
  UNIQUE (entity_type, display_name),     -- Unique names per entity
  UNIQUE (entity_type, sort_order)        -- Unique ordering per entity
);

-- Indexes
CREATE INDEX idx_statuses_entity_type ON metadata.statuses(entity_type);
CREATE INDEX idx_statuses_sort_order ON metadata.statuses(entity_type, sort_order);

-- Row-level security
ALTER TABLE metadata.statuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY statuses_select ON metadata.statuses
  FOR SELECT USING (true);  -- Anyone can read

CREATE POLICY statuses_modify ON metadata.statuses
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM get_user_roles()
      WHERE role_name = 'admin'
    )
  );
```

**Sample Data:**
```sql
INSERT INTO metadata.statuses (id, entity_type, display_name, color, sort_order, is_initial) VALUES
  (1, 'issue', 'New', '#3B82F6', 1, true),
  (2, 'issue', 'In Progress', '#F59E0B', 2, false),
  (3, 'issue', 'Resolved', '#10B981', 3, false),
  (4, 'issue', 'Closed', '#6B7280', 4, false),
  (10, 'work_package', 'Planned', '#8B5CF6', 1, true),
  (11, 'work_package', 'Active', '#F59E0B', 2, false),
  (12, 'work_package', 'Complete', '#10B981', 3, false);
```

#### `metadata.status_transitions`

**Purpose:** Defines allowed state transitions and workflow rules.

```sql
CREATE TABLE metadata.status_transitions (
  -- Identity
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,

  -- Transition definition
  from_status_id INT NOT NULL,
  to_status_id INT NOT NULL,

  -- Permission rules
  required_role TEXT,                     -- e.g., 'editor', 'admin'
  required_permission TEXT,               -- e.g., 'issues:close'

  -- Validation rules
  requires_comment BOOLEAN DEFAULT FALSE,
  required_fields TEXT[],                 -- Fields that must be filled

  -- Automation (future)
  on_transition_rpc TEXT,                 -- RPC to call on transition
  auto_assign_to_user UUID REFERENCES metadata.civic_os_users(id),

  -- Metadata
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite FKs enforce type safety
  FOREIGN KEY (from_status_id, entity_type)
    REFERENCES metadata.statuses(id, entity_type) ON DELETE CASCADE,
  FOREIGN KEY (to_status_id, entity_type)
    REFERENCES metadata.statuses(id, entity_type) ON DELETE CASCADE,

  -- Prevent duplicate transitions
  UNIQUE (entity_type, from_status_id, to_status_id)
);

-- Indexes
CREATE INDEX idx_status_transitions_entity_type
  ON metadata.status_transitions(entity_type);
CREATE INDEX idx_status_transitions_from
  ON metadata.status_transitions(from_status_id, entity_type);
CREATE INDEX idx_status_transitions_to
  ON metadata.status_transitions(to_status_id, entity_type);

-- Row-level security
ALTER TABLE metadata.status_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY status_transitions_select ON metadata.status_transitions
  FOR SELECT USING (true);  -- Anyone can read

CREATE POLICY status_transitions_modify ON metadata.status_transitions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM get_user_roles()
      WHERE role_name = 'admin'
    )
  );
```

**Sample Data:**
```sql
INSERT INTO metadata.status_transitions
  (entity_type, from_status_id, to_status_id, required_role, requires_comment)
VALUES
  -- Issue transitions
  ('issue', 1, 2, 'user', false),        -- New → In Progress
  ('issue', 2, 3, 'user', false),        -- In Progress → Resolved
  ('issue', 3, 4, 'user', false),        -- Resolved → Closed
  ('issue', 1, 4, 'editor', true),       -- New → Closed (requires editor + comment)
  ('issue', 4, 1, 'editor', true),       -- Closed → New (reopen, requires editor + comment)

  -- Work package transitions (different rules!)
  ('work_package', 10, 11, 'editor', false),  -- Planned → Active (requires editor)
  ('work_package', 11, 12, 'user', false);    -- Active → Complete
```

### Helper Functions

#### `validate_status_transition()`

**Purpose:** Check if a status transition is allowed.

```sql
CREATE OR REPLACE FUNCTION metadata.validate_status_transition(
  p_entity_type TEXT,
  p_from_status_id INT,
  p_to_status_id INT,
  p_user_role TEXT DEFAULT 'user'
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM metadata.status_transitions
    WHERE entity_type = p_entity_type
      AND from_status_id = p_from_status_id
      AND to_status_id = p_to_status_id
      AND (required_role IS NULL OR required_role = p_user_role)
  );
$$;

-- Usage:
-- SELECT metadata.validate_status_transition('issue', 1, 2, 'user');  -- true
-- SELECT metadata.validate_status_transition('issue', 1, 4, 'user');  -- false (requires editor)
```

#### `get_allowed_transitions()`

**Purpose:** Get list of valid next statuses for a given current status.

```sql
CREATE OR REPLACE FUNCTION metadata.get_allowed_transitions(
  p_entity_type TEXT,
  p_current_status_id INT,
  p_user_role TEXT DEFAULT 'user'
)
RETURNS TABLE (
  status_id INT,
  display_name VARCHAR(50),
  color hex_color,
  requires_comment BOOLEAN,
  required_fields TEXT[]
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    s.id,
    s.display_name,
    s.color,
    t.requires_comment,
    t.required_fields
  FROM metadata.status_transitions t
  JOIN metadata.statuses s ON s.id = t.to_status_id AND s.entity_type = t.entity_type
  WHERE t.entity_type = p_entity_type
    AND t.from_status_id = p_current_status_id
    AND (t.required_role IS NULL OR t.required_role = p_user_role)
  ORDER BY s.sort_order;
$$;

-- Usage:
-- SELECT * FROM metadata.get_allowed_transitions('issue', 1, 'user');
-- Returns: [(2, 'In Progress', '#F59E0B', false, null)]
```

#### `get_initial_status()`

**Purpose:** Get the default initial status for a new record.

```sql
CREATE OR REPLACE FUNCTION metadata.get_initial_status(
  p_entity_type TEXT
)
RETURNS INT
LANGUAGE SQL
STABLE
AS $$
  SELECT id
  FROM metadata.statuses
  WHERE entity_type = p_entity_type
    AND is_initial = true
  LIMIT 1;
$$;

-- Usage:
-- SELECT metadata.get_initial_status('issue');  -- Returns: 1
```

### Schema Introspection Updates

**Extend `schema_properties` view** to detect composite FKs:

```sql
-- Add to schema_properties view (in migration):
SELECT
  -- ... existing columns

  -- New columns for composite FK detection
  CASE
    WHEN fk.composite_fk_columns IS NOT NULL
    THEN true
    ELSE false
  END AS is_composite_fk,

  fk.discriminator_column,
  fk.discriminator_value,

  -- ... rest of columns
FROM ...
LEFT JOIN (
  -- Detect composite FKs to metadata.statuses
  SELECT
    src_table,
    src_column,
    'entity_type' AS discriminator_column,
    -- Extract constant from generated column or CHECK constraint
    CASE
      WHEN src_column = 'status_id'
      THEN (
        SELECT substring(generation_expression FROM '''([^'']+)''')
        FROM information_schema.columns
        WHERE table_name = src_table
          AND column_name LIKE '%entity_type'
      )
    END AS discriminator_value
  FROM information_schema.referential_constraints
  WHERE ...
) fk ON ...
```

This allows frontend to detect:
```json
{
  "column_name": "status_id",
  "join_table": "statuses",
  "join_schema": "metadata",
  "is_composite_fk": true,
  "discriminator_column": "entity_type",
  "discriminator_value": "issue"
}
```

---

## Integration Guide

### Adding Status to Your Entity

#### Step 1: Add Status Columns

**Use generated column pattern for type safety:**

```sql
CREATE TABLE public.issues (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,

  -- Status reference (framework-provided pattern)
  status_id INT NOT NULL,
  status_entity_type TEXT GENERATED ALWAYS AS ('issue') STORED,

  -- Composite FK enforces: can only reference statuses where entity_type='issue'
  FOREIGN KEY (status_id, status_entity_type)
    REFERENCES metadata.statuses(id, entity_type),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for FK performance (REQUIRED)
CREATE INDEX idx_issues_status ON issues(status_id, status_entity_type);
```

**Key components:**
1. `status_id INT NOT NULL` - stores the actual status reference
2. `status_entity_type TEXT GENERATED ALWAYS AS ('issue') STORED` - discriminator (auto-populated)
3. Composite FK with both columns
4. Index on both columns for performance

#### Step 2: Configure Statuses via Admin UI

**Navigate to:** `/admin/statuses`

**Actions:**
1. Click "Add Entity Type"
2. Enter entity type: `issue`
3. Add statuses:
   - New (Blue, #3B82F6, order: 1, initial: ✓)
   - In Progress (Orange, #F59E0B, order: 2)
   - Resolved (Green, #10B981, order: 3)
   - Closed (Gray, #6B7280, order: 4, terminal: ✓)

**Alternative (SQL):**
```sql
INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial) VALUES
  ('issue', 'New', '#3B82F6', 1, true),
  ('issue', 'In Progress', '#F59E0B', 2, false),
  ('issue', 'Resolved', '#10B981', 3, false),
  ('issue', 'Closed', '#6B7280', 4, false);
```

#### Step 3: (Optional) Define Workflow Transitions

**Navigate to:** `/admin/workflows`

**Actions:**
1. Select entity type: `issue`
2. Drag connections between status nodes to define allowed transitions
3. Edit transition properties:
   - From: New → To: In Progress (required_role: user)
   - From: In Progress → To: Resolved (required_role: user)
   - From: Resolved → To: Closed (required_role: user)
   - From: New → To: Closed (required_role: editor, requires_comment: ✓)

**Alternative (SQL):**
```sql
INSERT INTO metadata.status_transitions
  (entity_type, from_status_id, to_status_id, required_role, requires_comment)
VALUES
  ('issue', 1, 2, 'user', false),
  ('issue', 2, 3, 'user', false),
  ('issue', 3, 4, 'user', false),
  ('issue', 1, 4, 'editor', true);
```

#### Step 4: Grant Permissions

**Status values:**
```sql
-- Allow authenticated users to read statuses
GRANT SELECT ON metadata.statuses TO authenticated;

-- Only admins can modify status definitions
-- (Already handled by RLS policies)
```

**Application records:**
```sql
-- Standard CRUD permissions on your entity
GRANT SELECT, INSERT, UPDATE ON public.issues TO authenticated;
```

### Usage Examples

#### Creating Records with Default Status

```sql
-- Get initial status for entity type
SELECT metadata.get_initial_status('issue');  -- Returns: 1

-- Create new issue with default status
INSERT INTO issues (title, description, status_id)
VALUES ('Fix login bug', 'Users cannot log in', 1);
```

**Frontend can auto-populate status_id from `get_initial_status()` RPC.**

#### Updating Status with Validation

```sql
-- Check if transition is valid
SELECT metadata.validate_status_transition('issue', 1, 2, 'user');  -- true

-- If valid, update
UPDATE issues
SET status_id = 2
WHERE id = 123;
```

**Future: Trigger can enforce this automatically.**

#### Querying by Status

```sql
-- Get all open issues (New or In Progress)
SELECT * FROM issues
WHERE status_id IN (
  SELECT id FROM metadata.statuses
  WHERE entity_type = 'issue'
    AND display_name IN ('New', 'In Progress')
);

-- Get all closed issues (terminal statuses)
SELECT * FROM issues
WHERE status_id IN (
  SELECT id FROM metadata.statuses
  WHERE entity_type = 'issue'
    AND is_terminal = true
);
```

### Best Practices

#### ✅ Do:
- Use generated column for `status_entity_type` (no manual entry needed)
- Always create index on composite FK columns
- Use descriptive entity type names (lowercase, underscores)
- Define initial status (is_initial = true) for each entity type
- Set terminal statuses (is_terminal = true) appropriately
- Use semantic color coding (blue=new, orange=active, green=complete, gray=closed)

#### ❌ Don't:
- Manually specify `status_entity_type` in INSERTs (it's auto-generated)
- Skip the composite FK index (causes performance issues)
- Reuse entity type names across different domains
- Create status tables in `public` schema (use framework table)
- Modify `metadata.statuses` structure (extend with additional columns in custom tables if needed)

### Migration Template

**Helper script for adding status to existing entity:**

```bash
#!/bin/bash
# scripts/add-status-to-entity.sh

ENTITY_NAME=$1
ENTITY_TYPE=${2:-$ENTITY_NAME}

cat > "migration_add_status_to_${ENTITY_NAME}.sql" <<EOF
-- Add status columns to ${ENTITY_NAME}
ALTER TABLE public.${ENTITY_NAME}
  ADD COLUMN status_id INT,
  ADD COLUMN status_entity_type TEXT GENERATED ALWAYS AS ('${ENTITY_TYPE}') STORED;

-- Add composite FK
ALTER TABLE public.${ENTITY_NAME}
  ADD CONSTRAINT ${ENTITY_NAME}_status_fk
  FOREIGN KEY (status_id, status_entity_type)
  REFERENCES metadata.statuses(id, entity_type);

-- Create index
CREATE INDEX idx_${ENTITY_NAME}_status
  ON public.${ENTITY_NAME}(status_id, status_entity_type);

-- Set default status for existing records
UPDATE public.${ENTITY_NAME}
SET status_id = (SELECT metadata.get_initial_status('${ENTITY_TYPE}'))
WHERE status_id IS NULL;

-- Make status required going forward
ALTER TABLE public.${ENTITY_NAME}
  ALTER COLUMN status_id SET NOT NULL;
EOF

echo "Generated migration_add_status_to_${ENTITY_NAME}.sql"
```

**Usage:**
```bash
./scripts/add-status-to-entity.sh issues issue
```

---

## Frontend Implementation

### Type System Updates

#### Add Status Property Type

```typescript
// src/app/interfaces/entity.ts

export enum EntityPropertyType {
  // ... existing types
  Status = 'Status',  // NEW: Composite FK to metadata.statuses
}
```

#### Extend Schema Property Interface

```typescript
// src/app/interfaces/entity.ts

export interface SchemaEntityProperty {
  // ... existing properties

  // NEW: Composite FK metadata
  is_composite_fk?: boolean;
  fk_discriminator_column?: string;
  fk_discriminator_value?: string;
}
```

### SchemaService Updates

#### Type Detection

```typescript
// src/app/services/schema.service.ts

private getPropertyType(val: SchemaEntityProperty): EntityPropertyType {
  // NEW: Detect Status type (composite FK to metadata.statuses)
  if (val.is_composite_fk &&
      val.join_table === 'statuses' &&
      val.join_schema === 'metadata') {
    return EntityPropertyType.Status;
  }

  // Existing system type detection
  if (val.udt_name === 'uuid' && val.join_table && isSystemType(val.join_table)) {
    if (val.join_table === 'files') {
      const fileTypeValidation = val.validation_rules?.find(v => v.type === 'fileType');
      if (fileTypeValidation?.value) {
        if (fileTypeValidation.value.startsWith('image/')) {
          return EntityPropertyType.FileImage;
        } else if (fileTypeValidation.value === 'application/pdf') {
          return EntityPropertyType.FilePDF;
        }
      }
      return EntityPropertyType.File;
    } else if (val.join_table === 'civic_os_users') {
      return EntityPropertyType.User;
    }
  }

  // Regular FK detection
  return (['int4', 'int8'].includes(val.udt_name) && val.join_column != null)
    ? EntityPropertyType.ForeignKeyName
    : // ... rest of type detection
}
```

#### Select String Generation

```typescript
// src/app/services/schema.service.ts

public propertyToSelectString(property: SchemaEntityProperty): string {
  switch (this.getPropertyType(property)) {
    case EntityPropertyType.Status:
      // Select status with embedded display metadata
      return `${property.column_name}:${property.join_schema}.${property.join_table}(id,display_name,color)`;

    // ... existing cases
  }
}
```

### EditPropertyComponent Updates

#### Status Dropdown Loading

```typescript
// src/app/components/edit-property/edit-property.component.ts

ngOnInit() {
  const prop = this.prop();
  const propType = this.propType();

  // NEW: Load Status options (filtered by entity_type)
  if (propType === EntityPropertyType.Status) {
    this.selectOptions$ = this.data.getData({
      key: prop.join_table!,
      schema: prop.join_schema,
      fields: ['id', 'display_name', 'color', 'sort_order'],
      filters: [{
        column: prop.fk_discriminator_column!,  // 'entity_type'
        operator: 'eq',
        value: prop.fk_discriminator_value!     // 'issue'
      }],
      orderField: 'sort_order'
    }).pipe(
      map(statuses => statuses.map(s => ({
        id: s.id,
        text: s.display_name,
        color: s.color  // Pass color for badge rendering
      })))
    );
  }

  // Existing FK loading logic
  if (propType === EntityPropertyType.ForeignKeyName) {
    // ... existing code
  }
}
```

#### Status Control Template

```html
<!-- edit-property.component.html -->

<!-- NEW: Status select with color badges -->
@if (propType() === EntityPropertyType.Status) {
  <select
    [formControl]="control"
    class="select select-bordered w-full"
    [class.select-error]="control.invalid && control.touched">
    <option value="">Select status...</option>
    @for (option of selectOptions$ | async; track option.id) {
      <option [value]="option.id">
        {{ option.text }}
      </option>
    }
  </select>

  <!-- Show selected status as badge -->
  @if (control.value) {
    <div class="mt-2">
      @for (option of selectOptions$ | async; track option.id) {
        @if (option.id === control.value) {
          <span
            class="badge badge-lg text-white"
            [style.background-color]="option.color">
            {{ option.text }}
          </span>
        }
      }
    </div>
  }
}
```

### DisplayPropertyComponent Updates

#### Status Badge Rendering

```typescript
// src/app/components/display-property/display-property.component.ts

@Component({
  selector: 'app-display-property',
  templateUrl: './display-property.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DisplayPropertyComponent {
  // ... existing code

  statusColor = computed(() => {
    const type = this.propType();
    const value = this.value();

    if (type === EntityPropertyType.Status && value && typeof value === 'object') {
      return value.color || '#3B82F6';  // Default blue
    }
    return undefined;
  });
}
```

#### Status Display Template

```html
<!-- display-property.component.html -->

<!-- NEW: Status badge with color -->
@if (propType() === EntityPropertyType.Status) {
  @if (value(); as statusObj) {
    <span
      class="badge badge-lg text-white font-medium"
      [style.background-color]="statusColor()">
      {{ statusObj.display_name }}
    </span>
  }
}

<!-- Existing type renderers -->
@if (propType() === EntityPropertyType.ForeignKeyName) {
  <!-- ... existing code -->
}
```

### DataService Updates

**No changes needed** - existing `getData()` method handles filtered queries:

```typescript
// Already supported:
this.data.getData({
  key: 'statuses',
  schema: 'metadata',
  filters: [{ column: 'entity_type', operator: 'eq', value: 'issue' }]
});
```

---

## Admin UI Specification

### Status Management Page (`/admin/statuses`)

**Route:** `/admin/statuses`
**Component:** `StatusManagementPage`
**Permission:** Requires `admin` role

#### Layout

```
┌─────────────────────────────────────────────────┐
│ Status Management                    [+ Add]    │
├─────────────────────────────────────────────────┤
│                                                 │
│ Entity Types:                                   │
│ ┌───────────────┐                              │
│ │ issue        ▼│  ← Select entity type        │
│ └───────────────┘                              │
│                                                 │
│ Statuses for "issue":                          │
│ ┌───────────────────────────────────────────┐ │
│ │ ● New              [Edit] [Delete]        │ │
│ │   #3B82F6  Order: 1  Initial ✓           │ │
│ ├───────────────────────────────────────────┤ │
│ │ ● In Progress      [Edit] [Delete]        │ │
│ │   #F59E0B  Order: 2                       │ │
│ ├───────────────────────────────────────────┤ │
│ │ ● Resolved         [Edit] [Delete]        │ │
│ │   #10B981  Order: 3                       │ │
│ ├───────────────────────────────────────────┤ │
│ │ ● Closed           [Edit] [Delete]        │ │
│ │   #6B7280  Order: 4  Terminal ✓          │ │
│ └───────────────────────────────────────────┘ │
│                                                 │
│ [+ Add Status]                                  │
└─────────────────────────────────────────────────┘
```

#### Features

1. **Entity Type Dropdown:**
   - Lists all entity types with statuses
   - Option to add new entity type
   - Shows count of statuses per entity

2. **Status List:**
   - Color badge with hex code
   - Display name (editable inline)
   - Sort order (drag-to-reorder)
   - Initial/Terminal flags as badges
   - Edit/Delete actions

3. **Add Status Form:**
   - Display name (required)
   - Description (optional)
   - Color picker (hex_color domain)
   - Sort order (auto-increments)
   - Is Initial checkbox
   - Is Terminal checkbox

4. **Bulk Actions:**
   - Copy statuses to another entity type
   - Export as JSON
   - Import from JSON

#### API Endpoints

**GET `/rpc/get_entity_types_with_statuses`:**
```sql
CREATE OR REPLACE FUNCTION get_entity_types_with_statuses()
RETURNS TABLE (
  entity_type TEXT,
  status_count BIGINT
)
LANGUAGE SQL
STABLE
AS $$
  SELECT entity_type, COUNT(*) as status_count
  FROM metadata.statuses
  GROUP BY entity_type
  ORDER BY entity_type;
$$;
```

**GET `/statuses?entity_type=eq.issue`:**
Standard PostgREST query with filter.

**POST `/statuses`:**
Create new status (RLS enforces admin only).

**PATCH `/statuses?id=eq.1`:**
Update status properties.

**DELETE `/statuses?id=eq.1`:**
Delete status (cascade deletes transitions).

### Workflow Management Page (`/admin/workflows`)

**Route:** `/admin/workflows`
**Component:** `WorkflowManagementPage`
**Permission:** Requires `admin` role

#### Layout

```
┌─────────────────────────────────────────────────┐
│ Workflow Management              [Test] [Save]  │
├─────────────────────────────────────────────────┤
│                                                 │
│ Entity Type: ┌───────────┐                     │
│              │ issue    ▼│                     │
│              └───────────┘                     │
│                                                 │
│ ┌───────────────────────────────────────────┐ │
│ │ [Visual Workflow Diagram using JointJS]   │ │
│ │                                           │ │
│ │    ┌─────────┐                           │ │
│ │    │   New   │                           │ │
│ │    │  #3B82F6│───────────┐               │ │
│ │    └─────────┘           │               │ │
│ │         │                ▼               │ │
│ │         ▼         ┌───────────┐          │ │
│ │  ┌────────────┐   │  Closed   │          │ │
│ │  │In Progress │   │  #6B7280  │          │ │
│ │  │  #F59E0B   │   └───────────┘          │ │
│ │  └────────────┘                          │ │
│ │         │                                 │ │
│ │         ▼                                 │ │
│ │  ┌───────────┐                           │ │
│ │  │ Resolved  │                           │ │
│ │  │ #10B981   │──────────────────┐        │ │
│ │  └───────────┘                  │        │ │
│ │                                 ▼        │ │
│ │                          [links to Closed]│ │
│ └───────────────────────────────────────────┘ │
│                                                 │
│ Selected Transition: New → In Progress          │
│ ┌───────────────────────────────────────────┐ │
│ │ Required Role:     [user           ▼]    │ │
│ │ Required Permission: [____________]       │ │
│ │ Requires Comment: [ ]                     │ │
│ │ Required Fields:  [____________]          │ │
│ │                   [+ Add Field]           │ │
│ └───────────────────────────────────────────┘ │
│                                                 │
│ [Test Workflow] [Export JSON] [Import JSON]    │
└─────────────────────────────────────────────────┘
```

#### Features

1. **Visual Workflow Designer:**
   - JointJS-based diagram (similar to Schema Editor)
   - Status nodes with color coding
   - Drag connections to create transitions
   - Click connection to edit transition rules
   - Auto-layout option

2. **Transition Editor:**
   - Required role dropdown (user, editor, admin)
   - Required permission (custom text)
   - Requires comment checkbox
   - Required fields (multi-select of entity properties)

3. **Validation:**
   - "Test Workflow" checks for unreachable states
   - Warns about terminal statuses with outgoing transitions
   - Validates that initial status exists

4. **Import/Export:**
   - JSON export of workflow definition
   - Import workflow from another entity type
   - Template library (common workflows)

#### API Endpoints

**GET `/status_transitions?entity_type=eq.issue`:**
Get all transitions for entity type.

**POST `/status_transitions`:**
Create new transition.

**PATCH `/status_transitions?id=eq.1`:**
Update transition rules.

**DELETE `/status_transitions?id=eq.1`:**
Delete transition.

---

## Migration Strategy

### Phase 1: Core Infrastructure (v0.10.0)

**Sqitch Migration: `v0-10-0-add-status-framework`**

**Deploy:**
```sql
-- deploy/v0-10-0-add-status-framework.sql

BEGIN;

-- Create statuses table
CREATE TABLE metadata.statuses (
  id SERIAL,
  entity_type TEXT NOT NULL,
  display_name VARCHAR(50) NOT NULL,
  description TEXT,
  color hex_color NOT NULL DEFAULT '#3B82F6',
  sort_order INT NOT NULL,
  is_initial BOOLEAN DEFAULT FALSE,
  is_terminal BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, entity_type),
  UNIQUE (id),
  UNIQUE (entity_type, display_name),
  UNIQUE (entity_type, sort_order)
);

CREATE INDEX idx_statuses_entity_type ON metadata.statuses(entity_type);
CREATE INDEX idx_statuses_sort_order ON metadata.statuses(entity_type, sort_order);

-- Create status_transitions table
CREATE TABLE metadata.status_transitions (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  from_status_id INT NOT NULL,
  to_status_id INT NOT NULL,
  required_role TEXT,
  required_permission TEXT,
  requires_comment BOOLEAN DEFAULT FALSE,
  required_fields TEXT[],
  on_transition_rpc TEXT,
  auto_assign_to_user UUID REFERENCES metadata.civic_os_users(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (from_status_id, entity_type)
    REFERENCES metadata.statuses(id, entity_type) ON DELETE CASCADE,
  FOREIGN KEY (to_status_id, entity_type)
    REFERENCES metadata.statuses(id, entity_type) ON DELETE CASCADE,
  UNIQUE (entity_type, from_status_id, to_status_id)
);

CREATE INDEX idx_status_transitions_entity_type ON metadata.status_transitions(entity_type);
CREATE INDEX idx_status_transitions_from ON metadata.status_transitions(from_status_id, entity_type);
CREATE INDEX idx_status_transitions_to ON metadata.status_transitions(to_status_id, entity_type);

-- Create helper functions
CREATE OR REPLACE FUNCTION metadata.validate_status_transition(
  p_entity_type TEXT,
  p_from_status_id INT,
  p_to_status_id INT,
  p_user_role TEXT DEFAULT 'user'
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM metadata.status_transitions
    WHERE entity_type = p_entity_type
      AND from_status_id = p_from_status_id
      AND to_status_id = p_to_status_id
      AND (required_role IS NULL OR required_role = p_user_role)
  );
$$;

CREATE OR REPLACE FUNCTION metadata.get_allowed_transitions(
  p_entity_type TEXT,
  p_current_status_id INT,
  p_user_role TEXT DEFAULT 'user'
)
RETURNS TABLE (
  status_id INT,
  display_name VARCHAR(50),
  color hex_color,
  requires_comment BOOLEAN,
  required_fields TEXT[]
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    s.id,
    s.display_name,
    s.color,
    t.requires_comment,
    t.required_fields
  FROM metadata.status_transitions t
  JOIN metadata.statuses s ON s.id = t.to_status_id AND s.entity_type = t.entity_type
  WHERE t.entity_type = p_entity_type
    AND t.from_status_id = p_current_status_id
    AND (t.required_role IS NULL OR t.required_role = p_user_role)
  ORDER BY s.sort_order;
$$;

CREATE OR REPLACE FUNCTION metadata.get_initial_status(
  p_entity_type TEXT
)
RETURNS INT
LANGUAGE SQL
STABLE
AS $$
  SELECT id
  FROM metadata.statuses
  WHERE entity_type = p_entity_type
    AND is_initial = true
  LIMIT 1;
$$;

-- RLS policies
ALTER TABLE metadata.statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.status_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY statuses_select ON metadata.statuses
  FOR SELECT USING (true);

CREATE POLICY statuses_modify ON metadata.statuses
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM get_user_roles()
      WHERE role_name = 'admin'
    )
  );

CREATE POLICY status_transitions_select ON metadata.status_transitions
  FOR SELECT USING (true);

CREATE POLICY status_transitions_modify ON metadata.status_transitions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM get_user_roles()
      WHERE role_name = 'admin'
    )
  );

-- Grant permissions
GRANT SELECT ON metadata.statuses TO authenticated;
GRANT SELECT ON metadata.status_transitions TO authenticated;

COMMIT;
```

**Revert:**
```sql
-- revert/v0-10-0-add-status-framework.sql

BEGIN;

DROP POLICY IF EXISTS status_transitions_modify ON metadata.status_transitions;
DROP POLICY IF EXISTS status_transitions_select ON metadata.status_transitions;
DROP POLICY IF EXISTS statuses_modify ON metadata.statuses;
DROP POLICY IF EXISTS statuses_select ON metadata.statuses;

DROP FUNCTION IF EXISTS metadata.get_initial_status(TEXT);
DROP FUNCTION IF EXISTS metadata.get_allowed_transitions(TEXT, INT, TEXT);
DROP FUNCTION IF EXISTS metadata.validate_status_transition(TEXT, INT, INT, TEXT);

DROP TABLE IF EXISTS metadata.status_transitions;
DROP TABLE IF EXISTS metadata.statuses;

COMMIT;
```

**Verify:**
```sql
-- verify/v0-10-0-add-status-framework.sql

SELECT
  id, entity_type, display_name, color, sort_order
FROM metadata.statuses
WHERE false;

SELECT
  entity_type, from_status_id, to_status_id
FROM metadata.status_transitions
WHERE false;

SELECT metadata.validate_status_transition('test', 1, 2, 'user');
SELECT * FROM metadata.get_allowed_transitions('test', 1, 'user');
SELECT metadata.get_initial_status('test');
```

### Phase 2: Migrate Examples (v0.10.0)

**Sqitch Migration: `v0-10-0-migrate-example-statuses`**

**Pothole Example:**
```sql
-- Deploy: Migrate IssueStatus table

BEGIN;

-- 1. Migrate data to metadata.statuses
INSERT INTO metadata.statuses (id, entity_type, display_name, color, sort_order, is_initial)
SELECT
  id,
  'issue' as entity_type,
  display_name,
  COALESCE(color, '#3B82F6') as color,
  id as sort_order,
  (id = 1) as is_initial
FROM public."IssueStatus"
ON CONFLICT (id, entity_type) DO NOTHING;

-- 2. Add status columns to Issue table
ALTER TABLE public."Issue"
  ADD COLUMN status_new_id INT,
  ADD COLUMN status_entity_type TEXT GENERATED ALWAYS AS ('issue') STORED;

-- 3. Copy existing status references
UPDATE public."Issue"
SET status_new_id = status;

-- 4. Add composite FK
ALTER TABLE public."Issue"
  ADD CONSTRAINT issue_status_fk
  FOREIGN KEY (status_new_id, status_entity_type)
  REFERENCES metadata.statuses(id, entity_type);

-- 5. Create index
CREATE INDEX idx_issue_status ON public."Issue"(status_new_id, status_entity_type);

-- 6. Drop old FK
ALTER TABLE public."Issue"
  DROP CONSTRAINT IF EXISTS "Issue_status_fkey";

-- 7. Swap columns
ALTER TABLE public."Issue"
  DROP COLUMN status,
  ALTER COLUMN status_new_id SET NOT NULL;

ALTER TABLE public."Issue"
  RENAME COLUMN status_new_id TO status;

-- 8. Drop old status table
DROP TABLE public."IssueStatus";

-- 9. Add default transitions
INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, required_role)
SELECT 'issue', s1.id, s2.id, 'user'
FROM metadata.statuses s1
CROSS JOIN metadata.statuses s2
WHERE s1.entity_type = 'issue'
  AND s2.entity_type = 'issue'
  AND s1.sort_order < s2.sort_order;  -- Allow forward transitions

COMMIT;
```

**Similar for WorkPackageStatus, broader-impacts examples, etc.**

### Phase 3: Frontend Updates (v0.10.0)

**Changes required:**
1. Add `EntityPropertyType.Status` enum value
2. Update `SchemaService.getPropertyType()` detection
3. Update `EditPropertyComponent` with Status handling
4. Update `DisplayPropertyComponent` with badge rendering
5. Create `StatusManagementPage` component
6. Add route `/admin/statuses`
7. Update navigation menu (admin section)

### Phase 4: Documentation (v0.10.0)

**Files to create/update:**
- [x] `docs/development/STATUS_TYPE_SYSTEM.md` (this file)
- [ ] Update `CLAUDE.md` with Status type pattern
- [ ] Add examples to example deployments
- [ ] Update API documentation

---

## Future: Workflow Engine

### Phase 5: Workflow Validation (v0.11.0)

**Automatic transition validation via triggers:**

```sql
-- Trigger to enforce status transitions
CREATE OR REPLACE FUNCTION enforce_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_entity_type TEXT;
  v_user_role TEXT;
  v_is_valid BOOLEAN;
BEGIN
  -- Extract entity_type from generated column
  v_entity_type := NEW.status_entity_type;

  -- Get user role from JWT
  v_user_role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb->>'role',
    'user'
  );

  -- Check if transition is valid (if status changed)
  IF OLD.status_id IS DISTINCT FROM NEW.status_id THEN
    v_is_valid := metadata.validate_status_transition(
      v_entity_type,
      OLD.status_id,
      NEW.status_id,
      v_user_role
    );

    IF NOT v_is_valid THEN
      RAISE EXCEPTION 'Invalid status transition from % to % for role %',
        OLD.status_id, NEW.status_id, v_user_role;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to issues table
CREATE TRIGGER enforce_issue_status_transition
  BEFORE UPDATE OF status ON public."Issue"
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_status_transition();
```

### Phase 6: Workflow UI (v0.11.0)

**Features:**
- Visual workflow designer (JointJS-based)
- Drag-to-connect status nodes
- Edit transition properties
- Test workflow completeness
- Export/import workflow definitions

**Component:** `WorkflowManagementPage` at `/admin/workflows`

### Phase 7: Advanced Features (v0.12.0+)

**Time-based transitions:**
```sql
ALTER TABLE metadata.status_transitions
  ADD COLUMN auto_transition_after INTERVAL,
  ADD COLUMN auto_transition_to_status_id INT;

-- Background job checks for expired statuses and auto-transitions
```

**Approval workflows:**
```sql
ALTER TABLE metadata.status_transitions
  ADD COLUMN requires_approval BOOLEAN DEFAULT FALSE,
  ADD COLUMN approval_role TEXT;

-- Create approvals tracking table
CREATE TABLE metadata.status_transition_approvals (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  transition_id INT REFERENCES metadata.status_transitions(id),
  requested_by UUID REFERENCES metadata.civic_os_users(id),
  approved_by UUID REFERENCES metadata.civic_os_users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
```

**Notification triggers:**
```sql
ALTER TABLE metadata.status_transitions
  ADD COLUMN notify_users UUID[],
  ADD COLUMN notification_template TEXT;

-- Trigger sends notifications on transition
```

**SLA tracking:**
```sql
CREATE TABLE metadata.status_sla_rules (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  status_id INT NOT NULL,
  max_duration INTERVAL NOT NULL,
  warning_threshold INTERVAL,
  escalation_action TEXT,
  FOREIGN KEY (status_id, entity_type)
    REFERENCES metadata.statuses(id, entity_type)
);

-- Background job checks for SLA violations
```

---

## Appendix

### Example: Issue Tracking System

**Complete implementation of issue tracking with statuses:**

```sql
-- 1. Create entity table with status
CREATE TABLE public.issues (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),

  -- Status reference
  status_id INT NOT NULL,
  status_entity_type TEXT GENERATED ALWAYS AS ('issue') STORED,

  -- Foreign keys
  assigned_to UUID REFERENCES metadata.civic_os_users(id),
  created_by UUID NOT NULL REFERENCES metadata.civic_os_users(id),

  -- Composite FK to statuses
  FOREIGN KEY (status_id, status_entity_type)
    REFERENCES metadata.statuses(id, entity_type),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for status FK
CREATE INDEX idx_issues_status ON issues(status_id, status_entity_type);

-- 2. Configure statuses via Admin UI or SQL
INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal) VALUES
  ('issue', 'New', '#3B82F6', 1, true, false),
  ('issue', 'Triaged', '#8B5CF6', 2, false, false),
  ('issue', 'In Progress', '#F59E0B', 3, false, false),
  ('issue', 'Blocked', '#EF4444', 4, false, false),
  ('issue', 'Resolved', '#10B981', 5, false, false),
  ('issue', 'Closed', '#6B7280', 6, false, true),
  ('issue', 'Wont Fix', '#64748B', 7, false, true);

-- 3. Define workflow transitions
INSERT INTO metadata.status_transitions
  (entity_type, from_status_id, to_status_id, required_role, requires_comment, description)
VALUES
  ('issue', 1, 2, 'user', false, 'Triage new issue'),
  ('issue', 2, 3, 'user', false, 'Begin work'),
  ('issue', 3, 4, 'user', true, 'Mark as blocked (requires comment)'),
  ('issue', 4, 3, 'user', true, 'Unblock and resume work'),
  ('issue', 3, 5, 'user', false, 'Mark as resolved'),
  ('issue', 5, 6, 'user', false, 'Close resolved issue'),
  ('issue', 5, 3, 'user', true, 'Reopen if not actually fixed'),
  ('issue', 1, 7, 'editor', true, 'Close without fixing (requires editor role + comment)'),
  ('issue', 2, 7, 'editor', true, 'Close without fixing (requires editor role + comment)');

-- 4. Grant permissions
GRANT SELECT, INSERT, UPDATE ON public.issues TO authenticated;
GRANT DELETE ON public.issues TO authenticated;  -- Or restrict to admin

-- 5. Test queries
-- Get initial status for new issues
SELECT metadata.get_initial_status('issue');  -- Returns status_id for "New"

-- Create new issue with default status
INSERT INTO issues (title, description, priority, status_id, created_by)
VALUES (
  'Login button not working',
  'Users report clicking login button does nothing',
  'high',
  (SELECT metadata.get_initial_status('issue')),
  'user-uuid-here'
);

-- Get allowed next statuses for an issue currently in "New" (status_id = 1)
SELECT * FROM metadata.get_allowed_transitions('issue', 1, 'user');
-- Returns: [(2, 'Triaged', '#8B5CF6', false, null)]

-- Check if user can transition from New to Closed
SELECT metadata.validate_status_transition('issue', 1, 6, 'user');
-- Returns: false (no direct transition defined)

SELECT metadata.validate_status_transition('issue', 1, 6, 'editor');
-- Returns: false (even editors can't skip to Closed, they can only go to "Wont Fix")
```

### Comparison: Before vs After

**Before (Traditional Approach):**

```sql
-- Integrator creates 3 tables
CREATE TABLE public.issue_statuses (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(50) NOT NULL,
  color VARCHAR(7)
);

CREATE TABLE public.issue_status_transitions (
  from_status_id INT REFERENCES issue_statuses(id),
  to_status_id INT REFERENCES issue_statuses(id),
  PRIMARY KEY (from_status_id, to_status_id)
);

CREATE TABLE public.issues (
  id BIGSERIAL PRIMARY KEY,
  status_id INT NOT NULL REFERENCES issue_statuses(id)
);

-- Manual data entry for each entity type
INSERT INTO issue_statuses (display_name, color) VALUES
  ('New', '#3B82F6'),
  ('In Progress', '#F59E0B'),
  ...
```

**Issues:**
- 3 tables per entity with statuses (clutters schema)
- No standardization (each integrator reinvents the wheel)
- No UI for management
- No framework support for workflows
- Schema Editor ERD is cluttered

**After (Framework Approach):**

```sql
-- Integrator creates 1 table
CREATE TABLE public.issues (
  id BIGSERIAL PRIMARY KEY,
  status_id INT NOT NULL,
  status_entity_type TEXT GENERATED ALWAYS AS ('issue') STORED,
  FOREIGN KEY (status_id, status_entity_type)
    REFERENCES metadata.statuses(id, entity_type)
);

-- Configure via Admin UI at /admin/statuses
-- No manual table creation needed!
```

**Benefits:**
- 1 table per entity (clean schema)
- Standardized pattern across all applications
- UI for status management
- Framework support for workflows ready
- Schema Editor ERD shows clean domain model

---

## Questions & Decisions

### Open Questions

1. **Status History Tracking:**
   - Should framework provide automatic status change audit log?
   - Create `metadata.status_history` table automatically?
   - Or leave to integrators via triggers?

2. **Status Colors:**
   - Provide color palette/theme recommendations?
   - Default colors for common statuses (new=blue, active=orange, complete=green)?
   - Allow status colors to override DaisyUI theme colors?

3. **Migration from Existing Systems:**
   - Provide automated migration tool for existing status tables?
   - Script to detect status tables and convert automatically?
   - Manual migration guide only?

4. **Generated Column Alternative:**
   - Support DEFAULT instead of GENERATED for more flexibility?
   - Trade-off: Users could accidentally change entity_type
   - Generated is safer but less flexible

5. **Schema Editor Integration:**
   - Show Status as special node type in ERD?
   - Group all Status references visually?
   - Provide workflow diagram view?

### Decisions Made

| Decision | Rationale |
|----------|-----------|
| Use composite FK with generated column | Type safety + auto-population + no manual entry |
| Single `metadata.statuses` table | Consolidation without losing type safety via entity_type discriminator |
| Admin-only status modification | Statuses are schema-level definitions, should be controlled |
| Framework provides base tables | Clear boundary: framework creates tables, integrators add values |
| Status as first-class type | Matches File/User pattern, enables automatic UI generation |
| Support workflow transitions from v0.10.0 | Foundation for state machine, even if not enforced initially |

---

## References

- PostgreSQL Composite Foreign Keys: https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK
- PostgreSQL Generated Columns: https://www.postgresql.org/docs/current/ddl-generated-columns.html
- JointJS Documentation: https://resources.jointjs.com/
- PostgREST Filtering: https://postgrest.org/en/stable/references/api/tables_views.html#horizontal-filtering-rows
- DaisyUI Badge Component: https://daisyui.com/components/badge/

---

**END OF DESIGN DOCUMENT**
