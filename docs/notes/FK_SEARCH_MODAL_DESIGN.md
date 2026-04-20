# FK Search Modal Design (v0.45.0)

## Problem

Native `<select>` dropdowns become unusable at scale. When a FK field references a table with 50+ records, scrolling through a flat list is slow, error-prone, and lacks discovery. Users need search, sort, filter, and pagination to find the right record.

## Solution

A metadata-driven search modal — a mini List page inside a `CosModal` — as an alternative rendering mode for FK fields. Integrators set `fk_search_modal = true` on `metadata.properties` to opt in per-column.

## Architecture

### Database Schema

Single boolean column on `metadata.properties`:

```sql
ALTER TABLE metadata.properties ADD COLUMN fk_search_modal BOOLEAN DEFAULT FALSE;

-- Prevent misconfiguration
ALTER TABLE metadata.properties ADD CONSTRAINT fk_search_modal_requires_fk
  CHECK (fk_search_modal = false OR join_table IS NOT NULL OR column_name LIKE '%\_m2m');
```

The `schema_properties` VIEW exposes it as `COALESCE(properties.fk_search_modal, false)`.

### Component: FkSearchModalComponent

**Location**: `src/app/components/fk-search-modal/`

**Inputs**:
| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `isOpen` | `boolean` (required) | — | Controls modal visibility |
| `joinTable` | `string` (required) | — | Target entity table name |
| `joinColumn` | `string` | `'id'` | Primary key column of target entity |
| `currentValue` | `number \| string \| null` | `null` | Current FK value for pre-selection |
| `isNullable` | `boolean` | `false` | Whether the FK allows null |
| `title` | `string` | `'Select'` | Modal title |
| `rpcOptions` | `{id, text}[] \| null` | `null` | Pre-filtered options from RPC (null = table mode) |

**Outputs**:
| Output | Type | Description |
|--------|------|-------------|
| `confirmed` | `{id, displayName} \| null` | Selection confirmed (null = cleared) |
| `closed` | `void` | Modal cancelled |

### Two Data Modes

**Table mode** (when `rpcOptions` is null):
- Fetches property metadata via `SchemaService.getEntity()` + `getPropsForList()`
- Loads data via `DataService.getDataPaginated()` with full PostgREST capabilities
- Server-side search (requires `search_fields` on entity), sort, filter, pagination
- `FilterBarComponent` shown for filterable properties
- Falls back to `['id', 'display_name']` columns when entity isn't registered

**RPC mode** (when `rpcOptions` is provided):
- Works with flat `{id, text}[]` array from `options_source_rpc`
- Client-side search (case-insensitive text match), sort (alphabetical), pagination
- FilterBar hidden (no property metadata for RPC results)
- Single column: display name only

### Interaction Model: Select + Confirm

Not single-click-to-select. Instead:
1. Click a row to **highlight** it (radio-button style)
2. Click **Confirm** to apply and close
3. Click **Cancel** or backdrop to close without changes
4. On open, the current value's row is pre-highlighted
5. For nullable FKs, a **Clear** button removes the selection

Footer layout (right to left): **Confirm** | **Clear** (nullable only, warning style) | **Cancel**

### EditPropertyComponent Integration

Three rendering paths for FK fields, in priority order:
1. `fk_search_modal = true` → Button with display name + search icon → opens `FkSearchModalComponent`
2. `options_source_rpc` set → `<select>` with RPC-driven options
3. Default → `<select>` with all options from join table

**Display name resolution**: On Edit pages, FK fields only load the raw ID. `resolveDisplayName()` does a one-time lookup to the `join_table` to fetch the human-readable name for the button label.

**Query param pre-fill**: A `valueChanges` subscription on the form control catches programmatic value changes (e.g., from Create page query parameters) and resolves the display name automatically.

**When both `fk_search_modal` and `options_source_rpc` are set**: The modal receives `rpcSelectOptions()` as pre-filtered data and does client-side search within it.

## Configuration Examples

```sql
-- Simple: render borrower_id as searchable modal
INSERT INTO metadata.properties (table_name, column_name, join_table, fk_search_modal)
VALUES ('tool_reservations', 'borrower_id', 'borrowers', true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET join_table = EXCLUDED.join_table, fk_search_modal = EXCLUDED.fk_search_modal;

-- Combined with RPC: filtered options + rich UI
INSERT INTO metadata.properties
  (table_name, column_name, join_table, options_source_rpc, fk_search_modal)
VALUES
  ('tool_reservations', 'borrower_id', 'borrowers', 'get_eligible_borrowers', true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET join_table = EXCLUDED.join_table,
      options_source_rpc = EXCLUDED.options_source_rpc,
      fk_search_modal = EXCLUDED.fk_search_modal;
```

