# Rich Junction M:M Design — Additional Editable Columns on Junction Tables

> **Status**: Pre-implementation spec (v0.51.0 target)
> **Author**: Claude Code session, 2026-05-01
> **Motivation**: NEH event kit module (Story 22) requires `quantity` on junction tables

## Problem Statement

The current M:M framework only supports **pure junction tables** — tables with exactly 2 FK columns and a composite PK. The detection heuristic in `schema_m2m_properties`, the `ManyToManyEditorComponent`, and `DataService.addManyToManyRelation()` all reject tables with additional editable columns.

This blocks use cases where the relationship itself carries data:

| Use Case | Junction Table | Extra Columns |
|----------|---------------|---------------|
| Event kit booking | `event_kit_items` | `quantity INTEGER` |
| Course enrollment | `enrollments` | `grade VARCHAR`, `completed_at` |
| Recipe ingredients | `recipe_ingredients` | `amount DECIMAL`, `unit VARCHAR` |
| Order line items | `order_items` | `quantity INTEGER`, `unit_price MONEY` |

## Current Architecture

### Detection Heuristic (`schema_m2m_properties` VIEW)

The VIEW identifies M:M relationships by finding tables where:
1. Exactly **2 foreign key columns** exist
2. The primary key is a **composite** of those 2 FK columns
3. No other "interesting" columns (only `created_at` is tolerated)

Any additional column (like `quantity`) causes the table to fail detection and be treated as a regular entity instead.

**Key file**: `postgres/migrations/deploy/vX-Y-Z-m2m-detection.sql` (the exact migration that creates `schema_m2m_properties`)

### DataService Payloads

`DataService.addManyToManyRelation()` sends a POST with only the two FK values:

```typescript
// Current: only FK columns
{ parent_fk_column: parentId, related_fk_column: relatedId }
```

No mechanism exists to include additional columns in the payload.

### ManyToManyEditorComponent

The editor renders a simple add/remove list:
- **Add**: calls `DataService.addManyToManyRelation()`
- **Remove**: calls `DataService.deleteManyToManyRelation()`
- **No inline editing** of junction row data

The FK Search Modal variant (`FkSearchModalComponent`) similarly only adds/removes — no field editing.

### SaveProgressComponent (Inline M:M)

For `show_inline` M:M on Create/Edit pages, `SaveProgressComponent` buffers add/remove operations and flushes them on save. It tracks `additions` and `removals` as simple ID pairs — no room for additional column values.

## Proposed Changes

### Phase 1: Detection (allow rich junctions to be discovered)

**Modify `schema_m2m_properties`** to relax the heuristic:

1. Require exactly **2 FK columns** (unchanged)
2. Require composite PK of those 2 FKs (unchanged)
3. **Allow** additional non-FK, non-PK columns (currently rejected)
4. Expose the additional columns in a new `extra_columns JSONB` field on the VIEW output

```sql
-- New column on schema_m2m_properties output:
extra_columns JSONB  -- e.g., [{"column_name": "quantity", "data_type": "int4", "is_nullable": false}]
```

### Phase 2: DataService (send extra columns)

Extend `DataService.addManyToManyRelation()` to accept an optional `extraData` parameter:

```typescript
addManyToManyRelation(
  junctionTable: string,
  parentFkCol: string, parentId: string | number,
  relatedFkCol: string, relatedId: string | number,
  extraData?: Record<string, unknown>  // NEW
): Observable<any>
```

The POST payload becomes:
```json
{ "parent_fk": 1, "related_fk": 5, "quantity": 24 }
```

Similarly, add `updateManyToManyRelation()` for PATCH operations on existing junction rows (identified by composite PK).

### Phase 3: ManyToManyEditorComponent (inline editing)

When `extra_columns` is non-empty, the editor renders additional input fields:

1. **On add**: show a mini-form with the extra columns before confirming
2. **Inline display**: show extra column values in the list (e.g., "Folding Chair × 24")
3. **Inline edit**: click to edit extra column values on existing junction rows
4. **Validation**: respect `metadata.validations` for junction table columns

The FK Search Modal variant would show extra fields in a confirmation step after selection.

### Phase 4: SaveProgressComponent (buffered extra data)

Extend the buffer to include extra column values:

```typescript
interface M2MAddition {
  relatedId: string | number;
  extraData?: Record<string, unknown>;  // NEW
}
```

### Phase 5: Quantity-Aware Overlap Checking

For tool reservations specifically, the overlap check (`check_tool_reservation_overlap()`) would need to sum quantities across conflicting reservations rather than just counting them.

## Migration Path

### Backwards Compatibility

All existing pure junction tables continue working unchanged:
- `extra_columns` is an empty array `[]` for pure junctions
- The editor renders in simple add/remove mode when no extra columns exist
- `DataService` calls work identically when `extraData` is omitted

### Configuration

A new `metadata.properties` flag could control whether extra columns are editable:

```sql
-- On the M:M virtual property (e.g., 'event_kit_items_m2m')
INSERT INTO metadata.properties (table_name, column_name, m2m_editable_columns)
VALUES ('parent_table', 'junction_m2m', '["quantity"]');
```

This allows integrators to choose which extra columns are user-editable vs. system-managed.

## Complexity Estimate

| Phase | Effort | Files |
|-------|--------|-------|
| Detection | Small | 1 migration + VIEW |
| DataService | Small | `data.service.ts` |
| Editor Component | Medium | `many-to-many-editor.component.ts`, `fk-search-modal.component.ts` |
| SaveProgress | Small | `save-progress.component.ts` |
| Overlap checking | Medium | Instance-specific trigger functions |
| **Total** | **~2-3 sessions** | **~8 files** |

## Open Questions

1. **Validation timing**: Should extra column validation happen client-side (Angular validators) or rely on database CHECK constraints?
2. **Sort order**: Should extra columns appear in a specific order, or respect `metadata.properties.sort_order`?
3. **Bulk operations**: For quantity-managed items, should the UI offer a quantity stepper inline, or a separate edit modal?
4. **Delete behavior**: When removing a junction row, should there be a confirmation if extra data exists (to prevent accidental data loss)?

## References

- `schema_m2m_properties` VIEW: detects M:M relationships from schema
- `ManyToManyEditorComponent`: `src/app/components/many-to-many-editor/`
- `DataService.addManyToManyRelation()`: `src/app/services/data.service.ts`
- `SaveProgressComponent`: `src/app/components/save-progress/`
- NEH requirements: `examples/neighborhood-hub/neighborhood_engagement_hub_requirements.md` (Story 22)
