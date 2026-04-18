# Options Source RPC Design

**Status**: Design — pre-implementation
**Version target**: TBD

## Overview

A general-purpose mechanism for overriding how FK dropdowns and M:M editors load their
option lists. Today, FK dropdowns always query `SELECT id, display_name FROM {join_table}`
and M:M editors always query `SELECT id, display_name FROM {relatedTable}`. There's no way
to filter, sort, or contextualize those options based on the current record's state.

`options_source_rpc` is a new column on `metadata.properties` that names a PostgreSQL
function the framework calls instead of the default table query. The RPC receives the
current entity's ID and returns `{id, display_name}` pairs — the same shape the frontend
already consumes.

---

## Motivation

**Real-world examples** (not workflow-specific):
- Show only approved borrowers in a FK dropdown
- Show only in-service tools of a specific type
- Show only parcels with "good" eligibility status
- Show only users with a certain role
- Show tools available during a specific time window (context-dependent)

**Workflow-specific example** (depends on this feature):
- Tool Shed step 3: M:M tool selection filtered by TimeSlot from a previous step

**Why an RPC and not a VIEW**: VIEWs can handle static filtering (e.g., `WHERE status =
'approved'`). But context-dependent filtering — "show tools available for THIS reservation's
time window" — requires the current record's ID to look up context. An RPC receives that ID.

---

## Design

### Configuration

Two new columns on `metadata.properties`:

```sql
ALTER TABLE metadata.properties ADD COLUMN options_source_rpc NAME;
ALTER TABLE metadata.properties ADD COLUMN depends_on_columns NAME[];
```

`options_source_rpc` names the RPC to call instead of querying the related table.
`depends_on_columns` lists which form fields drive a re-fetch and are passed in `p_depends_on`.

These can be used independently or together:

```sql
-- Cascading FK: tool types filtered by category (uses depends_on, ignores p_id)
INSERT INTO metadata.properties (table_name, column_name, options_source_rpc, depends_on_columns)
VALUES ('tool_reservations', 'tool_type_id', 'get_tool_types', '{category_id}');

-- Context-only: only approved borrowers (uses p_id, no dependencies)
INSERT INTO metadata.properties (table_name, column_name, options_source_rpc)
VALUES ('tool_reservations', 'borrower_id', 'get_eligible_borrowers');

-- Both: available tools of a specific type for this reservation's time window
INSERT INTO metadata.properties (table_name, column_name, options_source_rpc, depends_on_columns)
VALUES ('reservation_equipment', 'reservation_tool_selections_m2m',
        'get_available_tools_by_type', '{tool_category_id}');
```

If `options_source_rpc IS NULL` (the default), the existing behavior is unchanged — the
framework queries the related table directly.

**Framework behavior when `depends_on_columns` is set:**
1. On initial load: call the RPC with current dependency values
2. When any dependency field value changes: re-call the RPC with updated values
3. Clear the current selection if it's no longer in the returned options
4. On Create pages: `p_id = NULL`, `p_depends_on` carries the dependency values

### Exposed to frontend

The `schema_properties` VIEW already includes all `metadata.properties` columns. Adding
`options_source_rpc` to the VIEW exposes it to the frontend automatically. The
`SchemaEntityProperty` TypeScript interface gains:

```typescript
options_source_rpc?: string;  // RPC name to call instead of querying join_table/relatedTable
```

### RPC convention

**Signature**: `(p_id TEXT, p_depends_on JSONB DEFAULT '{}') RETURNS TABLE (id TEXT, display_name TEXT)`

| Aspect | Convention |
|---|---|
| Parameters | `p_id TEXT` — entity's own ID (NULL on Create pages); `p_depends_on JSONB` — current values of dependency fields |
| Required return columns | `id`, `display_name` |
| Optional return columns | `color TEXT` — framework renders colored badges if present |
| Additional return columns | Ignored by the framework; available for future use |
| Volatility | Should be `STABLE` (reads data, no side effects) |
| Security | `SECURITY INVOKER` (default) — RLS applies to the tables the RPC queries |

