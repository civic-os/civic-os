# Admin Page Pitfalls & Patterns

Common pitfalls when building admin pages with multi-phase data loading, reactive Angular architecture, and PostgREST queries. Documented during the File Administration feature (v0.39.0) but applies broadly to any page that loads data from multiple sources or has complex filter/pagination state.

**Read this before building a new admin page.**

## Wrong Assumptions (Start Here)

These are assumptions made during development that turned out to be wrong and required rework. Reading these first will save you from repeating the same mistakes.

### 1. "Imperative method chaining is fine for multi-phase data loading"

**Assumption**: Wire up `loadEntityProperties()` → `executePhase1And2()` as sequential method calls, where the first method loads schema metadata and the second uses it.

**Why it's wrong**: `loadEntityProperties()` is async (HTTP call to SchemaService). The Phase 1 method fires immediately after, reads `filePropertyColumns()` before properties have loaded, and gets an empty array. The page appears blank until the user manually triggers a refresh.

**The fix wasn't chaining with `.subscribe()` either** — that just moves the timing dependency to a different place and still breaks when a third signal (like entity filters) changes independently. The real fix: use Angular `effect()` so each phase is a reactive node that automatically re-runs when its input signals change. No manual orchestration needed.

### 2. "Query files by entity_id to find an entity's files"

**Assumption**: Phase 1 collects entity IDs, Phase 2 queries `files?entity_type=eq.X&entity_id=in.(entity_ids)`. This seemed natural because `metadata.files` has `entity_type` and `entity_id` columns.

**Why it's wrong**: When a user removes a file from an entity (sets the FK column to NULL), the file record in `metadata.files` still has the old `entity_type` and `entity_id`. These are orphaned files — no longer linked to the entity but still showing up in results. The admin sees files that don't belong to any entity property.

**Correct approach**: Phase 1 SELECTs the actual file FK columns from the entity table (e.g., `photo`, `attachment`), extracts the UUID values, and Phase 2 queries `files?id=in.(actual_file_uuids)`. This guarantees only actively-linked files appear.

### 3. "`[value]` binding on `<select>` is reactive"

**Assumption**: Bind the selected value to the `<select>` element with `[value]="currentEntityType()"` and it will update when the signal changes, including on direct URL navigation.

**Why it's wrong**: When the page loads via direct URL (e.g., `/admin/files?entity=Issue`), the signal is set from query params before the `<option>` elements render (they depend on async schema data). By the time options exist, Angular has already evaluated `[value]` and moved on. The select shows "All Files" even though the URL says `entity=Issue`.

**Second wrong assumption**: Switch to `ngModel`. This has the same fundamental problem — it's a one-time binding that doesn't re-evaluate when options appear later.

**Correct approach**: Use `[selected]` on each individual `<option>` element. This attribute is evaluated per-option whenever the options render or the signal changes, so it works regardless of timing.

### 4. "File-level filters only make sense in All Files mode"

**Assumption**: When viewing files for a specific entity type (Entity Files mode), the user only needs entity-level filters (status, category, etc.). File-level filters like file type, date range, and filename search were hidden.

**Why it's wrong**: Users want to combine both levels — "show me all PDF files uploaded to Issues in the last month." Entity filters narrow which entities to look at, file filters narrow which files within those entities. Hiding file filters in entity mode removes a useful capability.

### 5. "Test cleanup can just DELETE file records"

**Assumption**: At the end of a functional test, run `DELETE FROM metadata.files WHERE ...` to clean up test data.

**Why it's wrong**: Entity tables have FK columns (e.g., `Issue.photo`) referencing `metadata.files(id)`. PostgreSQL FK constraints prevent deleting the file record while an entity still references it. When cleanup errors are piped to `/dev/null` (common in test scripts), the DELETE silently fails and test data accumulates across runs.

**Correct approach**: Clear FK references first (`UPDATE "Issue" SET photo = NULL`), then delete file records. For bulk cleanup, disable triggers temporarily.

### 6. "Test scripts can set up schema changes for testing"

**Assumption**: The functional test script can `ALTER TABLE ADD COLUMN` or `CREATE EXTENSION` to set up the test environment.

**Why it's wrong**: Schema changes in test scripts are not idempotent (running twice fails on "column already exists"), can't be reverted by test cleanup, conflict with Sqitch migration state, and give false confidence that migrations work. Schema belongs in migrations; tests should only manipulate data within the existing schema.

---

## Angular Reactive Architecture

### Use Signal/Effect Chains, Not Imperative Subscriptions

The initial implementation used imperative method calls chained together: `loadEntityProperties()` → `executePhase1And2()` → `executePhase2Only()`. This introduced timing bugs because `loadEntityProperties()` is async but Phase 1 read `filePropertyColumns()` before properties had loaded.

**Solution**: Three `effect()` instances with signal-based dependency tracking:

1. **entityPropsEffect** — reads `currentEntityType`, writes `entityProperties`
2. **phase1Effect** — reads `currentEntityType` + `entityFilters` + `filePropertyColumns`, writes `cachedFileIds`
3. **dataLoadEffect** — reads page/sort/filter signals + `cachedFileIds` (conditionally), performs final query

Each effect automatically re-runs when its input signals change. No manual orchestration, no timing issues.

### Conditional Signal Reads Control Dependency Tracking

Angular's `effect()` tracks which signals are read during execution. Reading a signal inside a conditional branch means the effect only depends on that signal when the branch executes:

```typescript
private dataLoadEffect = effect((onCleanup) => {
  const entityType = this.currentEntityType();
  if (entityType === 'all') {
    // Direct query — cachedFileIds NOT read, so changes to it don't trigger re-run
  } else {
    const fileIds = this.cachedFileIds(); // Only tracked in entity mode
  }
});
```

This means page/sort changes in All Files mode skip Phase 1 entirely — the effect only re-runs the direct file query.

### Set Loading State Before Early-Return Guards

When an effect returns early while waiting for an async dependency, the spinner may be visible but show no descriptive text:

```typescript
// BAD: loading phase not set before guard
if (fileCols.length === 0) { return; }  // properties still loading
this.loadingPhase.set('searching-entities');

// GOOD: loading phase visible during the wait
this.loading.set(true);
this.loadingPhase.set('searching-entities');
if (fileCols.length === 0) { return; }  // user sees "Searching entities..."
```

### Use `untracked()` for HTTP Calls Inside Effects

Wrap HTTP subscriptions in `untracked()` to prevent the Observable subscription from creating unwanted signal dependencies:

```typescript
const sub = untracked(() =>
  this.http.get<any[]>(url).subscribe(result => {
    this.files.set(result);
  })
);
onCleanup(() => sub.unsubscribe());
```

### Angular 20 Select Binding

`<select>` binding options in order of reliability:

- **`[value]` on `<select>`** — Doesn't re-apply when options load asynchronously. Avoid.
- **`ngModel` on `<select>`** — Not reactive enough for signal-driven state in Angular 20.
- **`[selected]` on each `<option>`** — Evaluates per-option when signals change. Reliable.

```html
<select #entitySelect (change)="onEntitySelectedByValue(entitySelect.value)">
  <option value="all" [selected]="currentEntityType() === 'all'">All Files</option>
  @for (entity of entityOptions(); track entity.value) {
    <option [value]="entity.value" [selected]="currentEntityType() === entity.value">
      {{ entity.label }}
    </option>
  }
</select>
```

## Functional Testing Practices

### Never Modify Database Schema in Test Scripts

Test scripts should only INSERT/UPDATE/DELETE data. Schema changes (`ALTER TABLE`, `CREATE INDEX`, `CREATE EXTENSION`) belong exclusively in Sqitch migrations. Mixing schema changes into test scripts creates:
- Irreversible state that can't be cleaned up by test teardown
- Conflicts with migration revert/re-deploy cycles
- False confidence that schema changes work (no proper verify/revert testing)

### Create Dummy Files for Upload Tests

Don't rely on pre-existing files or external resources. Create small test files inline:

```bash
dd if=/dev/urandom bs=1024 count=5 of=/tmp/test_photo.png 2>/dev/null
echo "test content" > /tmp/test_report.pdf
```

This makes tests self-contained and repeatable across environments.

### FK-Aware Test Cleanup

Entity tables may have FK columns referencing `metadata.files`. PostgreSQL FK constraints silently block deletion when references exist. Cleanup must clear FKs first:

```sql
-- 1. Clear FK references on entity tables
ALTER TABLE "Issue" DISABLE TRIGGER ALL;
UPDATE "Issue" SET photo = NULL WHERE photo IS NOT NULL;
ALTER TABLE "Issue" ENABLE TRIGGER ALL;

-- 2. Now delete file records (FK constraints satisfied)
DELETE FROM metadata.files WHERE file_name IN ('test1.png', 'test2.pdf');
```

### Idempotent Test Setup

Always clean leftover data at the TOP of the script, before assertions. Previous runs may have been interrupted mid-cleanup:

```bash
# Pre-cleanup at top of script (handles interrupted previous runs)
DELETE FROM metadata.files WHERE file_name IN ('test1.png', 'test2.pdf') 2>/dev/null;
echo "Previous test data cleaned."
```

### Test Both PostgREST and Direct SQL Paths

PostgREST adds RLS/permission enforcement that raw SQL bypasses. Test file queries through both:
- Direct SQL: validates the data model and functions work
- PostgREST API: validates RLS policies, permission checks, and HTTP response format (Content-Range, etc.)

## PostgREST Query Strategies

### Two-Phase Entity-to-File Queries

The naive approach — `files?entity_type=eq.X&entity_id=in.(ids)` — shows orphaned files (records where the entity FK column was set to NULL but the file record still references the entity).

**Solution**: Phase 1 selects the actual file FK column values from entity records, Phase 2 queries files by their primary key:

```
Phase 1: GET /{entity}?select=id,display_name,photo,attachment&or=(photo.not.is.null,attachment.not.is.null)
Phase 2: GET /files?id=in.(uuid1,uuid2,...)
```

This guarantees only actively-linked files appear in entity mode results.

### Document Type Filtering with PostgREST `or=()`

Grouping multiple MIME types under a "Documents" filter requires PostgREST's `or=()` syntax:

```
or=(file_type.eq.application/pdf,file_type.like.application/vnd.openxmlformats%,file_type.like.application/vnd.ms-%,file_type.like.application/vnd.oasis.opendocument%,file_type.like.application/msword%)
```

### Shared File Filter Builder

Extract file-level filters (type, date range, search) into a single `buildFileFilterParams()` method returning `&`-prefixed params. Used by both All Files and Entity Files modes to avoid duplication.
