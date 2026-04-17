# Workflow System Design

**Status**: Design — pre-implementation
**Version target**: TBD (next minor after 0.42.x)

## Overview

Civic OS needs a way to collect data across multiple ordered steps in a single cohesive
session — permit applications, grant submissions, onboarding flows. The existing system
handles individual entity CRUD well but has no concept of sequencing, partial completion,
step-level branching, or explicit final submission.

This document captures the design for a general-purpose multi-step workflow framework that
follows the same philosophy as statuses, validations, and categories: integrators define
PostgreSQL tables and register them in metadata; the framework generates the sequencing UI,
enforces step-level data integrity, and provides resumable session state.

---

## Design Goals

- **Auto-save**: every step auto-saves while the user is typing (draft state)
- **Resumable**: reload the page mid-workflow and land on the right step
- **Branching**: skip entire steps based on values set in step zero (the parent record)
- **DB-enforced validation**: required fields enforced by PostgreSQL CHECK constraints at
  completion time, not just in frontend code
- **Lockable parent**: fields used in skip conditions become immutable once step zero completes,
  guaranteeing condition stability for the workflow's lifetime
- **Revisitable**: completed steps can be viewed and re-edited (constraints stay armed)
- **Explicit submission**: users explicitly submit the workflow via a synthesized review step
- **RLS-native access control**: single-owner by default; M:M ownership table can be added
  without framework changes

---

## Core Concepts

### Parent-as-step-zero

The parent record is **step 0 of the workflow**, not a separate concept. The parent table
participates in the same `workflow_status` mechanism as the step tables. The framework treats
the parent as the first step the user fills out, then proceeds through integrator-defined
steps that reference the parent via FK.

This unification has three big benefits:
1. The user enters the workflow runner immediately — no separate "create the parent" UX moment
2. Fields that drive skip conditions are set in step zero, where they're naturally collected
3. Once step zero is `'complete'`, the framework locks condition fields → branching is stable
   for the entire workflow lifetime

### Step entities

Each subsequent step has its own table (e.g., `permit_site_info`, `permit_owner_info`) with an
FK back to the parent. The relationship is 1:1 per instance — one parent → at most one record
per step table.

### Workflow definition

Registered in metadata via SQL helper functions. Describes the ordered steps, optional skip
conditions, and what happens when the workflow is finally submitted.

### Progress tracking (hybrid)

Two complementary mechanisms:

1. **`workflow_status` column** on every participating table (parent + step tables), typed
   as the `metadata.workflow_step_status` domain. Enables conditional CHECK constraints.

2. **`metadata.workflow_progress` table** — denormalized completion log written atomically
   alongside the step status UPDATE. Enables O(1) resume queries without querying N step tables.

### Synthesized review step

After all data steps are complete, the runner shows a framework-generated review screen —
collapsible cards summarizing each step. The user explicitly clicks "Submit Application" to
finalize. This is the only point at which `on_complete_rpc` fires.

---

## Architecture Decision: Hybrid Progress Tracking

### The problem

Three competing requirements pulled in different directions:

1. **DB-enforced validation** — we want PostgreSQL CHECK constraints to enforce required
   fields at the moment of step completion, not just in frontend code.
2. **Efficient resume** — on page load we need to know which steps are complete without
   querying N separate step tables.
3. **Clean step tables** — step tables should work as regular Civic OS entities without
   framework-imposed columns leaking into normal forms.

### Why a hybrid

- **`workflow_status` column** enables conditional CHECK constraints (`CHECK (workflow_status =
  'draft' OR field IS NOT NULL)`). Source of truth for step-level data integrity.
- **`metadata.workflow_progress` table** is a denormalized index of completions. Single query
  on page load returns all completed step keys for an instance.

The two are kept consistent because `complete_workflow_step` writes both in one transaction.

### Why `metadata` schema for `workflow_progress`?

Following the precedent of `metadata.entity_notes`: framework-managed tables (both
configuration and runtime state) live in the `metadata` schema. PostgREST accesses them via
thin `public` views. RLS lives on the underlying `metadata` table; the view inherits it.

`metadata` = framework-managed; `public` = integrator application tables + PostgREST views.

### Why parent-as-step-zero?

The alternative — "create parent via existing CreatePage, then enter workflow via entity
action" — has two problems:

1. **UX friction**: the user fills out a "create permit" form before they can fill out the
   permit. The parent's create form is awkward because most fields are meant to be collected
   later.
2. **Condition instability**: fields driving skip conditions must be set at parent-create time
   (before the workflow runs), or conditions evaluate against missing data. And once the
   workflow is running, normal Edit page access could change those fields out from under it.

Parent-as-step-zero collapses both problems: the parent's data is collected as the first step
of the workflow, and once that step completes, the framework locks the fields used in
conditions via a BEFORE UPDATE trigger.

---

## Database Schema

### `metadata.workflow_step_status` domain

```sql
CREATE DOMAIN metadata.workflow_step_status AS VARCHAR(20)
    NOT NULL DEFAULT 'draft'
    CHECK (VALUE IN ('draft', 'complete'));
```

A new column type. The framework auto-detects it via `udt_name` and:
- Hides any column of this type from `show_on_create/edit/list/detail` automatically
  (no explicit `metadata.properties` registration needed)
- Treats any table containing such a column as workflow-participating

Mirrors the existing pattern for `email_address`, `phone_number`, `hex_color`.

### `metadata.workflows`

```sql
CREATE TABLE metadata.workflows (
    workflow_key      NAME PRIMARY KEY,
    display_name      VARCHAR(100) NOT NULL,
    description       TEXT,
    parent_table      NAME NOT NULL,
    parent_pk_type    TEXT NOT NULL                    -- 'int4' | 'int8' | 'uuid'
                      CHECK (parent_pk_type IN ('int4', 'int8', 'uuid')),
    on_submit_rpc     NAME,                            -- called by submit_workflow RPC
    on_submit_navigate_to TEXT,                        -- e.g. '/view/permits/{id}'
    review_intro_text TEXT,                            -- markdown shown above review cards
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`parent_pk_type` is captured at registration time so the dynamic SQL in `complete_workflow_step`
doesn't need to look it up at runtime, and unsupported types are rejected immediately.

### `metadata.workflow_steps`

```sql
CREATE TABLE metadata.workflow_steps (
    id                SERIAL PRIMARY KEY,
    workflow_key      NAME NOT NULL REFERENCES metadata.workflows ON DELETE CASCADE,
    step_key          NAME NOT NULL,                   -- '__parent__' for step zero
    display_name      VARCHAR(100) NOT NULL,
    description       TEXT,
    step_table        NAME NOT NULL,
    parent_fk_column  NAME,                            -- NULL for step zero (table IS parent)
    step_order        INT NOT NULL,                    -- 0 for parent step
    can_skip          BOOLEAN NOT NULL DEFAULT FALSE,
    track_key         TEXT,                            -- optional v1.5 grouping hint
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workflow_key, step_key),
    UNIQUE (workflow_key, step_order)
);
```

Step zero is registered automatically by `register_workflow()` with `step_key = '__parent__'`,
`step_table = parent_table`, `parent_fk_column = NULL`, `step_order = 0`.

### `metadata.workflow_step_conditions`

Conditions reference parent record fields (locked once step zero completes).

```sql
CREATE TABLE metadata.workflow_step_conditions (
    id                SERIAL PRIMARY KEY,
    workflow_step_id  INT NOT NULL REFERENCES metadata.workflow_steps ON DELETE CASCADE,
    condition_type    TEXT NOT NULL CHECK (condition_type IN ('skip_if', 'require_if')),
    field             NAME NOT NULL,                   -- column on parent_table
    operator          TEXT NOT NULL CHECK (operator IN ('eq', 'neq', 'is_null', 'is_not_null')),
    value             TEXT,
    sort_order        INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        (operator IN ('is_null', 'is_not_null') AND value IS NULL) OR
        (operator NOT IN ('is_null', 'is_not_null') AND value IS NOT NULL)
    )
);
```

`skip_if`: step skipped when true. `require_if`: step required (overrides `can_skip`) when true.
v1: conditions cannot be added to step zero (step zero is always required, never skipped).

### `metadata.workflow_progress`

```sql
CREATE TABLE metadata.workflow_progress (
    id              BIGSERIAL PRIMARY KEY,
    workflow_key    NAME NOT NULL,
    parent_id       TEXT NOT NULL,                     -- TEXT supports INT and UUID parents
    step_key        NAME NOT NULL,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_by    UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,
    submitted_at    TIMESTAMPTZ,                       -- set by submit_workflow on the '__parent__' row
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workflow_key, parent_id, step_key)
);