Each integrator writes their own RPC with their own logic. Different properties can point to
different RPCs. The framework standardizes the calling convention; the integrator owns the
query logic.

**`p_id`** is always the entity's own ID. Same convention as entity actions:

| Context | `p_id` is... | Example |
|---|---|---|
| Regular Edit page | The entity being edited | `p_id = '42'` |
| Regular Detail page (M:M) | The entity being viewed | `p_id = '42'` |
| Regular Create page | `NULL` (entity doesn't exist yet) | `p_id = NULL` |
| Workflow step zero | The parent record (same entity) | `p_id = '42'` |
| Workflow data step | The step record's own ID | `p_id = '17'` |

**`p_depends_on`** contains the current values of fields listed in `depends_on_columns`:

```json
{"category_id": 5}
```

On Create pages, `p_id` is NULL but `p_depends_on` carries the dependency values — this is
what enables cascading dropdowns before the entity exists. When `depends_on_columns` is not
configured, `p_depends_on` is `'{}'` (empty object).

In workflow data steps, the parent is one lookup away from `p_id`:

```sql
-- p_id = step record ID (e.g., reservation_equipment.id = 17)
-- Parent is one join: SELECT reservation_id FROM reservation_equipment WHERE id = 17
```

### Example RPCs

All RPCs share the same signature: `(p_id TEXT, p_depends_on JSONB DEFAULT '{}')`.
Each uses whichever parameters are relevant to its logic.

**Simple cascading** (uses `p_depends_on` only — works on Create pages):

```sql
CREATE FUNCTION get_tool_types(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT tt.id, tt.display_name
    FROM tool_types tt
    WHERE tt.category_id = (p_depends_on->>'category_id')::INT
    ORDER BY tt.display_name;
$$;
```

**Static filter** (uses neither — just a filtered query):

```sql
CREATE FUNCTION get_eligible_borrowers(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT b.id, b.display_name
    FROM borrowers b
    JOIN metadata.statuses s ON b.status_id = s.id
    WHERE s.status_key = 'approved'
    ORDER BY b.display_name;
$$;
```

**Entity-context filter** (uses `p_id` — navigates from step record to parent to sibling):

```sql
CREATE FUNCTION get_available_tools(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_reservation_id INT;
    v_time_slot      TSTZRANGE;
BEGIN
    -- p_id is the reservation_equipment step record ID
    -- Navigate to parent: one lookup via FK
    SELECT reservation_id INTO v_reservation_id
    FROM reservation_equipment WHERE id = p_id::INT;

    -- Navigate to sibling step: look up the time slot
    SELECT rs.time_slot INTO v_time_slot
    FROM reservation_schedule rs
    WHERE rs.reservation_id = v_reservation_id;

    -- If no schedule step completed yet, show all in-service tools
    IF v_time_slot IS NULL THEN
        RETURN QUERY
        SELECT ti.id, tt.display_name || ' #' || ti.instance_number AS display_name
        FROM tool_instances ti
        JOIN tool_types tt ON ti.tool_type_id = tt.id
        WHERE ti.status_key = 'in_service'
        ORDER BY tt.display_name, ti.instance_number;
        RETURN;
    END IF;

    -- Show only tools not booked during the requested window
    RETURN QUERY
    SELECT ti.id, tt.display_name || ' #' || ti.instance_number AS display_name
    FROM tool_instances ti
    JOIN tool_types tt ON ti.tool_type_id = tt.id
    WHERE ti.status_key = 'in_service'
      AND NOT EXISTS (
          SELECT 1
          FROM reservation_tool_selections rts
          JOIN reservation_equipment re ON rts.reservation_equipment_id = re.id
          JOIN reservation_schedule rs ON rs.reservation_id = re.reservation_id
          JOIN tool_reservations tr ON tr.id = re.reservation_id
          WHERE rts.tool_instance_id = ti.id
            AND rs.time_slot && v_time_slot
            AND tr.workflow_status = 'complete'
            AND tr.id != v_reservation_id
      )
    ORDER BY tt.display_name, ti.instance_number;
END;
$$;
```

**Both context + cascading** (uses `p_id` for time window AND `p_depends_on` for category):

```sql
CREATE FUNCTION get_available_tools_by_type(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_reservation_id INT;
    v_time_slot      TSTZRANGE;
    v_category_id    INT;
BEGIN
    v_category_id := (p_depends_on->>'tool_category_id')::INT;

    SELECT reservation_id INTO v_reservation_id
    FROM reservation_equipment WHERE id = p_id::INT;

    SELECT rs.time_slot INTO v_time_slot
    FROM reservation_schedule rs
    WHERE rs.reservation_id = v_reservation_id;

    RETURN QUERY
    SELECT ti.id, tt.display_name || ' #' || ti.instance_number
    FROM tool_instances ti
    JOIN tool_types tt ON ti.tool_type_id = tt.id
    WHERE ti.status_key = 'in_service'
      AND (v_category_id IS NULL OR tt.category_id = v_category_id)
      AND (v_time_slot IS NULL OR NOT EXISTS (/* availability check */))
    ORDER BY tt.display_name, ti.instance_number;
END;
$$;
```

**With color** (optional third column for badge rendering):

```sql
CREATE FUNCTION get_eligible_parcels(p_id TEXT, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT, color TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT p.id, p.display_name,
           CASE p.eligibility
               WHEN 'good' THEN '#22c55e'
               WHEN 'few_issues' THEN '#f59e0b'
               ELSE '#ef4444'
           END AS color
    FROM parcels p
    WHERE p.eligibility IN ('good', 'few_issues')
    ORDER BY p.display_name;
$$;
```

---

## Frontend Changes

### `EditPropertyComponent` (FK dropdowns)

Current code (`edit-property.component.ts:96-110`):

```typescript
if (this.propType() == EntityPropertyType.ForeignKeyName) {
    this.selectOptions$ = this.data.getData({
        key: prop.join_table,
        fields: ['id:' + prop.join_column, 'display_name'],
        orderField: 'id',
    }).pipe(map(data => data.map(d => ({ id: d.id, text: d.display_name }))));
}
```

With `options_source_rpc`:

```typescript
if (this.propType() == EntityPropertyType.ForeignKeyName) {
    if (prop.options_source_rpc) {
        this.loadOptionsFromRpc(prop);
    } else {
        // Default: query join_table directly (existing behavior)
        this.selectOptions$ = this.data.getData({ /* existing code */ });
    }
}

private loadOptionsFromRpc(prop: SchemaEntityProperty) {
    const dependsOn = this.buildDependsOn(prop);
    this.selectOptions$ = this.data.callRpc(prop.options_source_rpc!, {
        p_id: this.entityId() ? String(this.entityId()) : null,
        p_depends_on: dependsOn
    }).pipe(map(data => data.map(d => ({ id: d.id, text: d.display_name }))));
}

private buildDependsOn(prop: SchemaEntityProperty): Record<string, any> {
    if (!prop.depends_on_columns?.length) return {};
    const result: Record<string, any> = {};
    for (const col of prop.depends_on_columns) {
        result[col] = this.form().get(col)?.value ?? null;
    }
    return result;
}
```

**New inputs needed**:
- `entityId` — the ID of the record being edited (NULL on Create pages)
- The component also needs access to the `FormGroup` to read dependency field values
  (it already has `form` as a required input)

**Re-fetch on dependency change**: When `depends_on_columns` is configured, the component
subscribes to `valueChanges` on those specific form controls. When any dependency changes,
`loadOptionsFromRpc` is called again with updated values. The current selection is cleared
if it's no longer in the new options list.

```typescript
// In ngOnInit, after form is available:
if (prop.options_source_rpc && prop.depends_on_columns?.length) {
    const deps = prop.depends_on_columns.map(col => this.form().get(col)!);
    merge(...deps.map(c => c.valueChanges)).pipe(
        debounceTime(300),
        takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.loadOptionsFromRpc(prop));
}
```

### `ManyToManyEditorComponent` (M:M editors)

The component already has `entityId` as a required input. The change is in
`loadAvailableOptions()`:

```typescript
private loadAvailableOptions() {
    const meta = this.property().many_to_many_meta;
    const rpc = this.property().options_source_rpc;

    if (rpc) {
        this.data.callRpc(rpc, { p_id: String(this.entityId()) }).subscribe({
            next: (options) => this.availableOptions.set(options),
            error: () => this.availableOptions.set([])
        });
    } else {
        // Existing behavior: query relatedTable directly
        const fields = meta.relatedTableHasColor
            ? ['id', 'display_name', 'color']
            : ['id', 'display_name'];
        this.data.getData({
            key: meta.relatedTable, fields, orderField: 'display_name'
        }).subscribe({
            next: (options) => this.availableOptions.set(options),
            error: () => this.availableOptions.set([])
        });
    }
}
```

No new inputs needed — `entityId` is already available.

**M:M mutations as dependency events**: M:M properties can appear in `depends_on_columns`
— including their own. When an M:M add/remove completes, the editor emits a dependency
change event for its synthetic column name. Any property (including itself) that lists
that column in `depends_on_columns` re-fetches its options.

```sql
-- M:M editor re-fetches its own options after each add/remove (for limits/availability)
INSERT INTO metadata.properties
    (table_name, column_name, options_source_rpc, depends_on_columns)
VALUES ('reservation_equipment', 'reservation_tool_selections_m2m',
        'get_available_tools', '{reservation_tool_selections_m2m}');

-- Another property that depends on the M:M selection
INSERT INTO metadata.properties
    (table_name, column_name, options_source_rpc, depends_on_columns)
VALUES ('reservation_equipment', 'estimated_weight',
        'calculate_tool_weight', '{reservation_tool_selections_m2m}');
```

The framework watches two types of dependency sources through the same mechanism:
- **Regular form fields** (e.g., `category_id`) → watched via `FormControl.valueChanges`
- **M:M synthetic columns** (e.g., `reservation_tool_selections_m2m`) → watched via the
  M:M editor's mutation event (`dependencyChanged` output)

Both emit through the same notification channel so `depends_on_columns` watchers don't
need to distinguish between the two.

```typescript
// In ManyToManyEditorComponent, after each successful add/remove:
this.relationChanged.emit();
this.dependencyChanged.emit(this.property().column_name);

// WorkflowStepFormComponent (or EditPage) listens:
// - FormControl valueChanges for regular fields
// - dependencyChanged for M:M mutations
// Both feed into the same re-fetch logic
```

Without `options_source_rpc` configured, M:M options are loaded once and not refreshed
(existing behavior unchanged). The dependency mechanism only activates when an RPC is
configured.

### Context threading (all pages)

The framework always passes the entity's own ID. No workflow-specific logic needed:

```typescript
// EditPage / WorkflowStepFormComponent — both pass the entity's own ID
<app-edit-property [prop]="prop" [form]="stepForm"
    [entityId]="existingRecordId()" />

// DetailPage / WorkflowStepFormComponent (view mode) — entityId already wired
<app-many-to-many-editor [entityId]="existingRecordId()" [property]="prop"
    [currentValues]="m2mValues()" />
```

On `EditPage`: pass `this.entityId` (from route params) as the new `entityId` input
to `EditPropertyComponent`. This is a small addition — EditPage already has the ID.

On `DetailPage`: `ManyToManyEditorComponent` already receives `entityId`. No change.

On `WorkflowStepFormComponent`: pass `existingRecordId()` (the eagerly-created step
record ID) to both child components. Same ID in all contexts.

---

## Supported Property Types

| Type | How options are loaded today | With `options_source_rpc` |
|---|---|---|
| **ForeignKeyName** | `getData(join_table)` in EditPropertyComponent | RPC replaces `getData` call |
| **ManyToMany** | `getData(relatedTable)` in ManyToManyEditorComponent | RPC replaces `getData` call |
| **User** | `getData('civic_os_users')` with special field handling | Deferred — User has custom display logic |
| **Status** | `getStatusesForEntity()` with caching + transitions | Deferred — has its own filtering mechanism |
| **Category** | `getCategoriesForEntity()` with caching | Deferred — has its own filtering mechanism |

v1 scope: **ForeignKeyName and ManyToMany only.**

---

## Works In / Doesn't Work In

| Context | `p_id` | `p_depends_on` | Works? |
|---|---|---|---|
| Regular Edit page | Entity ID | Dependency field values | Yes |
| Regular Detail page (M:M) | Entity ID | N/A (no form) | Yes |
| Regular Create page | `NULL` | Dependency field values | **Yes** (cascading via `p_depends_on`) |
| Workflow step zero | Parent ID | Dependency field values | Yes |
| Workflow data steps | Step record ID | Dependency field values | Yes |

Create pages now work for cascading dropdowns: `p_id` is NULL but `p_depends_on` carries
the dependency field values. The RPC uses whichever parameter is relevant.

RPCs that require `p_id` (entity-context filtering) gracefully degrade on Create pages —
they can return all options when `p_id IS NULL`, or return an empty set with a message.

---

## Schema Changes

### Migration

```sql
ALTER TABLE metadata.properties ADD COLUMN options_source_rpc NAME;
ALTER TABLE metadata.properties ADD COLUMN depends_on_columns NAME[];

COMMENT ON COLUMN metadata.properties.options_source_rpc IS
    'Optional RPC to call instead of querying the related table for FK/M:M options.
     RPC signature: (p_id TEXT, p_depends_on JSONB DEFAULT ''{}'') RETURNS TABLE (id, display_name).
     p_id = entity ID (NULL on Create pages). p_depends_on = current values of depends_on_columns.
     Return color TEXT as an optional third column for badge rendering.';

COMMENT ON COLUMN metadata.properties.depends_on_columns IS
    'Array of column names whose values are watched for changes and passed to options_source_rpc
     as the p_depends_on JSONB parameter. When any dependency value changes, the RPC is re-called.
     Enables cascading dropdowns (e.g., category → sub-category).';
```

### Update `schema_properties` VIEW

The VIEW already selects from `metadata.properties`. If it uses `SELECT *`, the column
appears automatically. If it uses an explicit column list, add `options_source_rpc` to it.

---

## Interaction with Multi-Step Workflow System

The workflow system depends on this feature for availability-checked M:M selections (e.g.,
Tool Shed step 3: equipment filtered by TimeSlot from step 2).

**Without `options_source_rpc`**: M:M editors show ALL options from the related table. A
GIST exclusion constraint on the junction table prevents double-booking at save time, but
the UX is poor — the user selects a tool, completes the step, and gets a constraint error.

**With `options_source_rpc`**: M:M editors call the integrator's RPC which joins to sibling
step data (via the parent ID) and returns only available options. The user sees only what
they can actually select.

**Implementation order**: `options_source_rpc` can be built independently of the workflow
system. It works on regular Edit/Detail pages immediately. The workflow system consumes it
by passing `parentId` as context.

---

## Implementation Checklist

### Database
- [ ] Add `options_source_rpc NAME` and `depends_on_columns NAME[]` to `metadata.properties`
- [ ] Update `schema_properties` VIEW if it uses explicit column list
- [ ] Add to `upsert_property_metadata` RPC if one exists
- [ ] Migration file (can be standalone or bundled with workflow migration)

### Frontend
- [ ] Add `options_source_rpc` and `depends_on_columns` to `SchemaEntityProperty` in `entity.ts`
- [ ] `EditPropertyComponent`: add `entityId` input; branch FK option loading on RPC presence;
      subscribe to dependency field changes for re-fetch
- [ ] `ManyToManyEditorComponent`: branch option loading on RPC presence (entityId already exists)
- [ ] `EditPage`: pass `this.entityId` to `EditPropertyComponent` instances
- [ ] `CreatePage`: pass `null` as `entityId` to `EditPropertyComponent` instances
- [ ] `WorkflowStepFormComponent`: pass `existingRecordId()` to both child components

### Testing
- [ ] Unit test: EditPropertyComponent with RPC + no dependencies → calls RPC with entityId, empty depends_on
- [ ] Unit test: EditPropertyComponent with RPC + depends_on → calls RPC, re-calls on dependency change
- [ ] Unit test: EditPropertyComponent on Create page → calls RPC with p_id=null, depends_on has values
- [ ] Unit test: EditPropertyComponent without RPC → calls `getData` (unchanged)
- [ ] Unit test: ManyToManyEditorComponent with RPC → calls RPC with entityId
- [ ] Unit test: ManyToManyEditorComponent without RPC → calls `getData` (unchanged)
- [ ] Integration: cascading dropdown on Create page (category → sub-category)

---

## Resolved Edge Cases

### NULL handling in `p_depends_on`

When a dependency field hasn't been filled (user opened the form, hasn't selected category
yet), `p_depends_on` contains `{"category_id": null}`. Convention for RPCs:

