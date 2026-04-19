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

## Future: M:M Search Modal (Phase 5)

### Design Matrix

M:M relationships have two independent axes of configuration:

| | Default position (Detail bottom card) | Inline (in property grid by `sort_order`) |
|---|---|---|
| **Chip editor** (default) | Status quo — immediate save on add/remove | Buffered save — pending UI until form Save |
| **Search modal** (`fk_search_modal`) | Split modal on Detail page — immediate save | Split modal on Edit page — buffered save |

Configuration via `metadata.properties`:
- `fk_search_modal = true` — controls **picker UI** (search modal vs chip dropdown)
- `show_inline = true` (new flag) — controls **position** (property grid vs bottom card)
- The combination of inline + Edit page automatically triggers **buffered save** behavior

### Split Modal Design

Multi-select modal with a left search panel and right selection panel:

```
┌─────────────────────────────────────────────────────────────┐
│  Select Tags                                                │
├────────────────────────────────┬────────────────────────────┤
│  [🔍 Search...]               │  Selected (3)              │
│                                │                            │
│  ┌──┬───────────────────────┐  │  [Urgent        ×]        │
│  │☑ │ Urgent          🔴   │  │  [Road Surface  ×]        │
│  │☐ │ Sidewalk        🔵   │  │  [Lighting      ×]        │
│  │☑ │ Road Surface    🟢   │  │                            │
│  │☑ │ Lighting        🟡   │  │                            │
│  │☐ │ Drainage        🟣   │  │                            │
│  └──┴───────────────────────┘  │                            │
│                                │                            │
│  Showing 1-5 of 12            │                            │
├────────────────────────────────┴────────────────────────────┤
│                     [Cancel]  [Apply (1 added, 0 removed)]  │
└─────────────────────────────────────────────────────────────┘
```

**Left panel**: Searchable, sortable, paginated list with checkboxes. Reuses the same
server-side query pipeline as FK search modal (table mode). Pre-checked items = currently
linked records.

**Right panel**: Scrolling chip list of the *pending* selection state. Chips show the
display name and optionally the entity's color. X button on a chip unchecks the
corresponding row in the left panel.

**Key behaviors**:
- **Checkbox ↔ chip sync**: Checking a row adds a chip. Unchecking removes it. X on
  chip unchecks the row. State is bidirectionally synchronized.
- **Cross-page persistence**: Selections persist across search and pagination. User can
  search "Urgent" on page 1, check it, search "Drainage" on page 3, check it — both
  appear in the right panel simultaneously.
- **Apply button**: Shows diff summary ("2 added, 1 removed"). In default position mode,
  executes junction mutations immediately. In inline mode, buffers the diff for form Save.
- **Cancel**: Discards all pending changes, restores original selection state.

### Inline M:M Behavior

**Detail page (read-only)**: Inline M:M renders as display-only chips in the property grid
at its `sort_order` position. No edit affordance — user must click the page-level Edit
button to modify relationships.

**Edit page (buffered save)**:
- Inline M:M shows current chips with an edit trigger (search button or "edit" icon)
- All M:M changes are buffered as a local diff — NOT committed until form Save
- Pending changes show visual state:
  - Added chips: green outline / dashed border
  - Removed chips: strikethrough / dimmed
- Form Save executes: (1) entity PATCH, then (2) M:M junction mutations sequentially
- If entity PATCH fails → M:M mutations don't fire, pending changes preserved in buffer
- If M:M mutations partially fail → show specific errors with retry option
- On Create pages: entity save returns the new ID, which is then used for M:M junction inserts

### Data Flow: Buffered Save

```
User edits form fields + M:M selections
         │
         ▼
    [Save button]
         │
    ┌────▼────┐
    │ PATCH   │ ← Regular form fields
    │ entity  │
    └────┬────┘
         │ success?
    ┌────▼─────────┐
    │ Diff M:M     │ ← Compare pending vs original
    │ selections   │
    └────┬─────────┘
         │
    ┌────▼────┐    ┌────▼────┐
    │ INSERT  │    │ DELETE  │ ← Individual junction row mutations
    │ added   │    │ removed │
    └─────────┘    └─────────┘
         │              │
         ▼              ▼
    Show result: "Saved. 2 tags added, 1 removed."
    (or partial error with retry for failed mutations)
```

The existing `ManyToManyEditorComponent` diff model (comparing current vs original to
determine adds/removes) is preserved. The only change is *when* the diff is applied:
immediately (default position) vs on form Save (inline).

### Implementation Components

| Component | New/Modified | Role |
|-----------|-------------|------|
| `FkSearchModalComponent` | Modified | Add `multiSelect` input, checkbox UI, right panel |
| `ManyToManyEditorComponent` | Modified | Detect `fk_search_modal`, trigger search modal |
| `EditPage` | Modified | Collect buffered M:M diffs, apply after entity PATCH |
| `DetailPage` | Modified | Inline M:M rendering in property grid |
| `metadata.properties` | Migration | Add `show_inline` column |

### Database Migration (future)

```sql
ALTER TABLE metadata.properties ADD COLUMN show_inline BOOLEAN DEFAULT FALSE;

-- Constraint: show_inline only for M:M columns
ALTER TABLE metadata.properties ADD CONSTRAINT show_inline_requires_m2m
  CHECK (show_inline = false OR column_name LIKE '%\_m2m');
```

## Migration

- **Deploy**: `postgres/migrations/deploy/v0-45-0-fk-search-modal.sql`
- **Revert**: `postgres/migrations/revert/v0-45-0-fk-search-modal.sql`
- **Verify**: `postgres/migrations/verify/v0-45-0-fk-search-modal.sql`
- **Sqitch**: `v0-45-0-fk-search-modal [v0-44-0-options-source-rpc]`