CREATE INDEX ON metadata.workflow_progress (workflow_key, parent_id);
CREATE INDEX ON metadata.workflow_progress (completed_by);

ALTER TABLE metadata.workflow_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_progress_select ON metadata.workflow_progress
    FOR SELECT TO authenticated
    USING (completed_by = current_user_id() OR is_admin());

CREATE POLICY workflow_progress_insert ON metadata.workflow_progress
    FOR INSERT TO authenticated
    WITH CHECK (completed_by = current_user_id());

CREATE POLICY workflow_progress_update ON metadata.workflow_progress
    FOR UPDATE TO authenticated
    USING (completed_by = current_user_id() OR is_admin());
```

`submitted_at` is stored on the `__parent__` row after `submit_workflow` runs. Allows the
frontend to detect "this workflow is fully submitted" with a single query.

### Parent table requirements

The parent table (any table referenced by `metadata.workflows.parent_table`) must:

```sql
CREATE TABLE public.permits (
    id              SERIAL PRIMARY KEY,
    workflow_status metadata.workflow_step_status,     -- required: domain default = 'draft'
    is_self_contractor BOOLEAN NOT NULL DEFAULT FALSE, -- example field driving skip condition
    -- ...other parent fields
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Conditional CHECKs for required fields
    CONSTRAINT permits_self_contractor_required
        CHECK (workflow_status = 'draft' OR is_self_contractor IS NOT NULL)
);
```

The framework enforces (at registration time): the parent table must have a column of type
`metadata.workflow_step_status`. If missing, `register_workflow` raises an exception.

### Step table requirements

Same convention; uses the domain for the status column:

```sql
CREATE TABLE public.permit_site_info (
    id              SERIAL PRIMARY KEY,
    permit_id       INT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    workflow_status metadata.workflow_step_status,
    street_address  VARCHAR(255),
    parcel_number   VARCHAR(50),
    project_description TEXT,

    CONSTRAINT site_info_address_required
        CHECK (workflow_status = 'draft' OR street_address IS NOT NULL),
    CONSTRAINT site_info_parcel_required
        CHECK (workflow_status = 'draft' OR parcel_number IS NOT NULL)
);
CREATE UNIQUE INDEX ON permit_site_info(permit_id);
```

The 1:1 with parent is enforced by the unique index on `parent_fk_column`.

### Lock trigger

`register_workflow()` creates a BEFORE UPDATE trigger on the parent table that prevents
modifications to fields used in skip/require conditions once `workflow_status = 'complete'`.

```sql
-- Generic trigger function (created once in the migration)
CREATE OR REPLACE FUNCTION metadata.enforce_workflow_lock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_locked_field NAME;
BEGIN
    -- Admins bypass the lock entirely
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    -- Only enforce lock when transitioning from 'complete' to anything
    -- (or staying 'complete' with field changes)
    IF OLD.workflow_status != 'complete' THEN
        RETURN NEW;
    END IF;

    -- Block reverting to draft once complete
    IF NEW.workflow_status != 'complete' THEN
        RAISE EXCEPTION 'Cannot revert workflow_status from complete to draft on %',
            TG_TABLE_NAME;
    END IF;

    -- For each locked field, check if it changed
    FOR v_locked_field IN
        SELECT DISTINCT wsc.field
        FROM metadata.workflows w
        JOIN metadata.workflow_steps ws ON ws.workflow_key = w.workflow_key
        JOIN metadata.workflow_step_conditions wsc ON wsc.workflow_step_id = ws.id
        WHERE w.parent_table = TG_TABLE_NAME
    LOOP
        EXECUTE format(
            'SELECT ($1).%I IS DISTINCT FROM ($2).%I',
            v_locked_field, v_locked_field
        ) INTO STRICT v_locked_field USING OLD, NEW;

        IF v_locked_field = 'true' THEN
            RAISE EXCEPTION 'Field % is locked while workflow is complete', v_locked_field
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

-- Per-parent-table trigger created by register_workflow():
-- CREATE TRIGGER enforce_workflow_lock BEFORE UPDATE ON public.permits
--     FOR EACH ROW EXECUTE FUNCTION metadata.enforce_workflow_lock();
```

The trigger uses `ERRCODE = 'check_violation'` so the error flows through the existing
`ErrorService.parseToHuman()` pipeline alongside CHECK constraint failures.

### PostgREST views

```sql
-- Workflow definitions
CREATE VIEW public.schema_workflows AS
SELECT workflow_key, display_name, description, parent_table, parent_pk_type,
       on_submit_rpc, on_submit_navigate_to, review_intro_text, is_enabled