**NULL dependency value = return all options (unfiltered)**

```sql
-- Convention: handle NULL gracefully with IS NULL OR match
WHERE (v_category_id IS NULL OR tt.category_id = v_category_id)
```

This gives the user a full option list initially, then narrows as they make selections.
RPCs that require a dependency value to function can return empty with a message:

```sql
IF v_category_id IS NULL THEN
    -- Return nothing — user must select a category first
    RETURN;
END IF;
```

### Circular `depends_on_columns` prevention

If field A depends on field B and field B depends on field A, the framework would enter an
infinite re-fetch loop. Prevention:

**Runtime guard**: The `loadOptionsFromRpc()` method sets a `refetching` flag per property.
If a valueChanges event fires while the flag is set, the re-fetch is skipped:

```typescript
private refetching = new Set<string>();

private loadOptionsFromRpc(prop: SchemaEntityProperty) {
    if (this.refetching.has(prop.column_name)) return;
    this.refetching.add(prop.column_name);

    this.data.callRpc(/* ... */).subscribe({
        next: (options) => {
            this.availableOptions.set(options);
            this.refetching.delete(prop.column_name);
        },
        error: () => this.refetching.delete(prop.column_name)
    });
}
```

This is sufficient for v1. A metadata-level cycle detection (at `INSERT` time via a trigger
or a validation RPC) could be added later if circular dependencies become a real problem.

