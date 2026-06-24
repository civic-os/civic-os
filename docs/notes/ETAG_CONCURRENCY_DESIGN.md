# ETag-Based Optimistic Concurrency Control

> Status: **Proposed** — design document, not yet implemented.

## Problem

Civic OS uses a last-write-wins model for all entity updates. When two users edit the same record concurrently, the second save silently overwrites the first user's changes with no warning. This is acceptable for single-user instances (Mott Park) but becomes a data integrity risk as instances scale to multiple concurrent editors (FFSC with site leads, ICGF with case workers).

## Scope

### In Scope: Entity PATCH (Edit Pages)

The only mutation path vulnerable to lost updates is `DataService.editData()`, which issues:

```
PATCH /{entity}?id=eq.{id}
Prefer: return=representation
Content-Type: application/json

{"field": "new_value"}
```

This is used by:
- **Edit Page** — `performEdit()` for standard saves
- **Edit Page** — `executeCoordinatedSave()` for M:M + gallery saves (the entity PATCH step)
- **Edit Page** — auto-save in guided forms (changed fields only)

### Out of Scope

These mutation paths do **not** need ETag protection:

| Path | Why |
|------|-----|
| **Entity Action RPCs** (`executeRpc`) | Server-side atomic functions. The RPC reads current state, validates transitions, and mutates in one transaction. No client-side read-then-write gap. |
| **Status changes** | All status changes go through RPCs (e.g., `approve_building_use_request`), not PATCH. Transition rules are enforced server-side via `metadata.status_transitions`. |
| **Create Page** (`createData`) | New records — no prior state to conflict with. |
| **M:M junction mutations** | `addManyToManyRelation` / `removeManyToManyRelation` use INSERT/DELETE on junction tables with composite PKs. Constraint violations (not silent overwrites) are the failure mode. |
| **Delete** | Deleting a record that was already modified is still valid — the user intended to delete it. |

## How PostgREST ETags Work

PostgREST natively supports HTTP ETag-based concurrency control:

1. **GET** a single row → PostgREST returns an `ETag` header (MD5 hash of the response body)
2. **PATCH** with `If-Match: "{etag}"` → PostgREST re-reads the row, recomputes the hash, and:
   - If match: applies the PATCH normally
   - If mismatch: returns **412 Precondition Failed** without modifying the row

No database schema changes are required. ETags are computed from the HTTP response representation, not a database column. This means:
- Changes to the target row's columns trigger a new ETag
- Changes to embedded/joined resources (FK display names) also trigger a new ETag
- The ETag covers exactly what the client saw, including all `select` expansions

## Proposed Implementation

### 1. Capture ETag on Record Load

`DataService.getData()` currently returns only the response body. Add a variant or option that also captures the `ETag` response header:

```typescript
// New method or overload
getDataWithETag(entity: string, id: string | number, select: string): Observable<{data: any, etag: string}>
```

Alternatively, modify `getData()` to use `observe: 'response'` and extract the header when a single record is requested.

### 2. Store ETag in Edit Page

When `EditPage` loads a record for editing, store the ETag alongside the form data:

```typescript
private currentETag = signal<string | null>(null);
```

Set it when data loads, clear it on navigation away.

### 3. Send If-Match on Save

`DataService.editData()` gains an optional `ifMatch` parameter:

```typescript
editData(entity: string, id: string | number, data: any, ifMatch?: string): Observable<ApiResponse>
```

When provided, add the header:

```typescript
headers = headers.set('If-Match', `"${ifMatch}"`);
```

`EditPage.performEdit()` passes the stored ETag.

### 4. Handle 412 Precondition Failed

**ErrorService**: Add a branch for HTTP 412:

```typescript
case 412:
  return 'This record was modified by another user. Please reload the page and re-apply your changes.';
```

**Edit Page**: On 412, show a clear error modal explaining the conflict. The user's options:
- **Reload and re-edit**: Navigate away and back, or refresh the form data (losing their unsaved changes)
- **Force save**: Remove the `If-Match` header and re-submit (opt-in to last-write-wins)

A "force save" escape hatch is important — in practice, many 412s will be benign (someone changed a different field on the same record). The UX should inform, not block.

### 5. Update ETag After Successful Save

PostgREST returns an `ETag` header on PATCH responses (with `Prefer: return=representation`). After a successful save, update `currentETag` with the new value so subsequent saves (e.g., auto-save in guided forms) don't immediately 412.

## Edge Cases

### Auto-Save in Guided Forms

Guided forms auto-save changed fields periodically. Each auto-save PATCH returns a new ETag. The flow:

1. Load record → store ETag v1
2. Auto-save step 1 fields → send `If-Match: v1` → success → store ETag v2
3. Auto-save step 2 fields → send `If-Match: v2` → success → store ETag v3
4. Final submit → send `If-Match: v3`

If another session edits the record between auto-saves, the next auto-save gets 412. The guided form should surface this as a warning, not silently fail.

### Coordinated Save (Entity + M:M + Galleries)

`executeCoordinatedSave()` runs multiple steps. The entity PATCH is step 1 and should use `If-Match`. If it 412s, abort the remaining steps (junction mutations, gallery saves). The M:M and gallery steps don't need their own ETags.

### Embedded Resource Changes

PostgREST ETags cover the full response including embedded resources. If a referenced entity's display_name changes (e.g., a status label is renamed), the ETag changes even though the target row didn't. This can cause "false positive" 412s. In practice this is rare and the force-save escape hatch handles it.

## Alternative: Database-Level `updated_at` Column

An alternative to HTTP ETags is a database-level `updated_at` timestamp column:

```sql
ALTER TABLE my_entity ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON my_entity
  FOR EACH ROW EXECUTE FUNCTION metadata.set_updated_at();
```

The frontend would send `updated_at` in the PATCH body and a CHECK constraint or trigger would reject updates where the submitted timestamp doesn't match the current value.

**Tradeoffs vs HTTP ETags:**

| | HTTP ETags | `updated_at` column |
|---|---|---|
| Schema changes | None | Column + trigger per table |
| Covers embedded resources | Yes | No (row-level only) |
| False positives | More (embedded changes) | Fewer (row changes only) |
| Works with any HTTP client | Yes (standard HTTP) | No (custom convention) |
| Opt-in per table | No (all or nothing) | Yes (add column selectively) |

**Recommendation**: Start with HTTP ETags (zero schema changes, standard HTTP). If false positives from embedded resource changes become a UX problem, consider `updated_at` as a targeted supplement for high-contention tables.

## Implementation Effort

| Component | Effort | Files |
|-----------|--------|-------|
| `DataService` changes | Small | `src/app/services/data.service.ts` |
| `EditPage` ETag capture + send | Medium | `src/app/pages/edit/edit.page.ts` |
| `ErrorService` 412 handling | Small | `src/app/services/error.service.ts` |
| Conflict error modal UX | Small | Edit page template |
| Auto-save ETag chaining | Medium | `src/app/pages/edit/edit.page.ts` |
| Tests | Medium | Spec files for above |

No database migrations. No PostgREST configuration changes. No backend work.

## Related

- PostgREST docs: [ETag handling](https://docs.postgrest.org/en/latest/references/api/resource_representation.html#entity-tag)
- KB concept: [Consolidated Go Worker](/decisions/consolidated-go-worker.md) (RPCs are atomic, no ETag needed)
