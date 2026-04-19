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

## Future: M:M Extension (Phase 5)

The modal is designed to support M:M editors in a future release:
- Add `multiSelect` input for checkbox selection instead of radio
- `ManyToManyEditorComponent` opens modal when related entity has `fk_search_modal = true`
- "Apply" button confirms bulk selection
- The database constraint already allows `column_name LIKE '%_m2m'`

## Migration

- **Deploy**: `postgres/migrations/deploy/v0-45-0-fk-search-modal.sql`
- **Revert**: `postgres/migrations/revert/v0-45-0-fk-search-modal.sql`
- **Verify**: `postgres/migrations/verify/v0-45-0-fk-search-modal.sql`
- **Sqitch**: `v0-45-0-fk-search-modal [v0-44-0-options-source-rpc]`