### Stale selection after dependency change

When a dependency field changes and options are re-fetched, the currently selected value may
no longer be in the new option set (e.g., user selected "Chainsaw" under "Outdoor Tools",
then changed category to "Mobile Event Kit").

**Decision**: Clear the selection automatically and mark the field as touched (triggers
validation display if the field is required).

```typescript
// After re-fetching options:
const currentValue = this.form().get(prop.column_name)?.value;
const validIds = new Set(newOptions.map(o => o.id));
if (currentValue && !validIds.has(currentValue)) {
    this.form().get(prop.column_name)?.setValue(null);
    this.form().get(prop.column_name)?.markAsTouched();
}
```

---

## Open Questions

- **Selection invalidation on cascade**: When a dependency field changes and options are
  re-fetched, should the current value be cleared automatically if it's no longer in the
  new option set? Or should it stay (with a visual warning)? Recommendation: clear it —
  stale selections cause save errors downstream.

- **Cascade debouncing**: The `debounceTime(300)` on dependency changes prevents rapid-fire
  RPC calls while the user is still selecting. Is 300ms the right threshold? Could be
  configurable per property, but that feels like over-engineering for v1.

- **Loading indicator for FK dropdowns**: When the RPC is slow, the dropdown should show a
  loading state. The M:M editor already has `loading = signal(false)`. The FK dropdown in
  `EditPropertyComponent` currently has no loading state — it uses `selectOptions$ | async`
  which shows nothing until the observable emits. May need a `loadingOptions` signal.

- **Error handling**: What if the RPC fails or doesn't exist? Recommendation: show an error
  and don't fall back to the default table query — a misconfigured RPC should be visible.

- **Workflow step re-entry**: When a user navigates back to the equipment step from the
  review step, should the M:M editor re-fetch available tools? The time slot hasn't changed
  (it's locked), but another user might have reserved a tool in the meantime. Recommendation:
  re-fetch on step entry (call `loadAvailableOptions()` when the step component re-renders
  with a new step input, not just on first init).