FROM metadata.workflows
WHERE is_enabled = TRUE;
ALTER VIEW public.schema_workflows SET (security_invoker = true);
GRANT SELECT ON public.schema_workflows TO web_anon, authenticated;

-- Steps with conditions embedded as JSONB
CREATE VIEW public.schema_workflow_steps AS
SELECT
    ws.id, ws.workflow_key, ws.step_key, ws.display_name, ws.description,
    ws.step_table, ws.parent_fk_column, ws.step_order, ws.can_skip, ws.track_key,
    COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object('id', c.id, 'condition_type', c.condition_type,
                               'field', c.field, 'operator', c.operator, 'value', c.value)
            ORDER BY c.sort_order
         ) FROM metadata.workflow_step_conditions c WHERE c.workflow_step_id = ws.id),
        '[]'::jsonb
    ) AS conditions
FROM metadata.workflow_steps ws
ORDER BY ws.workflow_key, ws.step_order;
ALTER VIEW public.schema_workflow_steps SET (security_invoker = true);
GRANT SELECT ON public.schema_workflow_steps TO web_anon, authenticated;

-- Progress (thin view over metadata table)
CREATE VIEW public.workflow_progress AS
SELECT id, workflow_key, parent_id, step_key, completed_at,
       completed_by, submitted_at, created_at
FROM metadata.workflow_progress;
GRANT SELECT, INSERT, UPDATE ON public.workflow_progress TO authenticated;
```

---

## Helper RPCs

### Registration helpers

`register_workflow()` does more than insert a row — it also:
1. Validates the parent table exists and has a `workflow_step_status` column
2. Detects the parent PK type from `information_schema.columns`
3. Inserts the workflow row with `parent_pk_type` populated
4. Inserts the auto-step-zero row in `metadata.workflow_steps` (`step_key='__parent__'`)
5. Creates the lock trigger on the parent table (idempotent — drops existing first)

```sql
SELECT register_workflow(
    p_workflow_key   := 'permit_application',
    p_display_name   := 'Permit Application',
    p_parent_table   := 'permits',
    p_description    := 'Multi-step building permit application',
    p_on_submit_rpc  := 'submit_permit',
    p_on_submit_navigate_to := '/view/permits/{id}',
    p_parent_step_display_name := 'Application Type',
    p_review_intro_text := 'Please review your information before submitting.'
);

SELECT add_workflow_step('permit_application', 'site_info',
    'Site Information', 1, 'permit_site_info', 'permit_id');

SELECT add_workflow_step_condition('permit_application', 'contractor_info',
    'skip_if', 'is_self_contractor', 'eq', 'true');