## Reused Components

| Component | Role in Modal |
|-----------|--------------|
| `CosModalComponent` | Modal shell with backdrop, focus trap, ESC handling |
| `FilterBarComponent` | Filter controls (table mode only) |
| `PaginationComponent` | Page navigation with size selector |
| `DisplayPropertyComponent` | Cell rendering for each property type |

## M:M Search Modal Design

### Problem

The existing `ManyToManyEditorComponent` uses a flat checkbox list with client-side text
filtering. At 50+ related options, scrolling through the list is slow and the search
only matches `display_name` text. For large M:M option sets, the same search/sort/
filter/pagination capabilities that the FK search modal provides are needed.

### Two Independent Axes

M:M relationships have two independent configuration axes:

| | Default position (Detail bottom card) | Inline (in property grid by `sort_order`) |
|---|---|---|
| **Chip editor** (default) | Status quo — immediate save | Buffered save — pending UI until form Save |
| **Search modal** (`fk_search_modal`) | Split modal — immediate save | Split modal — buffered save |

Configuration via `metadata.properties` on the synthetic `{junction}_m2m` column:

- **`fk_search_modal`** — controls the **picker UI** (split search modal vs flat checkbox list)
- **`show_inline`** (new flag, future migration) — controls **position** (property grid vs bottom card)

These are independent. A search modal is valuable even in the default (bottom card)
position. Inline positioning requires the buffered save model regardless of which picker
is used.

### Split Modal UI

Multi-select modal with a left search/browse panel and right selection panel:

```
┌─────────────────────────────────────────────────────────────┐
│  Select Tags                                                │
├────────────────────────────────┬────────────────────────────┤
│  [🔍 Search...]               │  Selected (3)              │
│  [▼ Filters]                  │                            │
│                                │  [Urgent        ×]  🔴   │
│  ┌──┬───────────────────────┐  │  [Road Surface  ×]  🟢   │
│  │☑ │ Urgent          🔴   │  │  [Lighting      ×]  🟡   │
│  │☐ │ Sidewalk        🔵   │  │                            │
│  │☑ │ Road Surface    🟢   │  │                            │
│  │☑ │ Lighting        🟡   │  │                            │
│  │☐ │ Drainage        🟣   │  │                            │
│  └──┴───────────────────────┘  │                            │
│                                │                            │
│  Showing 1-5 of 12            │                            │
├────────────────────────────────┴────────────────────────────┤
│           [Cancel]  [Apply (1 added, 0 removed)]            │
└─────────────────────────────────────────────────────────────┘
```

### Left Panel: Search & Browse

Reuses the same server-side query pipeline as the FK search modal (table mode):

- **Data source**: `DataService.getDataPaginated()` querying the related entity (e.g., `tags`)
- **Columns**: Full list properties from `SchemaService.getPropsForList()`, rendered with
  `DisplayPropertyComponent` — not just `display_name`
- **Search**: Server-side full-text search (when entity has `search_fields` configured)
- **Sort**: Clickable column headers, server-side ordering
- **Filter**: `FilterBarComponent` for filterable properties
- **Pagination**: `PaginationComponent` with server-side pagination
- **RPC filtering**: When `options_source_rpc` is set, eligible IDs are injected as an
  `id.in.(...)` filter (same mechanism as FK search modal)
- **Checkboxes**: Replace radio buttons from FK modal. Checked state is derived from the
  `workingSelection` signal (a Set of selected IDs)

### Right Panel: Selected Chips

A scrolling list of all currently selected items, displayed as chips:

- Shows `display_name` and optional `color` dot (from related entity data)
- Each chip has an X button to remove from selection (unchecks the row in left panel)
- Ordered alphabetically by display name for consistent scanning
- Shows count in header: "Selected (N)"
- When empty: "No items selected" placeholder

### Checkbox ↔ Chip Synchronization

Both panels read from the same `workingSelection: signal<Set<number | string>>()`:

