# Workflow System Implementation Review

**Date**: 2026-04-22
**Version**: v0.48.0 (staged, pre-merge)
**Reviewer**: Daniel (with Claude Code)
**Design doc**: `docs/notes/GUIDED_FORM_SYSTEM_DESIGN.md`

## Architectural Approach

The design document specified a **dedicated GuidedFormRunnerPage** (`/workflow/:key/:id`) for guided
active workflows. The implementation instead **embeds workflow behavior into existing CRUD pages**
(EditPage, CreatePage, DetailPage, ListPage). This was an intentional decision to avoid duplicating
the entire form-building, property rendering, M:M editor, and validation infrastructure.

**This is a sound tradeoff.** The embedded approach means every property type, file upload, photo
gallery, inline M:M, and validation feature works in guided form steps automatically. A dedicated
runner would have required rebuilding or extracting all of that.

The implementation should be evaluated against this embedded architecture, not the design doc's
runner page. The design doc should be updated to reflect the chosen approach once issues are resolved.

---

## Issues

### Issue 1: `show_on_edit` / `show_on_detail` filter removal — BLOCKER

**Severity**: High — affects ALL entities, not just workflows

**Problem**: `SchemaService.getPropsForEdit()` and `getPropsForDetail()` had their visibility
filters removed globally:

```typescript
// getPropsForDetail — before:
const visibleProps = props.filter(p => p.show_on_detail !== false);
// after:
const visibleProps = props.filter(p => true);

// getPropsForEdit — before:
p.is_updatable && p.show_on_edit !== false;
// after:
p.is_updatable;  // show_on_edit check removed
```

**Why it was done**: Guided form mode needs hidden properties (like `guided_form_status`) available in the
loaded data so that signals like `isGuidedFormDraft` can read `data.guided_form_status`. If the property
is filtered out of the property list, it's excluded from the PostgREST `?select=` query.

**Why it's wrong**: These methods serve two purposes: (1) determine which fields to fetch from the
API, and (2) determine which fields to render in forms. Removing the filter satisfies (1) but
breaks (2) for every entity that has `show_on_edit: false` or `show_on_detail: false` properties.
Integrators who configured property visibility will see previously-hidden fields appear.

**Fix**: Separate the "fetch set" from the "render set." Options:

- **Option A**: Keep the filter in `getPropsForEdit/Detail` but add `guided_form_status` to the
  `ensureStructuralProps()` call (similar to how `display_name` is always fetched).
- **Option B**: Create a `getPropsForDataFetch()` that returns all updatable props (for the
  `?select=` query), and have templates filter the render list using `show_on_edit`/`show_on_detail`.
- **Option C**: Specifically detect `udt_name === 'guided_form_step_status'` and always include it
  in the select string, similar to how `display_name` is handled.

Option A is the narrowest fix and matches existing patterns.

**Test impact**: The spec file changes (`schema.service.spec.ts`) modified the assertions to match
the broken behavior. These tests need to be reverted to their original expectations after the fix.

---

### Issue 2: Auto-save subscription leak

**Severity**: Medium

**Problem**: `setupAutoSave()` subscribes to `editForm.valueChanges` but never unsubscribes:

```typescript
this.editForm.valueChanges
    .pipe(debounceTime(1500), distinctUntilChanged(...))
    .subscribe(values => { ... });
```

`EditPage` imports `OnDestroy` but never implements it. No `takeUntilDestroyed()`, no `Subscription`
tracking, no cleanup.

**Impact**: Each navigation to a guided form edit page adds a live subscription. In a multi-step
workflow session (navigate step 1 → step 2 → step 3 → back to step 1), subscriptions accumulate.
They fire `performAutoSave()` on detached forms, potentially PATCHing stale data.

**Fix**: Track the subscription and clean up on destroy:

```typescript
private autoSaveSub?: Subscription;

private setupAutoSave(): void {
    this.autoSaveSub?.unsubscribe();
    // ... existing setup ...
    this.autoSaveSub = this.editForm.valueChanges.pipe(...).subscribe(...);
}

// In cancelAutoSave or ngOnDestroy:
this.autoSaveSub?.unsubscribe();
```

Or use `takeUntilDestroyed(this.destroyRef)` if a `DestroyRef` is injected.

---

### Issue 3: Race condition between auto-save and saveAndContinue

**Severity**: Medium

**Problem**: `saveAndContinue()` calls `cancelAutoSave()` which disables future auto-saves, but
an auto-save PATCH may already be in flight:

```
User types → 1500ms debounce fires → performAutoSave() sends PATCH (in flight)
User clicks "Save & Continue" → cancelAutoSave() (too late, PATCH already sent)
  → saveAndContinue sends its own PATCH
  → completeStep RPC fires after saveAndContinue's PATCH resolves
  → auto-save PATCH lands whenever (could be before or after completeStep)
```

Two concurrent PATCHes to the same row. Usually harmless (similar data), but edge case: user
changes a field, auto-save fires with old value, user changes it again, clicks "Save & Continue"
with new value — auto-save PATCH could overwrite the new value.