```

### `complete_workflow_step` (called from frontend)

Atomic two-write RPC. `SECURITY INVOKER` (default) — RLS on the step table determines whether
the user can update the row.

Logic:
1. Look up `step_table`, `parent_fk_column`, parent's `parent_pk_type` from
   `metadata.workflow_steps` joined to `metadata.workflows`
2. Branch:
   - If `parent_fk_column IS NULL` (step zero): `UPDATE {parent_table} WHERE id = parent_id`
   - Otherwise: `UPDATE {step_table} WHERE {parent_fk_column} = parent_id`
3. Cast `parent_id TEXT` using the cached `parent_pk_type` (e.g. `$1::int4` or `$1::uuid`)
4. CHECK constraints (and the lock trigger for step zero) fire here; violation rolls back
5. If `UPDATE ... RETURNING 1` returns no row:
   - If a `SELECT 1 FROM table WHERE pk = parent_id` finds a row: RLS blocked it
     → return `{success: false, message: 'Permission denied'}`
   - Otherwise: record doesn't exist → return `{success: false, message: 'Save the form before completing'}`
6. `INSERT INTO metadata.workflow_progress ON CONFLICT DO NOTHING`
7. Returns `{success: true, all_data_steps_complete: <bool>}` so the frontend knows when to
   advance to the synthesized review step
8. `EXCEPTION WHEN check_violation THEN` → `{success: false, message: SQLERRM, sqlstate: '23514'}`

`all_data_steps_complete` is computed by:
- Getting all steps for the workflow except `__parent__`
- Evaluating each skip_if/require_if against the (locked) parent record
- Checking that all non-skipped, required steps now have progress entries

### `submit_workflow` (called from review step)

```sql
CREATE FUNCTION public.submit_workflow(
    p_workflow_key NAME,
    p_parent_id    TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_workflow      metadata.workflows%ROWTYPE;
    v_result        JSONB;
BEGIN
    SELECT * INTO v_workflow FROM metadata.workflows WHERE workflow_key = p_workflow_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown workflow');
    END IF;

    -- Re-validate that all required steps are complete
    -- (defends against direct API calls bypassing the frontend)
    IF NOT public._check_workflow_complete(p_workflow_key, p_parent_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Workflow has incomplete required steps');
    END IF;

    -- Mark the parent step as submitted
    UPDATE metadata.workflow_progress
       SET submitted_at = NOW()
     WHERE workflow_key = p_workflow_key
       AND parent_id    = p_parent_id
       AND step_key     = '__parent__';

    -- Optional integrator hook (called within this transaction)
    IF v_workflow.on_submit_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_workflow.on_submit_rpc)
            INTO v_result USING p_parent_id;
        IF v_result IS NOT NULL AND (v_result->>'success')::boolean = false THEN
            RAISE EXCEPTION '%', v_result->>'message';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'navigate_to', replace(COALESCE(v_workflow.on_submit_navigate_to, ''),
                                '{id}', p_parent_id)
    );
END;
$$;
```

`on_submit_rpc` signature: `(p_parent_id TEXT) RETURNS JSONB` — same convention as
entity actions. Failure raises an exception which rolls back the entire submission.

### `get_workflow_progress` (called on page load)

```sql
SELECT step_key, completed_at, completed_by, submitted_at
FROM metadata.workflow_progress
WHERE workflow_key = p_workflow_key
  AND parent_id = p_parent_id
  AND (completed_by = current_user_id() OR is_admin());
```

### `start_workflow` (called from /workflow/:key/new)

```sql
CREATE FUNCTION public.start_workflow(p_workflow_key NAME)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_workflow metadata.workflows%ROWTYPE;
    v_new_id   TEXT;
BEGIN
    SELECT * INTO v_workflow FROM metadata.workflows WHERE workflow_key = p_workflow_key;
    IF NOT FOUND OR NOT v_workflow.is_enabled THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown or disabled workflow');
    END IF;

    -- Insert a new parent record with workflow_status='draft' (domain default)
    -- and created_by populated by the row's default if present
    EXECUTE format(
        'INSERT INTO public.%I DEFAULT VALUES RETURNING id::text',
        v_workflow.parent_table
    ) INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'parent_id', v_new_id,
        'navigate_to', '/workflow/' || p_workflow_key || '/' || v_new_id
    );
END;
$$;
```

This is the entry point for creating a new instance. Integrators can also link directly to
`/workflow/{key}/new` from a list page or dashboard widget.

---

## Routes

| Route | Purpose |
|---|---|
| `/workflow/:workflowKey/new` | Creates parent record via `start_workflow`, redirects to runner |
| `/workflow/:workflowKey/:parentId` | Loads existing instance, resumes at first incomplete step |

Both protected by `[schemaVersionGuard, authGuard]`.

For resume from a Detail page entity action, integrators register a navigation RPC:

```sql
CREATE FUNCTION continue_permit_workflow(p_id INT) RETURNS JSONB LANGUAGE SQL AS $$
  SELECT jsonb_build_object('success', true,
    'navigate_to', '/workflow/permit_application/' || p_id::text);
$$;
```

---

## Data Flow

### State machine for a single step

```
Not started:   no row in step_table WHERE parent_fk = parent_id
               no entry in workflow_progress

In progress:   row EXISTS (workflow_status = 'draft')
               no entry in workflow_progress

Completed:     row EXISTS (workflow_status = 'complete')
               entry EXISTS in workflow_progress

Submitted:    (workflow-level) parent_step entry in workflow_progress has submitted_at IS NOT NULL
```

### New workflow entry

```
User clicks "Start New Permit" link
  → navigate /workflow/permit_application/new
  → WorkflowRunnerPage detects 'new', calls start_workflow RPC
  → backend INSERT INTO permits DEFAULT VALUES (workflow_status='draft' from domain)
  → backend returns { parent_id: '42', navigate_to: '/workflow/permit_application/42' }
  → router.navigate(navigate_to) → reload as resume