```
Left panel checkbox click         Right panel chip X click
         │                                    │
         ▼                                    ▼
    toggleSelection(id)                 removeSelection(id)
         │                                    │
         └──────────┬─────────────────────────┘
                    ▼
         workingSelection.update()
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
    Left panel re-renders     Right panel re-renders
    (checkbox checked/        (chip added/removed)
     unchecked)
```

**Cross-page persistence**: The `workingSelection` Set persists across search queries and
pagination. Checking an item on page 1, searching for a different item on page 3, and
checking that too — both remain in the right panel. The left panel checkboxes reflect the
Set state for whatever page is currently visible.

### Chip Data Resolution

The right panel needs `{id, display_name, color?}` for each selected item, but the left
panel only shows one page at a time. Two approaches:

**Approach A — Cache from page visits**: Maintain a `Map<id, {display_name, color}>` that
grows as the user browses pages. Items checked before being seen (e.g., pre-existing
relations) are populated from `currentValues` input.

**Approach B — Separate lookup for unknowns**: When an item is in `workingSelection` but
not in the cache (edge case: programmatic pre-selection), do a single batch query:
`GET /tags?id=in.(4,7,12)&select=id,display_name,color`.

Recommend **Approach A** with Approach B as a fallback. The `currentValues` input from
`ManyToManyEditorComponent` already provides the initial set, and normal usage (browse
pages, check items) naturally populates the cache.

### Apply Button Behavior

The Apply button shows a diff summary derived from comparing `workingSelection` against
the original `currentValues` IDs:

```typescript
pendingDiff = computed(() => {
  const original = new Set(this.currentValueIds());
  const working = this.workingSelection();
  const toAdd = [...working].filter(id => !original.has(id));
  const toRemove = [...original].filter(id => !working.has(id));
  return { toAdd, toRemove };
});
```

Button label: `Apply (2 added, 1 removed)` — disabled when diff is empty.

**Immediate save mode** (default position on Detail page):
- Apply executes `forkJoin` of `addManyToManyRelation` / `removeManyToManyRelation` calls
- Reuses the existing `ManyToManyEditorComponent.executeManyToManyChanges()` logic
- Handles partial failures with error count and retry

**Buffered save mode** (inline on Edit page):
- Apply stores the diff locally and closes the modal
- The pending diff is surfaced to the parent `EditPage` for execution on form Save

### Existing ManyToManyEditorComponent Changes

The current component needs minimal changes to delegate to the search modal:

```typescript
// New computed: should this M:M use the search modal?
useFkSearchModal = computed(() => this.property().fk_search_modal === true);

// In template: when useFkSearchModal(), show a search button instead of the
// checkbox list. Clicking opens the M:M search modal.
// The modal receives:
//   - joinTable: property.many_to_many_meta.relatedTable
//   - currentValues: currentValues() array
//   - rpcOptions: resolved from options_source_rpc (if set)
//   - multiSelect: true
```

The edit mode toggle, permission check, and diff/commit logic remain in
`ManyToManyEditorComponent`. The search modal is just a richer picker that returns
the updated selection set.

### Inline M:M Positioning

**New metadata column**: `show_inline BOOLEAN DEFAULT FALSE` on `metadata.properties`.
Constraint: only allowed on `_m2m` columns.

**Detail page**: When `show_inline = true`, the M:M property is NOT filtered out of
`regularProps$`. It renders in the property grid at its `sort_order` position as
**read-only chips** (same as the current display mode, but positioned inline instead
of in the bottom card). The user must click the page-level "Edit" button to modify.

**Edit page**: Inline M:M renders as a form field at its `sort_order` position:
- Shows current selection as read-only chips with an edit button (search icon or pencil)
- Clicking opens the search modal (or flat checkbox editor if `fk_search_modal` is false)
- Changes are **buffered** — NOT committed until the form Save button is clicked
- Pending state shown with visual indicators:
  - Added chips: dashed green border
  - Removed chips: strikethrough with reduced opacity
- The inline editor emits the pending diff to the parent `EditPage` via an output

**Create page**: Same as Edit page, but the entity doesn't exist yet. The entity is
created first (POST), and the returned ID is used for junction row mutations.

### Buffered Save: Edit Page Integration

`EditPage` needs to coordinate regular form PATCH with inline M:M mutations:

```
User edits form fields + inline M:M selections
         │
         ▼
    [Save button]
         │
    ┌────▼────────┐
    │ PATCH entity │ ← Regular form fields only
    └────┬────────┘
         │ success?
         │ no → show error, keep M:M buffer intact
         │ yes ↓
    ┌────▼───────────────────┐
    │ For each inline M:M:   │
    │   forkJoin(             │
    │     ...adds.map(INSERT),│
    │     ...removes.map(DEL) │
    │   )                     │
    └────┬───────────────────┘
         │
    ┌────▼─────────────────────────────────────────┐
    │ All succeeded → navigate to detail            │
    │ Partial failure → show error, stay on page    │
    │   "Saved. Tags: 2 added, 1 failed to remove" │
    └───────────────────────────────────────────────┘
```

Key design decisions:
- Entity PATCH always fires first. If it fails, no M:M mutations execute.
- Multiple inline M:M fields are processed sequentially (M:M A completes, then M:M B).
- Partial M:M failure does NOT revert the entity PATCH (the entity save is permanent).
- The user sees a clear message about what succeeded and what failed.

### FkSearchModalComponent Changes

The FK search modal gains a `multiSelect` input that switches its behavior:

| Feature | `multiSelect: false` (FK) | `multiSelect: true` (M:M) |
|---|---|---|
| Selection control | Radio buttons | Checkboxes |
| Selection state | `pendingSelection` signal (single) | `workingSelection` signal (Set) |
| Right panel | Hidden | Scrolling chip list |
| Button label | Confirm | Apply (N added, M removed) |
| On Apply | Emits single `{id, displayName}` | Emits `{toAdd: id[], toRemove: id[]}` |
| Clear button | For nullable FKs | Not applicable |
| Pre-selection | Single row highlighted | All current values checked |

The modal size increases from `xl` to `full` when `multiSelect` is true, to accommodate
the split panel layout.

### New Inputs/Outputs for Multi-Select Mode

```typescript
// Additional inputs for M:M mode
multiSelect = input(false);
currentValueIds = input<(number | string)[]>([]);  // Pre-checked IDs
currentValueItems = input<{id: number | string, display_name: string, color?: string}[]>([]);

// Additional output for M:M mode
applied = output<{ toAdd: (number | string)[], toRemove: (number | string)[] }>();
```

### Database Migration

```sql
ALTER TABLE metadata.properties ADD COLUMN show_inline BOOLEAN DEFAULT FALSE;

ALTER TABLE metadata.properties ADD CONSTRAINT show_inline_requires_m2m
  CHECK (show_inline = false OR column_name LIKE '%\_m2m');
```

### Implementation Phases

| Phase | Scope | Depends on |
|---|---|---|
| **M:M-1** | `multiSelect` mode in `FkSearchModalComponent` (split panel, checkbox/chip sync) | v0.45.0 (this PR) |
| **M:M-2** | `ManyToManyEditorComponent` detects `fk_search_modal`, opens search modal | M:M-1 |
| **M:M-3** | `show_inline` migration + Detail page inline rendering (read-only chips in grid) | M:M-2 |
| **M:M-4** | Edit page inline M:M with buffered save + `EditPage` save coordination | M:M-3 |

M:M-1 and M:M-2 can ship together as one release. M:M-3 and M:M-4 can ship together
as a follow-up. The search modal on the default (bottom card) position is immediately
useful without the inline positioning work.

### Configuration Examples

```sql
-- M:M search modal on default position (Detail bottom card)
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal)
VALUES ('issues', 'issue_tags_m2m', true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = EXCLUDED.fk_search_modal;

-- M:M search modal with RPC filtering + inline positioning
INSERT INTO metadata.properties
  (table_name, column_name, fk_search_modal, options_source_rpc, show_inline)
VALUES
  ('projects', 'project_parcels_m2m', true, 'get_eligible_parcels', true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = EXCLUDED.fk_search_modal,
      options_source_rpc = EXCLUDED.options_source_rpc,
      show_inline = EXCLUDED.show_inline;
```

## Migration

- **Deploy**: `postgres/migrations/deploy/v0-45-0-fk-search-modal.sql`
- **Revert**: `postgres/migrations/revert/v0-45-0-fk-search-modal.sql`
- **Verify**: `postgres/migrations/verify/v0-45-0-fk-search-modal.sql`
- **Sqitch**: `v0-45-0-fk-search-modal [v0-44-0-options-source-rpc]`