**Fix**: Track the auto-save observable and await it:

```typescript
private autoSaveInFlight = signal(false);

// In performAutoSave:
this.autoSaveInFlight.set(true);
this.data.editData(...).subscribe({
    next: () => this.autoSaveInFlight.set(false),
    error: () => this.autoSaveInFlight.set(false)
});

// In saveAndContinue, wait if in flight:
if (this.autoSaveInFlight()) {
    // wait or skip the intermediate save since saveAndContinue saves everything
}
```

Or simpler: since `saveAndContinue` saves ALL form values, just cancel the timer and ignore
any in-flight auto-save — the full save will overwrite it. The race is only a problem if the
`completeStep` RPC fires before the auto-save PATCH completes. Adding a guard that waits for
`autoSaveInFlight` to clear before calling `completeStep` would be sufficient.

---

### Issue 4: `WorkflowReviewSection` timing — works by accident

**Severity**: Medium

**Problem**: The review section uses `queueMicrotask` to defer `loadStepRecords()`, but microtasks
run in the same event loop turn — long before HTTP responses arrive:

```typescript
ngOnInit(): void {
    this.workflowService.loadDefinition(key);  // fires HTTP
    this.workflowService.loadSteps(key);        // fires HTTP
    queueMicrotask(() => this.loadStepRecords()); // runs before HTTP completes
}
```

`this.dataSteps()` returns `[]` at microtask time, so `loadStepRecords()` exits with
`if (steps.length === 0) return`.

**Why it works**: The `WorkflowNavComponent` (rendered above the review section) loads the same
data in its own `ngOnInit`. By the time the user navigates to the detail page where the review
section renders, the nav has already populated the service's signal cache. The review section
reads from that cache.

**Why it's fragile**: If the review section ever renders without the nav (e.g., deep link to
detail page, or nav is conditionally hidden), it shows zero step data.

**Fix**: Use a reactive pattern — watch the service signals and load step records when steps
become available:

```typescript
// Use effect() to react when steps are populated
effect(() => {
    const steps = this.dataSteps();
    if (steps.length > 0) {
        this.loadStepRecords();
    }
});
```

---

### Issue 5: Review section renders raw column names and values

**Severity**: Low-Medium (UX gap, not a bug)

**Problem**: The review section iterates `Object.keys(record)` and displays raw values:

```html
<span class="opacity-70">{{ key }}</span>         <!-- raw column name: "street_address" -->
<span class="font-medium">{{ record[key] }}</span> <!-- raw value: "5" for FK, ISO date, etc -->
```

The design specified using `DisplayPropertyComponent` for each step's review card, which would
provide display names, FK name resolution, date formatting, etc.

**Impact**: FK fields show raw integer IDs, dates show ISO strings, booleans show `true`/`false`,
column names show `snake_case` instead of display names.

**Fix**: Load properties for each step table via `SchemaService.getPropsForDetail()` and render
with `DisplayPropertyComponent` inside each review card. This matches how the Detail page itself
renders properties.

---

### Issue 6: Unreachable `'submitted'` badge in List page

**Severity**: Low

**Problem**: The list page template includes a case for `guided_form_status === 'submitted'`:

```html
@case ('submitted') {
    <span class="badge badge-info badge-sm">Submitted</span>
}
```

But the `guided_form_step_status` domain only allows `'draft'` and `'complete'`. Submission is
tracked by `submitted_at` (a separate timestamp column), not by changing `guided_form_status`.

**Fix**: Check `row['submitted_at']` instead:

```html
@if (row['submitted_at']) {
    <span class="badge badge-info badge-sm">Submitted</span>
} @else {
    @switch (row['guided_form_status']) { ... }
}
```

This requires `submitted_at` to be in the select fields (which ties back to Issue 1's
fetch-vs-render separation).

---

### Issue 7: `getLockedFields()` is implemented but never called

**Severity**: Low

**Problem**: `GuidedFormService.getLockedFields()` correctly computes the set of parent fields
used in skip/require conditions. But no page component calls it. Fields that drive branching
conditions remain visually editable after step zero completion.

The database-side trigger (`enforce_guided_form_lock`) will reject the update, but the user gets
no visual indication that the field is locked. They'll fill out the field, click save, and
get an error.

**Fix**: In `EditPage.detectGuidedFormMode()`, when `guidedFormStatus === 'complete'` on a parent
entity, call `getLockedFields()` and mark those form controls as disabled:

```typescript
const locked = this.workflowService.getLockedFields(steps);
for (const field of locked) {
    this.editForm?.controls[field]?.disable();
}
```

---

### Issue 8: `completeStep` parameter type inconsistency

**Severity**: Low

**Problem**: `EditPage` passes `parseInt(eId)` while `CreatePage` passes a string `parentId`:

```typescript
// EditPage:
this.workflowService.completeStep(wk, parseInt(eId), stepKey)
// CreatePage:
this.workflow.completeStep(wk, parentId, stepKey)  // parentId is String(...)
```