```

### Resume (page load)

```
/workflow/permit_application/42
  → combineLatest([
      GET /schema_workflows?workflow_key=eq.permit_application,
      GET /schema_workflow_steps?workflow_key=eq.permit_application,
      callRpc('get_workflow_progress', { workflow_key, parent_id: '42' })
    ])
  → fetch parent record: GET /permits?id=eq.42
  → if any progress entry has submitted_at IS NOT NULL → workflow already submitted
       → redirect to on_submit_navigate_to OR show "already submitted" message
  → getEffectiveSteps(definition, parentRecord, progress)
       evaluates skip_if/require_if against parent record (which is locked if step zero done)
       marks completed steps from progress entries
  → seekToCurrentStep(): first non-completed, non-skipped step
       (step zero counts as a step here — if parent.workflow_status='draft', we resume there)
  → render
```

### Auto-save (any step, including step zero)

```
User types in form
  → 1500ms debounce
  → if no record yet:
       step zero: PATCH /permits?id=eq.42 with { ...fields }
                  (parent record already exists from start_workflow)
       data step: POST /permit_site_info { ...fields, permit_id: 42 }
                  (creates with workflow_status='draft' default)
  → if record exists: PATCH with { ...changedFieldsOnly }
       PATCH never touches workflow_status
  → step stays 'draft'; no workflow_progress entry written
```

### Step completion ("Save & Continue")

```
User clicks "Save & Continue"
  → WorkflowRunnerPage.advanceStep()
  → cancel pending debounced auto-save
  → await any in-flight save (pendingSave$ signal)
  → force synchronous save of current form values (firstValueFrom)
  → executeRpc('complete_workflow_step', { workflow_key, parent_id, step_key })
       BEGIN TRANSACTION
         UPDATE step_table SET workflow_status = 'complete' WHERE pk = parent_id
           -- step zero: trigger fires; locked fields are now immutable
           -- data step: CHECK constraints enforce required fields
           -- check_violation → ROLLBACK → {success: false, message: SQLERRM}
         INSERT INTO metadata.workflow_progress ON CONFLICT DO NOTHING
         compute all_data_steps_complete
       COMMIT
       → {success: true, all_data_steps_complete: true|false}
  → frontend updates progress signal optimistically
  → effectiveSteps recomputed
  → if all_data_steps_complete: advance to synthesized review step (uiIndex = N+1)
  → otherwise: activeStepIndex++ to next non-skipped data step
```

### Review step + submission

```
After last data step completes
  → WorkflowRunnerPage renders WorkflowReviewStepComponent
       loads each completed step's record (parallel GET)
       renders each as a collapsible card via DisplayPropertyComponent
       cards have "Edit" button that navigates back to that step in edit mode
       review_intro_text rendered as markdown above the cards
       big "Submit Application" button at the bottom

User clicks "Submit Application"
  → executeRpc('submit_workflow', { workflow_key, parent_id })
       BEGIN TRANSACTION
         re-validate all_data_steps_complete (defense against direct API)
         UPDATE workflow_progress SET submitted_at = NOW() WHERE step_key = '__parent__'
         if on_submit_rpc configured: EXECUTE it; failure → ROLLBACK
       COMMIT
       → {success: true, navigate_to: '/view/permits/42'}
  → router.navigate(result.navigate_to)
```

### Back-navigation to a completed step

```
User clicks step 1 in progress bar (already completed)
  → activeStepIndex set to that step
  → WorkflowStepFormComponent renders in VIEW MODE (DisplayPropertyComponent)
       shows "Edit" button
  → workflow_status NOT changed (stays 'complete')

User clicks "Edit"
  → isViewMode = false
  → form renders with EditPropertyComponent, pre-filled
  → auto-save fires on changes (PATCH, workflow_status stays 'complete')
  → if user blanks a required field:
       editData(...) → PATCH → CHECK constraint fires → PATCH fails
       error displayed via saveError output
  → step zero edits: locked fields are read-only in the form (frontend hint matching the trigger)