The RPC expects `BIGINT`. PostgREST likely coerces both, but the inconsistency suggests
copy-paste without normalization.

**Fix**: Pick one convention. Since the design specifies BIGINT parent keys, `parseInt()` or
`Number()` everywhere is cleaner. Or let the service normalize:

```typescript
public completeStep(key: string, parentId: number | string, stepKey: string) {
    return this.http.post<ApiResponse>(
        `${getPostgrestUrl()}rpc/complete_guided_form_step`,
        { p_guided_form_key: key, p_parent_id: Number(parentId), p_step_key: stepKey }
    );
}
```

---

## Architectural Fit Assessment

### How well does this match Civic OS patterns?

**Rating**: Good foundation, needs polish on framework conventions.

| Pattern | Adherence | Notes |
|---|---|---|
| **Metadata-driven** | Strong | `metadata.guided_forms`, `metadata.guided_form_steps`, `metadata.guided_form_step_conditions` follow the same pattern as statuses, categories, validations |
| **PostgREST views** | Strong | `schema_guided_forms`, `schema_guided_form_steps` match `schema_entities`, `schema_properties` pattern |
| **Domain-based type detection** | Strong | `guided_form_step_status` domain auto-detected via `udt_name`, same as `email_address`, `phone_number`, `hex_color` |
| **Signal-based state** | Strong | `GuidedFormService` uses signals consistently; `WorkflowNavComponent` uses computed signals derived from service |
| **OnPush + standalone** | Strong | Both new components use `ChangeDetectionStrategy.OnPush` and are standalone |
| **RPC-based mutations** | Strong | `start_guided_form`, `complete_guided_form_step`, `submit_guided_form` follow the entity action RPC pattern |
| **Security model** | Strong | `SECURITY INVOKER` on views, RLS on `guided_form_progress`, `is_admin()` bypass |
| **Observable caching** | Mixed | `SchemaService` workflow methods use proper `shareReplay` caching, but `GuidedFormService` uses fire-and-forget signals without completion tracking |
| **Property rendering** | Weak | Review section bypasses `DisplayPropertyComponent` — the core abstraction that makes Civic OS property-type-agnostic |
| **Fetch vs render separation** | Weak | Global filter removal in `SchemaService` breaks the established pattern where `getPropsForX()` returns exactly what should be rendered |
| **Subscription management** | Weak | Missing cleanup violates the project's standard of `takeUntilDestroyed` or explicit unsubscribe |

### What follows Civic OS conventions well

1. **The `guided_form_step_status` domain** is the cleanest part of the design. It mirrors
   `email_address` and `phone_number` exactly: a PostgreSQL domain that the frontend auto-detects
   via `udt_name` and handles specially. No explicit `metadata.properties` registration needed.

2. **The metadata tables** follow the established pattern perfectly: `metadata.guided_forms` parallels
   `metadata.entities`, `metadata.guided_form_steps` parallels `metadata.properties`, and
   `metadata.guided_form_step_conditions` parallels `metadata.validations`.

3. **The `schema_guided_forms` / `schema_guided_form_steps` views** follow the `schema_entities` /
   `schema_properties` pattern — metadata tables exposed via public views with
   `security_invoker = true`.

4. **The embed-into-existing-pages approach** is philosophically aligned with Civic OS's core
   principle: the framework generates UI from metadata. Guided form steps ARE entities; they should
   use the same pages.

### What diverges from Civic OS conventions

1. **`GuidedFormService` uses a different caching pattern** than `SchemaService`. The schema service
   returns `Observable` with `shareReplay` — callers subscribe and get data when ready. The workflow
   service fires HTTP calls that write to signals, and callers synchronously read signals that may
   not be populated yet. This creates timing issues (see Issue 4) that the observable pattern avoids.

2. **The review section bypasses the property type system.** Civic OS's strength is that
   `DisplayPropertyComponent` handles every type. The review section renders raw values, which
   means FK names, dates, colors, geo points, etc. all display incorrectly.

3. **The `SchemaService` filter removal breaks the principle** that `getPropsForX()` returns the
   right set for context X. This is a core architectural boundary in Civic OS — the schema service
   is the single source of truth for "what to show where."

---

## Recommended Fix Order

1. **Issue 1** (filter removal) — Fix before merge. Regression to all entities.
2. **Issue 2** (subscription leak) — Fix before merge. Causes bugs in multi-step sessions.
3. **Issue 3** (race condition) — Fix before merge. Data integrity risk.
4. **Issue 4** (review timing) — Fix before merge. Fragile correctness.
5. **Issue 5** (raw rendering) — Can ship as follow-up. UX polish.
6. **Issue 6** (submitted badge) — Can ship as follow-up. Dead code.
7. **Issue 7** (locked fields UI) — Can ship as follow-up. Backend protects.
8. **Issue 8** (type inconsistency) — Can ship as follow-up. Cosmetic.

Issues 1–4 are "fix before merge." Issues 5–8 are "ship, then follow up."