```

---

## Frontend Components

### `WorkflowService`

`src/app/services/workflow.service.ts`

| Method | Returns | Notes |
|---|---|---|
| `getWorkflowDefinition(key)` | `Observable<WorkflowDefinition>` | combineLatest of both schema views; shareReplay per key |
| `getWorkflowProgress(key, parentId)` | `Observable<WorkflowProgressEntry[]>` | calls `get_workflow_progress` RPC; not cached |
| `startWorkflow(key)` | `Observable<ApiResponse>` | calls `start_workflow` RPC; returns new parent_id |
| `completeStep(key, parentId, stepKey)` | `Observable<ApiResponse>` | calls `complete_workflow_step` RPC |
| `submitWorkflow(key, parentId)` | `Observable<ApiResponse>` | calls `submit_workflow` RPC |
| `getEffectiveSteps(definition, parent, progress)` | `EffectiveWorkflowStep[]` | pure/sync — evaluates conditions and progress |
| `getLockedFields(definition)` | `Set<string>` | pure/sync — returns the union of all condition fields for the workflow |

`getEffectiveSteps` produces an array indexed `[step0, step1, ..., stepN, reviewStep]` where
the review step is synthesized client-side with a sentinel `step_key = '__review__'`.

### `WorkflowRunnerPage`

Route: `/workflow/:workflowKey/:parentId` (`:parentId` may be the literal `'new'`)
Guards: `[schemaVersionGuard, authGuard]`

If `parentId === 'new'`: call `startWorkflow`, then `router.navigate` to the resolved URL.

Otherwise load definition + parent + progress, compute effective steps (including synthetic
review step), seek to first incomplete step, render.

`advanceStep()` handles the auto-save→complete sequencing including debounce cancellation
and pendingSave wait.

### `WorkflowStepFormComponent`

Two render modes via `isViewMode` signal. Same as the previous design with one addition:

For step zero (parent table), the locked-field set from `getLockedFields()` is passed in. The
form marks those fields as read-only when `parent.workflow_status === 'complete'`. This is a
UX hint matching the DB trigger; the trigger remains the source of truth.

### `WorkflowReviewStepComponent` (new)

Rendered for the synthesized `__review__` step. Inputs: `definition`, `parentRecord`,
`completedSteps`. Loads each completed step's record in parallel, renders one collapsible
card per step using `DisplayPropertyComponent`. Provides:
- "Edit" link on each card → emits `editStep` output → parent navigates back
- "Submit Application" button → emits `submit` output → parent calls `submitWorkflow`

### `WorkflowProgressBarComponent`

DaisyUI 5 `steps steps-horizontal`. Shows non-skipped data steps + the review step at the end.
Step zero appears as the first step. Clicking a completed step emits its index for back-nav.
The review step is reachable only when all data steps are complete.

---

## Full Integrator Example

```sql
-- =========================================================
-- 1. Parent table (step zero)
-- =========================================================
CREATE TABLE public.permits (
    id                 SERIAL PRIMARY KEY,
    workflow_status    metadata.workflow_step_status,
    is_self_contractor BOOLEAN NOT NULL DEFAULT FALSE,
    project_type       VARCHAR(50),
    submitted_at       TIMESTAMPTZ,
    created_by         UUID NOT NULL DEFAULT current_user_id(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT permits_project_type_required
        CHECK (workflow_status = 'draft' OR project_type IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE ON public.permits TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.permits_id_seq TO authenticated;

ALTER TABLE public.permits ENABLE ROW LEVEL SECURITY;
CREATE POLICY permits_owner ON public.permits FOR ALL TO authenticated
    USING (created_by = current_user_id() OR is_admin());

-- =========================================================
-- 2. Step tables
-- =========================================================
CREATE TABLE public.permit_site_info (
    id              SERIAL PRIMARY KEY,
    permit_id       INT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    workflow_status metadata.workflow_step_status,
    street_address  VARCHAR(255),
    parcel_number   VARCHAR(50),
    project_description TEXT,

    CONSTRAINT site_info_address_required
        CHECK (workflow_status = 'draft' OR street_address IS NOT NULL),
    CONSTRAINT site_info_parcel_required
        CHECK (workflow_status = 'draft' OR parcel_number IS NOT NULL)
);
CREATE UNIQUE INDEX ON permit_site_info(permit_id);
-- (RLS via parent ownership)

CREATE TABLE public.permit_contractor_info (
    id              SERIAL PRIMARY KEY,
    permit_id       INT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    workflow_status metadata.workflow_step_status,
    company_name    VARCHAR(255),
    license_number  VARCHAR(50),

    CONSTRAINT contractor_company_required
        CHECK (workflow_status = 'draft' OR company_name IS NOT NULL)
);
CREATE UNIQUE INDEX ON permit_contractor_info(permit_id);

-- =========================================================
-- 3. Optional submission hook
-- =========================================================
CREATE FUNCTION public.submit_permit(p_parent_id TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    UPDATE permits SET submitted_at = NOW() WHERE id = p_parent_id::INT;
    -- Could also: enqueue notification job, transition status, etc.
    RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_permit TO authenticated;

-- =========================================================
-- 4. Register the workflow
-- =========================================================
SELECT register_workflow(
    'permit_application',
    'Permit Application',
    'permits',
    'Multi-step permit application',
    'submit_permit',                      -- on_submit_rpc
    '/view/permits/{id}',                 -- on_submit_navigate_to
    'Application Type',                   -- step zero display name
    'Please review your information before submitting.'
);

SELECT add_workflow_step('permit_application', 'site_info',
    'Site Information', 1, 'permit_site_info', 'permit_id');
SELECT add_workflow_step('permit_application', 'contractor_info',
    'Contractor Details', 2, 'permit_contractor_info', 'permit_id',
    'Skipped if owner is self-contracting', true);  -- can_skip = true

SELECT add_workflow_step_condition('permit_application', 'contractor_info',
    'skip_if', 'is_self_contractor', 'eq', 'true');

-- =========================================================
-- 5. Entry points
-- =========================================================
-- a) Direct link from a dashboard widget or list page:
--    /workflow/permit_application/new
--
-- b) "Continue Application" entity action on permits Detail page:
CREATE FUNCTION public.continue_permit(p_id INT) RETURNS JSONB LANGUAGE SQL AS $$
  SELECT jsonb_build_object('success', true,
    'navigate_to', '/workflow/permit_application/' || p_id::text);
$$;
GRANT EXECUTE ON FUNCTION public.continue_permit TO authenticated;

INSERT INTO metadata.entity_actions
    (table_name, action_name, display_name, rpc_function,
     button_style, show_on_detail, requires_confirmation)
VALUES ('permits', 'continue', 'Continue Application',
    'continue_permit', 'primary', true, false);
```

---

## What's Out of Scope for v1

| Feature | Notes |
|---|---|
| Convergent DAG branching | Steps with multiple predecessors / fan-in/fan-out; deferred to v2 |
| Visual track grouping in progress bar | `track_key` column reserved; UI grouping deferred |
| Compound conditions (AND/OR) | First matching condition wins; v2 |
| Admin workflow management UI | SQL-only configuration in v1 |
| Workflow abandonment/reset RPC | Admin DELETEs from `workflow_progress` directly |
| File / M:M fields in step forms | Same deferral as CreatePage |
| Per-step RBAC beyond table grants | Use RLS on step tables |
| Reopening a submitted workflow | Once submitted, the parent is read-only; no "unsubmit" |
| Step-to-step condition references | Conditions reference parent fields only |
| Multi-user editing of in-flight instance | RLS allows it; no concurrency UI |

---

## Open Questions / Things to Validate

- The lock trigger uses a dynamic SQL EXECUTE per locked field on every UPDATE. For a parent
  table with frequent edits, this could be slow. Worth benchmarking. Alternative: build a
  cached list of locked fields per parent table at trigger creation time.

- `start_workflow` uses `INSERT ... DEFAULT VALUES` which assumes the parent table can be
  created with all defaults. If a column is `NOT NULL` without a default, this fails. Should
  `start_workflow` accept an initial-values JSONB to populate required-at-create columns?

- The `on_submit_rpc` runs inside `submit_workflow`'s transaction. Long-running submission
  logic (e.g., file generation, external API calls) would hold the transaction open. Should
  we defer those to a worker via NOTIFY/LISTEN or River jobs?

- RLS policy on `workflow_progress.update` allows users to update their own entries. This is
  needed for `submit_workflow` to set `submitted_at`. Should that be locked down to only
  the `submit_workflow` RPC (via SECURITY DEFINER)?

- The lock trigger is created per parent table but the function is generic. What happens if
  two workflows share a parent table? The `metadata.workflow_step_conditions` lookup will
  union locked fields across all workflows on that parent — which is the correct behavior,
  but worth a test case.
