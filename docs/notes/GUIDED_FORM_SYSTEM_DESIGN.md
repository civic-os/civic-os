# Guided Form System Design

**Status**: Design — revised, implementation ready
**Version target**: TBD (next minor after 0.42.x)

## Overview

Civic OS needs a way to collect data across multiple ordered steps in a single cohesive
session — permit applications, grant submissions, onboarding flows. The existing system
handles individual entity CRUD well but has no concept of sequencing, partial completion,
step-level branching, or explicit final submission.

This document captures the design for a general-purpose multi-step guided form framework that
follows the same philosophy as statuses, validations, and categories: integrators define
PostgreSQL tables and register them in metadata; the framework generates the sequencing UI,
enforces step-level data integrity, and provides resumable session state.

**Key architectural decisions in this revision:**
- Workflows are **first-class entities** — the parent table is a standard Civic OS entity that
  appears in list views, receives FKs from other tables, and uses standard Detail/Edit pages.
- The **guided form runner** (`/workflow/:key/:id`) is a guided editor for active (in-progress)
  workflows only. Completed/submitted workflows are viewed and edited via standard Civic OS
  pages with a guided form navigation overlay.
- **`metadata.validations`** is the single source of truth for both frontend and backend
  validation. Conditional CHECK constraints are auto-generated from validation rules.
- **BIGINT-only** parent primary keys — framework convention, simplifies type system.
- **`submitted_at`** lives on the parent table (integrator-facing status), while
  `guided_form_progress` remains framework-internal.
- **Submission locking** is configurable per workflow (`lock_on_submit`). Default is editable
  post-submission.

---

## Design Goals

- **Auto-save (draft only)**: draft steps auto-save while the user is typing; completed steps
  require explicit manual save to modify
- **Resumable**: reload the page mid-workflow and land on the right step
- **Branching**: skip entire steps based on values set in step zero (the parent record)
- **DB-enforced validation**: `metadata.validations` drives both Angular validators (always
  active for UX guidance) and auto-generated PostgreSQL CHECK constraints (enforced only at
  step completion)
- **Lockable parent**: fields used in skip conditions become immutable once step zero completes,
  guaranteeing condition stability for the guided form's lifetime
- **Revisitable**: completed steps can be viewed and re-edited. Constraints are armed but
  manual-save-only prevents accidental modification
- **Explicit submission**: users explicitly submit the guided form via a synthesized review step
- **Configurable immutability**: `lock_on_submit` controls whether submitted workflows become
  read-only or remain editable as standard entities
- **RLS-native access control**: single-owner by default; M:M ownership table can be added
  without framework changes
- **Framework-native validation**: integrators define validations in `metadata.validations`;
  the framework generates conditional CHECK constraints automatically

---

## Core Concepts

### Parent-as-step-zero

The parent record is **step 0 of the guided form**, not a separate concept. The parent table
participates in the same `guided_form_status` mechanism as the step tables. The framework treats
the parent as the first step the user fills out, then proceeds through integrator-defined
steps that reference the parent via FK.

This unification has three big benefits:
1. The user enters the guided form runner immediately — no separate "create the parent" UX moment
2. Fields that drive skip conditions are set in step zero, where they're naturally collected
3. Once step zero is `'complete'`, the framework locks condition fields → branching is stable
   for the entire workflow lifetime

### Step entities

Each subsequent step has its own table (e.g., `permit_site_info`, `permit_owner_info`) with an
FK back to the parent. The relationship is 1:1 per instance — one parent → at most one record
per step table.

### Guided form definition

Registered in metadata via SQL helper functions. Describes the ordered steps, optional skip
conditions, and what happens when the guided form is finally submitted.

### Progress tracking (hybrid)

> **Implementation note**: The `guided_form_step_status` domain described below was replaced
> during implementation with a unified `status_id INTEGER` FK to `metadata.statuses`. The
> actual implementation uses `is_guided_form_draft(status_id)` helper in CHECK constraints
> instead of the domain-based approach. The dual-column design was simplified to a single
> `status_id` column per table.

Two complementary mechanisms:

1. ~~**`guided_form_step_status` domain column**~~ **`status_id` FK column** on every participating
   table (parent + step tables). References `metadata.statuses` with `entity_type = 'guided_form'`.
   CHECK constraints use `is_guided_form_draft(status_id)` helper function.

2. **`metadata.guided_form_progress` table** — denormalized completion log written atomically
   alongside the step status UPDATE. Enables O(1) resume queries without querying N step tables.

### Status tracking

The parent table uses a single `status_id` column (FK to `metadata.statuses`) for both
framework state and user-facing display:

- **`status_id`** (FK to `metadata.statuses`) — user-facing Civic OS Status. Renders as
  colored badges on list/detail pages, supports FilterBar filtering and column sorting.
  Uses the shared `'guided_form'` entity type with three values: Draft (`#f59e0b`),
  Complete (`#22c55e`), Submitted (`#3b82f6`). Also drives conditional CHECK constraints
  via `is_guided_form_draft(status_id)` helper function.

Sync points:
- `register_guided_form()` adds `status_id` column with `DEFAULT get_initial_status('guided_form')`
- `complete_guided_form_step()` sets status to `'complete'` when all steps are done, or
  back to `'draft'` when they aren't
- `submit_guided_form()` sets status to `'submitted'` atomically with `submitted_at`

This dual approach lets the database enforce data integrity via domain-typed CHECK constraints
while giving users the full Status system UX (filtering, badges, sorting) via the FK column.

### Synthesized review step

After all data steps are complete, the runner shows a framework-generated review screen —
collapsible cards summarizing each step. The user explicitly clicks "Submit Application" to
finalize. This is the only point at which `on_submit_rpc` fires.

### Guided form navigation overlay

When viewing or editing any workflow entity (parent or step) via standard Civic OS pages
(`/view/:entity/:id` or `/edit/:entity/:id`), a guided form navigation component renders at the
top of the page. It shows the step progress bar and allows free navigation between steps.

This replaces the "Related Entities" inverse relationship cards for 1:1 guided form steps,
since those steps are semantically part of the same entity. Other unrelated inverse
relationships still render normally below the nav.

The guided form runner (`/workflow/:key/:id`) is reserved for the **guided active experience** —
sequence enforcement, "Save & Continue", and the review step. Once a guided form is complete,
the canonical view is the standard Detail page with the guided form nav overlay.

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

- **`guided_form_status` column** enables conditional CHECK constraints. Source of truth for
  step-level data integrity.
- **`metadata.guided_form_progress` table** is a denormalized index of completions. Single query
  on page load returns all completed step keys for an instance.

The two are kept consistent because `complete_guided_form_step` writes both in one transaction.

### Why `metadata` schema for `guided_form_progress`?

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
   (before the guided form runs), or conditions evaluate against missing data. And once the
   workflow is running, normal Edit page access could change those fields out from under it.

Parent-as-step-zero collapses both problems: the parent's data is collected as the first step
of the guided form, and once that step completes, the framework locks the fields used in
conditions via a BEFORE UPDATE trigger.

---

## Status Model

Three distinct concepts track guided form state at different granularities:

| Concept | Where tracked | Lifecycle |
|---------|---------------|-----------|
| Step completion | `guided_form_progress` row | Row exists = step done |
| Step data status | `status_id` on step 1-N tables | `draft → complete` |
| Form lifecycle | `status_id` on parent row | `draft → complete → submitted` (forward-only) |

### Key principle: parent `status_id` only advances forward

The parent row's `status_id` is the **form lifecycle status**, not step zero's data status.
Step zero's completion is recorded in `guided_form_progress`, the same as every other step.

- `complete_guided_form_step()` does NOT update the parent's `status_id` when completing step
  zero. It only writes a `guided_form_progress` entry.
- Steps 1-N DO get a step-level `status_id = 'complete'` update on their own table (which is
  a different table from the parent).
- The parent's `status_id` advances to `complete` only when `_check_guided_form_complete()`
  returns TRUE (all required steps done). It never reverts from `complete` back to `draft`.
- The `enforce_guided_form_lock` trigger enforces this: `complete → draft` is blocked;
  `complete → submitted` is allowed (for `submit_guided_form` / auto-submit).

### Why step zero is different

For steps 1-N, the "step data status" and "form lifecycle status" live on different tables, so
both writes in `complete_guided_form_step` target different rows (no conflict). For step zero,
the step table IS the parent table — writing both would cause two conflicting updates to the
same row's `status_id` in one transaction (first to `complete`, then back to `draft`), which
the lock trigger rightfully blocks.

### Draft-first edit flow (steps 1-N)

Step records for steps 1-N are created as **draft rows** via `ensure_guided_form_step_record()`
before the user ever sees the edit form. This RPC is idempotent — if a record already exists,
it returns the existing ID.

**Why**: The Create page lacks guided form infrastructure (nav bar, auto-save, step completion
tracking). By auto-creating a draft row and routing to `/edit/{stepTable}/{draftId}`, all step
editing happens on the Edit page where the full guided form experience is available.

**How it works**:
1. Frontend calls `ensure_guided_form_step_record(guided_form_key, parent_id, step_key)`
2. RPC looks up the step table and FK column from `guided_form_steps`
3. If a record with that FK already exists → returns `{record_id, created: false}`
4. Otherwise → `INSERT INTO {step_table} ({fk_col}) VALUES (parent_id)` → returns `{record_id, created: true}`
5. `status_id` auto-populates via DEFAULT (`get_initial_status('guided_form')` = draft)
6. `display_name` auto-populates via BEFORE INSERT trigger (if configured on the step table)
7. Frontend navigates to `/edit/{step_table}/{record_id}`

**Parent ID resolution**: When the Edit page hosts a child step record, `data.id` is the
child's ID, not the parent's. The `guidedFormParentId` signal resolves the correct parent ID
by extracting it from the FK column value in the loaded data. All progress tracking, step
completion, and navigation uses this resolved parent ID.

---

## Database Schema

### Status tracking via `status_id` FK

> **Implementation divergence**: The original design proposed a `guided_form_step_status` custom
> domain. The actual implementation uses `status_id INTEGER REFERENCES metadata.statuses(id)`
> instead, leveraging the existing Civic OS Status system for colored badges, filtering, and
> lifecycle tracking. The `is_guided_form_draft(status_id)` helper function is used in CHECK
> constraints where the domain was originally planned.

### `metadata.guided_forms`

```sql
CREATE TABLE metadata.guided_forms (
    guided_form_key      NAME PRIMARY KEY,
    display_name      VARCHAR(100) NOT NULL,
    description       TEXT,
    parent_table      NAME NOT NULL,
    on_submit_rpc     NAME,                            -- called by submit_guided_form; may return navigate_to
    review_intro_text TEXT,                            -- markdown shown above review cards
    lock_on_submit    BOOLEAN NOT NULL DEFAULT FALSE,  -- if TRUE, submitted workflows are read-only
    precondition_rpc  NAME,                            -- called by start_guided_form before INSERT
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    auto_submit_on_all_skipped BOOLEAN NOT NULL DEFAULT FALSE,  -- if TRUE, auto-submit when all data steps are condition-skipped
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`lock_on_submit`: when TRUE, `submit_guided_form` creates a trigger that prevents further edits
to the parent and step tables. When FALSE (default), the guided form remains a fully editable
entity after submission.

`auto_submit_on_all_skipped`: when TRUE and all non-parent data steps are condition-skipped
(via `skip_if`), `complete_guided_form_step()` auto-calls `submit_guided_form()` internally.
The response includes `auto_submitted: true` so the frontend can navigate directly using the
`navigate_to` from `on_submit_rpc`. This avoids forcing users through review when there's
nothing to review. Business logic stays in `on_submit_rpc`. Default FALSE.

`precondition_rpc`: optional integrator hook called by `start_guided_form` before creating the
parent record. Use case: verify the user has an approved borrower profile before starting a
tool reservation. Signature: `(p_guided_form_key NAME) RETURNS JSONB`.

### `metadata.guided_form_steps`

```sql
CREATE TABLE metadata.guided_form_steps (
    id                SERIAL PRIMARY KEY,
    guided_form_key      NAME NOT NULL REFERENCES metadata.guided_forms ON DELETE CASCADE,
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

    UNIQUE (guided_form_key, step_key),
    UNIQUE (guided_form_key, step_order)
);
```

Step zero is registered automatically by `register_guided_form()` with `step_key = '__parent__'`,
`step_table = parent_table`, `parent_fk_column = NULL`, `step_order = 0`.

### `metadata.guided_form_step_conditions`

Conditions reference parent record fields (locked once step zero completes).

```sql
CREATE TABLE metadata.guided_form_step_conditions (
    id                SERIAL PRIMARY KEY,
    guided_form_step_id  INT NOT NULL REFERENCES metadata.guided_form_steps ON DELETE CASCADE,
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

### `metadata.guided_form_progress`

```sql
CREATE TABLE metadata.guided_form_progress (
    id              BIGSERIAL PRIMARY KEY,
    guided_form_key    NAME NOT NULL,
    parent_id       BIGINT NOT NULL,                   -- BIGINT framework convention
    step_key        NAME NOT NULL,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_by    UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,
    submitted_at    TIMESTAMPTZ,                       -- set by submit_guided_form on the '__parent__' row
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (guided_form_key, parent_id, step_key)
);

CREATE INDEX ON metadata.guided_form_progress (guided_form_key, parent_id);
CREATE INDEX ON metadata.guided_form_progress (completed_by);

ALTER TABLE metadata.guided_form_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY guided_form_progress_select ON metadata.guided_form_progress
    FOR SELECT TO authenticated
    USING (completed_by = current_user_id() OR is_admin());

CREATE POLICY guided_form_progress_insert ON metadata.guided_form_progress
    FOR INSERT TO authenticated
    WITH CHECK (completed_by = current_user_id());

CREATE POLICY guided_form_progress_update ON metadata.guided_form_progress
    FOR UPDATE TO authenticated
    USING (completed_by = current_user_id() OR is_admin());
```

`parent_id` uses `BIGINT` to match the framework convention that all workflow parent tables
use `BIGSERIAL` primary keys. This eliminates the need for `parent_pk_type` and dynamic casting
in RPCs.

`submitted_at` is stored on the `__parent__` row after `submit_guided_form` runs. The frontend
can detect "this guided form is fully submitted" by checking `parent.submitted_at IS NOT NULL`.
Integrators can filter and report on submission status without joining the framework-internal
`guided_form_progress` table.

### Parent table requirements

The parent table must:
1. Use `BIGSERIAL PRIMARY KEY` (framework convention)
2. Have a `guided_form_status` column typed as `guided_form_step_status`
3. Have a `submitted_at TIMESTAMPTZ` column (nullable, set by `submit_guided_form`)
4. Have all content columns nullable (enforcement via CHECK constraints, not `NOT NULL`)

```sql
CREATE TABLE public.permits (
    id              BIGSERIAL PRIMARY KEY,
    guided_form_status public.guided_form_step_status,
    submitted_at    TIMESTAMPTZ,                     -- set on submission
    is_self_contractor BOOLEAN NOT NULL DEFAULT FALSE, -- example field driving skip condition
    -- ...other parent fields (all nullable)
    created_by      UUID NOT NULL DEFAULT current_user_id(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The framework enforces (at registration time): the parent table must have a column of type
`guided_form_step_status` and must use a `BIGINT` (or `BIGSERIAL`) primary key. If either is
missing, `register_guided_form` raises an exception.

### Step table requirements

Same convention; uses the domain for the status column. All content columns must be nullable.

```sql
CREATE TABLE public.permit_site_info (
    id              BIGSERIAL PRIMARY KEY,
    permit_id       BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    guided_form_status public.guided_form_step_status,
    street_address  VARCHAR(255),
    parcel_number   VARCHAR(50),
    project_description TEXT
);
CREATE UNIQUE INDEX ON permit_site_info(permit_id);
```

The 1:1 with parent is enforced by the unique index on `parent_fk_column`.

**Note:** Integrators do NOT write conditional CHECK constraints by hand. They define
validations in `metadata.validations`, and the framework auto-generates CHECK constraints
via `metadata.rebuild_guided_form_constraints()` (see below).

### Auto-generated CHECK constraints from `metadata.validations`

`metadata.validations` is the single source of truth for workflow validation. The framework
reads validation rules and generates conditional CHECK constraints:

| `validation_type` | Auto-generated CHECK constraint |
|---|---|
| `required` | `CHECK (guided_form_status = 'draft' OR {col} IS NOT NULL)` |
| `min` | `CHECK (guided_form_status = 'draft' OR {col} >= {value}::numeric)` |
| `max` | `CHECK (guided_form_status = 'draft' OR {col} <= {value}::numeric)` |
| `minLength` | `CHECK (guided_form_status = 'draft' OR LENGTH({col}::text) >= {value}::int)` |
| `maxLength` | `CHECK (guided_form_status = 'draft' OR LENGTH({col}::text) <= {value}::int)` |
| `pattern` | `CHECK (guided_form_status = 'draft' OR {col}::text ~ '{regex}')` |

Auto-generated constraints are named: `{table}_{column}_{type}_wfcheck`.
This naming convention allows `rebuild_guided_form_constraints()` to identify and drop stale
constraints without touching manually-created CHECK constraints.

### `metadata.rebuild_guided_form_constraints()`

Idempotent function that synchronizes a guided form step table's CHECK constraints with its
`metadata.validations` entries.

```sql
CREATE OR REPLACE FUNCTION metadata.rebuild_guided_form_constraints(p_table_name NAME)
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_validation RECORD;
    v_constraint_name NAME;
    v_constraint_sql TEXT;
    v_dropped INT := 0;
    v_created INT := 0;
    v_not_valid INT := 0;
    v_has_rows BOOLEAN;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = p_table_name AND column_name = 'guided_form_status'
    ) THEN
        RAISE EXCEPTION 'Table % does not have guided_form_status', p_table_name;
    END IF;

    SELECT EXISTS(SELECT 1 FROM pg_class WHERE relname = p_table_name AND reltuples > 0)
    INTO v_has_rows;

    -- Drop stale auto-generated constraints
    FOR v_constraint_name IN
        SELECT con.conname FROM pg_constraint con
        JOIN pg_class cls ON cls.oid = con.conrelid
        WHERE cls.relname = p_table_name AND con.contype = 'c'
          AND con.conname ~ ('^' || p_table_name || '_.*_wfcheck$')
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', p_table_name, v_constraint_name);
        v_dropped := v_dropped + 1;
    END LOOP;

    -- Recreate from metadata.validations
    FOR v_validation IN
        SELECT v.column_name, v.validation_type, v.validation_value, v.error_message
        FROM metadata.validations v
        WHERE v.table_name = p_table_name
        ORDER BY v.sort_order
    LOOP
        v_constraint_name := format('%s_%s_%s_wfcheck',
            p_table_name, v_validation.column_name, v_validation.validation_type);

        CASE v_validation.validation_type
            WHEN 'required' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (guided_form_status = ''draft'' OR %I IS NOT NULL)',
                    p_table_name, v_constraint_name, v_validation.column_name);
            WHEN 'min' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (guided_form_status = ''draft'' OR %I >= %L::numeric)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'max' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (guided_form_status = ''draft'' OR %I <= %L::numeric)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'minLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (guided_form_status = ''draft'' OR LENGTH(%I::text) >= %L::int)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'maxLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (guided_form_status = ''draft'' OR LENGTH(%I::text) <= %L::int)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'pattern' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (guided_form_status = ''draft'' OR %I::text ~ %L)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            ELSE
                CONTINUE;
        END CASE;

        IF v_has_rows THEN
            v_constraint_sql := v_constraint_sql || ' NOT VALID';
            v_not_valid := v_not_valid + 1;
        END IF;

        BEGIN
            EXECUTE v_constraint_sql;
            v_created := v_created + 1;

            INSERT INTO metadata.constraint_messages
                (constraint_name, table_name, column_name, error_message)
            VALUES (v_constraint_name, p_table_name, v_validation.column_name, v_validation.error_message)
            ON CONFLICT (constraint_name) DO UPDATE SET
                error_message = EXCLUDED.error_message,
                updated_at = NOW();

            IF v_has_rows THEN
                BEGIN
                    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', p_table_name, v_constraint_name);
                EXCEPTION WHEN check_violation THEN
                    RETURN QUERY SELECT 'WARNING'::TEXT,
                        format('Constraint %s on %s could not be validated against existing rows (grandfathered)',
                               v_constraint_name, p_table_name);
                END;
            END IF;
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END LOOP;

    RETURN QUERY SELECT 'SUMMARY'::TEXT,
        format('Dropped %s, Created %s (%s NOT VALID) constraints for %s',
               v_dropped, v_created, v_not_valid, p_table_name);
END;
$$;
```

**`NOT VALID` strategy:** When a table has existing rows, new constraints are added with
`NOT VALID` to avoid failing on grandfathered data. A background `VALIDATE CONSTRAINT` is
attempted; if existing rows violate the new constraint, the constraint remains unvalidated
but still enforces on new/changed rows.

### Trigger on `metadata.validations`

A statement-level trigger automatically rebuilds workflow constraints whenever validation
rules change:

```sql
CREATE OR REPLACE FUNCTION metadata.on_validation_change_rebuild()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_table_name NAME;
BEGIN
    FOR v_table_name IN
        SELECT DISTINCT table_name FROM (
            SELECT table_name FROM new_table
            UNION
            SELECT table_name FROM old_table
        ) touched
        WHERE EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = touched.table_name AND column_name = 'guided_form_status'
        )
    LOOP
        PERFORM metadata.rebuild_guided_form_constraints(v_table_name);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER validation_change_rebuild_guided_form_constraints
AFTER INSERT OR UPDATE OR DELETE ON metadata.validations
REFERENCING NEW TABLE AS new_table OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION metadata.on_validation_change_rebuild();
```

### Lock triggers

Two distinct lock mechanisms:

**1. Condition field lock (always created)**

Prevents modification to fields used in skip/require conditions once step zero completes.

```sql
CREATE OR REPLACE FUNCTION metadata.enforce_guided_form_lock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_locked_field NAME;
BEGIN
    IF public.is_admin() THEN RETURN NEW; END IF;
    IF OLD.guided_form_status != 'complete' THEN RETURN NEW; END IF;
    IF NEW.guided_form_status != 'complete' THEN
        RAISE EXCEPTION 'Cannot revert guided_form_status from complete to draft on %', TG_TABLE_NAME;
    END IF;
    FOR v_locked_field IN
        SELECT DISTINCT wsc.field
        FROM metadata.guided_forms w
        JOIN metadata.guided_form_steps ws ON ws.guided_form_key = w.guided_form_key
        JOIN metadata.guided_form_step_conditions wsc ON wsc.guided_form_step_id = ws.id
        WHERE w.parent_table = TG_TABLE_NAME
    LOOP
        EXECUTE format('SELECT ($1).%I IS DISTINCT FROM ($2).%I',
            v_locked_field, v_locked_field)
        INTO STRICT v_locked_field USING OLD, NEW;
        IF v_locked_field = 'true' THEN
            RAISE EXCEPTION 'Field % is locked while workflow is complete', v_locked_field
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
```

**2. Submitted workflow lock (conditional on `lock_on_submit`)**

When `lock_on_submit = TRUE`, `submit_guided_form` creates a trigger that blocks all updates
to the parent and step tables after submission:

```sql
CREATE OR REPLACE FUNCTION metadata.block_submitted_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.submitted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Guided form has been submitted and is locked';
    END IF;
    RETURN NEW;
END;
$$;
```

This trigger is created dynamically per workflow parent table when `lock_on_submit = TRUE`.
Step tables inherit the lock indirectly: since their parent FK uses `ON DELETE CASCADE`,
updates to step records are allowed only if the parent is not submitted.

---

## RLS & Access Control

The guided form system uses a two-tier RLS model, auto-configured by `register_guided_form()`
and `add_guided_form_step()`. See `docs/development/PERMISSIONS_MODEL.md` for the broader
Civic OS RBAC architecture.

### Parent table (7 policies)

**Tier 1 — Ownership** (3 policies):
- `gf_owner_select` — Owner can SELECT their own rows via `ownership_column = current_user_id()`
- `gf_owner_update` — Owner can UPDATE their own rows
- `gf_owner_delete` — Owner can DELETE their own rows

**Insert** (1 policy):
- `gf_insert` — Any authenticated user can INSERT (start a new guided form)

**Tier 2 — RBAC** (3 policies):
- `gf_rbac_select` — Blanket read access via `has_permission(table, 'read')`
- `gf_rbac_update` — Blanket update access via `has_permission(table, 'update')`
- `gf_rbac_delete` — Blanket delete access via `has_permission(table, 'delete')`

PostgreSQL ORs permissive policies: a user sees a row if *any* matching policy returns TRUE.
Owners always see their own records; RBAC-granted roles see all records.

### Child table (8 policies)

**Tier 1 — Ownership delegation** (4 policies):
Child ownership is verified by joining back to the parent table through the FK column.
For example: `EXISTS (SELECT 1 FROM parent WHERE id = child.parent_fk AND owner = current_user_id())`.

- `gf_child_owner_select`, `gf_child_owner_insert`, `gf_child_owner_update`, `gf_child_owner_delete`

**Tier 2 — RBAC** (4 policies):
Uses the **parent table's** permission key for consistency — granting `update` on `permits`
also allows editing `permit_site_info`.

- `gf_child_rbac_select`, `gf_child_rbac_insert`, `gf_child_rbac_update`, `gf_child_rbac_delete`

### Typical grants

| Role | Permissions | Effect |
|---|---|---|
| `user` | `read`, `create` | See all rows + start new guided forms |
| `editor` | `read`, `create`, `update` | Above + edit any record |
| `manager` | All | Full CRUD on all records |
| `admin` | (implicit) | Bypasses RLS via `is_admin()` |

Owners always have SELECT + UPDATE + DELETE on their own records regardless of RBAC grants.

### PostgREST views

```sql
-- Guided form definitions
CREATE VIEW public.schema_guided_forms AS
SELECT guided_form_key, display_name, description, parent_table, lock_on_submit,
       on_submit_rpc, review_intro_text, precondition_rpc, is_enabled
FROM metadata.guided_forms
WHERE is_enabled = TRUE;
ALTER VIEW public.schema_guided_forms SET (security_invoker = true);
GRANT SELECT ON public.schema_guided_forms TO web_anon, authenticated;

-- Steps with conditions embedded as JSONB
CREATE VIEW public.schema_guided_form_steps AS
SELECT
    ws.id, ws.guided_form_key, ws.step_key, ws.display_name, ws.description,
    ws.step_table, ws.parent_fk_column, ws.step_order, ws.can_skip, ws.track_key,
    COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object('id', c.id, 'condition_type', c.condition_type,
                               'field', c.field, 'operator', c.operator, 'value', c.value)
            ORDER BY c.sort_order
         ) FROM metadata.guided_form_step_conditions c WHERE c.guided_form_step_id = ws.id),
        '[]'::jsonb
    ) AS conditions
FROM metadata.guided_form_steps ws
ORDER BY ws.guided_form_key, ws.step_order;
ALTER VIEW public.schema_guided_form_steps SET (security_invoker = true);
GRANT SELECT ON public.schema_guided_form_steps TO web_anon, authenticated;

-- Progress (thin view over metadata table)
CREATE VIEW public.guided_form_progress AS
SELECT id, guided_form_key, parent_id, step_key, completed_at,
       completed_by, submitted_at, created_at
FROM metadata.guided_form_progress;
GRANT SELECT, INSERT, UPDATE ON public.guided_form_progress TO authenticated;
```

---

## Helper RPCs

### Registration helpers

`register_guided_form()` inserts metadata rows and validates the parent table:
1. Validates the parent table exists and has a `guided_form_step_status` column
2. Validates the parent table uses `BIGINT` (or `BIGSERIAL`) primary key
3. Inserts the guided form row
4. Inserts the auto-step-zero row in `metadata.guided_form_steps` (`step_key='__parent__'`)
5. If `lock_on_submit = TRUE`, creates the submitted-workflow lock trigger on the parent table

```sql
SELECT register_guided_form(
    p_guided_form_key   := 'permit_application',
    p_display_name   := 'Permit Application',
    p_parent_table   := 'permits',
    p_description    := 'Multi-step building permit application',
    p_on_submit_rpc  := 'submit_permit',
    p_parent_step_display_name := 'Application Type',
    p_review_intro_text := 'Please review your information before submitting.',
    p_lock_on_submit := FALSE
);

SELECT add_guided_form_step('permit_application', 'site_info',
    'Site Information', 1, 'permit_site_info', 'permit_id');

SELECT add_guided_form_step_condition('permit_application', 'contractor_info',
    'skip_if', 'is_self_contractor', 'eq', 'true');
```

### `complete_guided_form_step` (called from frontend)

Atomic two-write RPC. `SECURITY INVOKER` (default) — RLS on the step table determines whether
the user can update the row.

Logic:
1. Look up `step_table`, `parent_fk_column` from `metadata.guided_form_steps`
2. Branch:
   - If `parent_fk_column IS NULL` (step zero): `UPDATE {parent_table} WHERE id = parent_id`
   - Otherwise: `UPDATE {step_table} WHERE {parent_fk_column} = parent_id`
3. CHECK constraints (and the lock trigger for step zero) fire here; violation rolls back
4. `INSERT INTO metadata.guided_form_progress ON CONFLICT DO NOTHING`
5. Returns `{success: true, all_data_steps_complete: <bool>}`
6. `EXCEPTION WHEN check_violation THEN` → `{success: false, message: SQLERRM, sqlstate: '23514'}`

### `submit_guided_form` (called from review step)

```sql
CREATE FUNCTION public.submit_guided_form(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_workflow      metadata.guided_forms%ROWTYPE;
    v_result        JSONB;
BEGIN
    SELECT * INTO v_workflow FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown workflow');
    END IF;

    IF NOT public._check_guided_form_complete(p_guided_form_key, p_parent_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Guided form has incomplete required steps');
    END IF;

    -- Call on_submit_rpc BEFORE locking so it can modify the parent record.
    -- If it fails, the transaction rolls back and the guided form remains unsubmitted.
    IF v_workflow.on_submit_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_workflow.on_submit_rpc)
            INTO v_result USING p_parent_id;
        IF v_result IS NOT NULL AND (v_result->>'success')::boolean = false THEN
            RAISE EXCEPTION '%', v_result->>'message';
        END IF;
    END IF;

    -- Mark parent as submitted (triggers block_submitted_update lock)
    EXECUTE format('UPDATE public.%I SET submitted_at = NOW() WHERE id = $1',
        v_workflow.parent_table) USING p_parent_id;

    -- Mark progress as submitted (framework-internal)
    UPDATE metadata.guided_form_progress
       SET submitted_at = NOW()
     WHERE guided_form_key = p_guided_form_key
       AND parent_id    = p_parent_id
       AND step_key     = '__parent__';

    -- Forward navigate_to from on_submit_rpc if it provided one.
    RETURN jsonb_build_object(
        'success', true,
        'navigate_to', COALESCE(v_result->>'navigate_to', '')
    );
END;
$$;
```

### `cancel_guided_form` (called from runner or entity action)

```sql
CREATE FUNCTION public.cancel_guided_form(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_workflow metadata.guided_forms%ROWTYPE;
BEGIN
    SELECT * INTO v_workflow FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown workflow');
    END IF;

    -- Delete progress entries (cascades to nothing else)
    DELETE FROM metadata.guided_form_progress
    WHERE guided_form_key = p_guided_form_key AND parent_id = p_parent_id;

    -- Delete parent record (cascades to all step records via ON DELETE CASCADE)
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_workflow.parent_table)
    USING p_parent_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
```

### `get_guided_form_progress` (called on page load)

```sql
SELECT step_key, completed_at, completed_by, submitted_at
FROM metadata.guided_form_progress
WHERE guided_form_key = p_guided_form_key
  AND parent_id = p_parent_id
  AND (completed_by = current_user_id() OR is_admin());
```

### `start_guided_form` (called from /workflow/:key/new)

```sql
CREATE FUNCTION public.start_guided_form(p_guided_form_key NAME)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_workflow metadata.guided_forms%ROWTYPE;
    v_new_id   BIGINT;
BEGIN
    SELECT * INTO v_workflow FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND OR NOT v_workflow.is_enabled THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown or disabled workflow');
    END IF;

    -- Optional precondition check
    IF v_workflow.precondition_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_workflow.precondition_rpc)
        INTO v_result USING p_guided_form_key;
        IF v_result IS NOT NULL AND (v_result->>'success')::boolean = false THEN
            RETURN v_result;
        END IF;
    END IF;

    EXECUTE format(
        'INSERT INTO public.%I DEFAULT VALUES RETURNING id',
        v_workflow.parent_table
    ) INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'parent_id', v_new_id,
        'navigate_to', '/workflow/' || p_guided_form_key || '/' || v_new_id::text
    );
END;
$$;
```

---

## Routes

### Guided runner (active workflows only)

| Route | Purpose |
|---|---|
| `/workflow/:guidedFormKey/new` | Creates parent record via `start_guided_form`, redirects to runner |
| `/workflow/:guidedFormKey/:parentId` | Loads existing in-progress instance, resumes at first incomplete step |

Both protected by `[schemaVersionGuard, authGuard]`.

### Standard CRUD with guided form nav overlay

| Route | Behavior |
|---|---|
| `/view/:entityKey/:entityId` | If entity is workflow parent or step, renders Detail page with guided form nav |
| `/edit/:entityKey/:entityId` | If entity is workflow parent or step, renders Edit page with guided form nav |

No special routes needed. The guided form nav is a conditional overlay based on
`entity.guided_form_key`.

---

## Data Flow

### State machine for a single step

```
Not started:   no row in step_table WHERE parent_fk = parent_id
               no entry in guided_form_progress

In progress:   row EXISTS (guided_form_status = 'draft')
               no entry in guided_form_progress

Completed:     row EXISTS (guided_form_status = 'complete')
               entry EXISTS in guided_form_progress

Submitted:     parent.submitted_at IS NOT NULL
```

### New workflow entry

```
User clicks "Start New Permit" link
  → navigate /workflow/permit_application/new
  → GuidedFormRunnerPage detects 'new', calls start_guided_form RPC
  → backend INSERT INTO permits DEFAULT VALUES (guided_form_status='draft' from domain)
  → backend returns { parent_id: 42, navigate_to: '/workflow/permit_application/42' }
  → router.navigate(navigate_to) → reload as resume
```

### Resume (page load) — runner

```
/workflow/permit_application/42
  → combineLatest([
      GET /schema_guided_forms?guided_form_key=eq.permit_application,
      GET /schema_guided_form_steps?guided_form_key=eq.permit_application,
      callRpc('get_guided_form_progress', { guided_form_key, parent_id: 42 })
    ])
  → fetch parent record: GET /permits?id=eq.42
  → if parent.submitted_at IS NOT NULL → workflow already submitted
       → if lock_on_submit: show "submitted" message
       → else: redirect to standard Detail page /view/permits/42
  → getEffectiveSteps(definition, parentRecord, progress)
       evaluates skip_if/require_if against parent record
       marks completed steps from progress entries
  → seekToCurrentStep(): first non-completed, non-skipped step
       (step zero counts as a step here)
  → render
```

### Resume (page load) — standard pages with guided form nav

```
/view/tool_reservations/42
  → DetailPage loads entity metadata
  → entity.guided_form_key = 'tool_reservation' detected
  → renders <app-workflow-nav [guidedFormKey]="'tool_reservation'" [parentId]="42">
  → nav loads schema_guided_form_steps + guided_form_progress
  → resolves step record IDs for each step
  → highlights parent step (step 0) as current
  → standard Detail properties render below nav
```

### Step record lifecycle

```
User navigates to a data step (1–N) in runner
  → GuidedFormStepFormComponent loads
  → GET /reservation_parcels?reservation_id=eq.42
  → if no record:
       POST /reservation_parcels { reservation_id: 42 }
       (creates minimal row; guided_form_status='draft' from domain default)
       sets existingRecordId signal → M:M editor activates immediately
  → if record exists: sets existingRecordId from response
  → form + M:M editors are now live
```

### Auto-save (draft steps only)

```
User types in form fields
  → 1500ms debounce
  → PATCH /{step_table}?id=eq.{stepRecordId} with { ...changedFieldsOnly }
       PATCH never touches guided_form_status
  → step stays 'draft'; no guided_form_progress entry written

M:M changes (checkboxes) save immediately — POST/DELETE to junction table.
No debounce needed; each click is an atomic add/remove.
```

### Manual save (completed steps in runner)

```
User clicks "Edit" on a completed step
  → form renders in edit mode
  → NO auto-save; local changes only
  → user clicks "Save Changes"
  → PATCH all changed fields at once
  → CHECK constraints fire (guided_form_status = 'complete')
  → on success: return to view mode
  → on failure: show error, stay in edit mode
  → "Cancel" discards local changes
```

### Step completion ("Save & Continue")

```
User clicks "Save & Continue"
  → GuidedFormRunnerPage.advanceStep()
  → cancel pending debounced auto-save
  → await any in-flight save (pendingSave$ signal)
  → force synchronous save of current form values (firstValueFrom)
  → executeRpc('complete_guided_form_step', { guided_form_key, parent_id, step_key })
       BEGIN TRANSACTION
         UPDATE step_table SET guided_form_status = 'complete' WHERE pk = parent_id
           -- CHECK constraints enforce required fields
           -- check_violation → ROLLBACK → {success: false, message: SQLERRM}
         INSERT INTO metadata.guided_form_progress ON CONFLICT DO NOTHING
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
  → GuidedFormRunnerPage renders GuidedFormReviewStepComponent
       loads each completed step's record (parallel GET)
       renders each as a collapsible card via DisplayPropertyComponent
       cards have "Edit" button that navigates back to that step in edit mode
       review_intro_text rendered as markdown above the cards
       big "Submit Application" button at the bottom

User clicks "Submit Application"
  → executeRpc('submit_guided_form', { guided_form_key, parent_id })
       BEGIN TRANSACTION
         re-validate all_data_steps_complete (defense against direct API)
         UPDATE parent_table SET submitted_at = NOW() WHERE id = parent_id
         UPDATE guided_form_progress SET submitted_at = NOW() WHERE step_key = '__parent__'
         if on_submit_rpc configured: EXECUTE it; failure → ROLLBACK
       COMMIT
       → {success: true, navigate_to: '/view/permits/42'}
  → router.navigate(result.navigate_to)
```

### Back-navigation to a completed step

```
User clicks step 1 in progress bar (already completed)
  → activeStepIndex set to that step
  → GuidedFormStepFormComponent renders in VIEW MODE (DisplayPropertyComponent)
       shows "Edit" button
  → guided_form_status NOT changed (stays 'complete')

User clicks "Edit"
  → isViewMode = false
  → form renders with EditPropertyComponent, pre-filled
  → NO auto-save; manual save only
  → "Save Changes" PATCHes all changes; CHECK constraints fire
  → "Cancel" discards local changes
```

---

## Frontend Components

### `GuidedFormService`

`src/app/services/workflow.service.ts`

| Method | Returns | Notes |
|---|---|---|
| `getGuidedFormDefinition(key)` | `Observable<GuidedFormDefinition>` | combineLatest of both schema views; shareReplay per key |
| `getGuidedFormProgress(key, parentId)` | `Observable<GuidedFormProgressEntry[]>` | calls `get_guided_form_progress` RPC; not cached |
| `startGuidedForm(key)` | `Observable<ApiResponse>` | calls `start_guided_form` RPC; returns new parent_id |
| `completeStep(key, parentId, stepKey)` | `Observable<ApiResponse>` | calls `complete_guided_form_step` RPC |
| `submitGuidedForm(key, parentId)` | `Observable<ApiResponse>` | calls `submit_guided_form` RPC |
| `cancelGuidedForm(key, parentId)` | `Observable<ApiResponse>` | calls `cancel_guided_form` RPC |
| `getEffectiveSteps(definition, parent, progress)` | `EffectiveGuidedFormStep[]` | pure/sync — evaluates conditions and progress |
| `getLockedFields(definition)` | `Set<string>` | pure/sync — returns the union of all condition fields |

`getEffectiveSteps` produces an array indexed `[step0, step1, ..., stepN, reviewStep]` where
the review step is synthesized client-side with a sentinel `step_key = '__review__'`.

### `GuidedFormRunnerPage`

Route: `/workflow/:guidedFormKey/:parentId` (`:parentId` may be the literal `'new'`)
Guards: `[schemaVersionGuard, authGuard]`

If `parentId === 'new'`: call `startGuidedForm`, then `router.navigate` to the resolved URL.

Otherwise load definition + parent + progress, compute effective steps (including synthetic
review step), seek to first incomplete step, render.

If `parent.submitted_at IS NOT NULL` and `lock_on_submit = TRUE`: show "submitted" state.
If `parent.submitted_at IS NOT NULL` and `lock_on_submit = FALSE`: redirect to standard
Detail page (`/view/:parentTable/:parentId`).

`advanceStep()` handles the auto-save→complete sequencing including debounce cancellation
and pendingSave wait.

### `GuidedFormStepFormComponent`

Two render modes via `isViewMode` signal, plus two save modes based on `guided_form_status`:

**Draft steps:**
- Auto-save every 1500ms (PATCH, never touches `guided_form_status`)
- "Save & Continue" button visible
- On click: flush pending save, call `complete_guided_form_step`

**Completed steps:**
- No auto-save
- "Edit" button toggles edit mode
- In edit mode: "Save Changes" and "Cancel" buttons
- "Save Changes" forces a synchronous PATCH with all changed fields
- CHECK constraints fire; errors shown via `ErrorService`
- "Cancel" discards local changes

**Eager step record creation**: On first load, if the step record doesn't exist, the
component creates it immediately (`POST` with just the parent FK; `guided_form_status` defaults
to `'draft'`). This ensures the `existingRecordId` signal is set before any M:M editor
renders.

**Locked fields on step zero**: the locked-field set from `getLockedFields()` is passed in.
The form marks those fields as read-only when `parent.guided_form_status === 'complete'`.

### `GuidedFormReviewStepComponent`

Rendered for the synthesized `__review__` step. Inputs: `definition`, `parentRecord`,
`completedSteps`. Loads each completed step's record in parallel, renders one collapsible
card per step using `DisplayPropertyComponent`. Provides:
- "Edit" link on each card → emits `editStep` output → parent navigates back
- "Submit Application" button → emits `submit` output → parent calls `submitGuidedForm`

### `WorkflowProgressBarComponent`

DaisyUI 5 `steps steps-horizontal`. Shows non-skipped data steps + the review step at the end.
Step zero appears as the first step. Clicking a completed step emits its index for back-nav.
The review step is reachable only when all data steps are complete.

### `WorkflowNavComponent` (new)

Renders on standard Detail and Edit pages when the current entity has `guided_form_key` set.

Inputs: `guidedFormKey`, `parentId`, `currentStepKey?`

Behavior:
1. Loads `schema_guided_form_steps` for the guided form
2. For each step, resolves the record ID:
   - Step 0 (parent): ID = `parentId`
   - Steps 1–N: queries step table for record where parent FK = `parentId`
3. Loads `guided_form_progress` to show completion state
4. Renders clickable step links to `/view/:stepTable/:stepRecordId`
5. Highlights current step based on current route

The nav replaces inverse relationship cards for guided form step tables. Other unrelated
inverse relationships still render below.

---

## Dogfood Example: Neighborhood Engagement Hub (NEH)

The NEH is a real customer deployment (migrating from Salesforce) with two parallel modules
that exercise complementary workflow capabilities.

### Workflow 1: Tool Shed Reservation

A complex multi-step flow with M:M relationships, availability-checked selections, and
conditional steps.

**Step ordering:**

| Step | Entity | Key fields | Exercises |
|---|---|---|---|
| **0 (parent)** | `tool_reservations` | borrower FK, reservation type | Parent-as-step-zero, borrower status gating |
| **1** | `reservation_parcels` | Parcel M:M, site description | Basic M:M in step forms |
| **2** | `reservation_schedule` | TimeSlot | TimeSlot in workflow, duration informed by parcel count |
| **3** | `reservation_equipment` | Tool instance M:M | **Availability-checked M:M** (depends on `options_source_rpc`) |
| **4** | `reservation_delivery` | delivery flag, address, notes | Conditional skip (`skip_if delivery_required = false`) |
| **Review** | (synthesized) | Summary of all steps | Review + explicit submit |

**Validations (framework generates CHECK constraints from these):**

```sql
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('tool_reservations', 'borrower_id', 'required', NULL, 'Borrower is required', 1),
  ('tool_reservations', 'reservation_type', 'required', NULL, 'Reservation type is required', 2),
  ('reservation_schedule', 'time_slot', 'required', NULL, 'Time slot is required', 1),
  ('reservation_delivery', 'delivery_address', 'required', NULL, 'Delivery address is required', 1);
```

The trigger on `metadata.validations` auto-generates the conditional CHECK constraints.
Integrators do NOT write them by hand.

### Workflow 2: Building Use Request

A simpler flow that exercises mutually exclusive paths via skip conditions.

| Step | Entity | Key fields | Exercises |
|---|---|---|---|
| **0 (parent)** | `building_use_requests` | group name, group type, contact info | Step-zero with branching field |
| **1** | `building_use_event_details` | date/TimeSlot, event description, expected attendance | Calendar overlap prevention |
| **2** | `building_use_setup_needs` | tables, chairs, AV, kitchen access | Simple data step |
| **Review** | (synthesized) | Summary + Submit | |

### Shared entities

Both workflows share:
- **Borrowers** — decoupled from Users; has approval status.
- **Parcels** — referenced by Tool Shed reservations (M:M). Has eligibility status.

### Example registration SQL (Tool Shed)

```sql
-- 1. Parent table
CREATE TABLE public.tool_reservations (
    id                  BIGSERIAL PRIMARY KEY,
    guided_form_status     public.guided_form_step_status,
    submitted_at        TIMESTAMPTZ,
    borrower_id         INT NOT NULL REFERENCES borrowers(id),
    reservation_type    VARCHAR(50),
    delivery_required   BOOLEAN NOT NULL DEFAULT FALSE,
    created_by          UUID NOT NULL DEFAULT current_user_id(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Step: Parcel selection (M:M, step 1)
CREATE TABLE public.reservation_parcels (
    id                BIGSERIAL PRIMARY KEY,
    reservation_id    BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    guided_form_status   public.guided_form_step_status,
    site_description  TEXT
);
CREATE UNIQUE INDEX ON reservation_parcels(reservation_id);

-- Junction table for M:M parcels
CREATE TABLE public.reservation_parcel_selections (
    reservation_parcel_id BIGINT NOT NULL REFERENCES reservation_parcels(id) ON DELETE CASCADE,
    parcel_id             BIGINT NOT NULL REFERENCES parcels(id),
    PRIMARY KEY (reservation_parcel_id, parcel_id)
);

-- 3. Step: Schedule (step 2)
CREATE TABLE public.reservation_schedule (
    id                BIGSERIAL PRIMARY KEY,
    reservation_id    BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    guided_form_status   public.guided_form_step_status,
    time_slot         TSTZRANGE
);
CREATE UNIQUE INDEX ON reservation_schedule(reservation_id);

-- 4. Step: Equipment (step 3, M:M with availability check)
CREATE TABLE public.reservation_equipment (
    id                BIGSERIAL PRIMARY KEY,
    reservation_id    BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    guided_form_status   public.guided_form_step_status
);
CREATE UNIQUE INDEX ON reservation_equipment(reservation_id);

-- Junction table for M:M tool instances
CREATE TABLE public.reservation_tool_selections (
    reservation_equipment_id BIGINT NOT NULL REFERENCES reservation_equipment(id) ON DELETE CASCADE,
    tool_instance_id         BIGINT NOT NULL REFERENCES tool_instances(id),
    PRIMARY KEY (reservation_equipment_id, tool_instance_id)
);

-- 5. Step: Delivery details (step 4, conditional)
CREATE TABLE public.reservation_delivery (
    id                BIGSERIAL PRIMARY KEY,
    reservation_id    BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    guided_form_status   public.guided_form_step_status,
    delivery_address  VARCHAR(255),
    delivery_notes    TEXT
);
CREATE UNIQUE INDEX ON reservation_delivery(reservation_id);

-- 6. Register validations (framework generates CHECK constraints automatically)
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('tool_reservations', 'borrower_id', 'required', NULL, 'Borrower is required', 1),
  ('tool_reservations', 'reservation_type', 'required', NULL, 'Reservation type is required', 2),
  ('reservation_schedule', 'time_slot', 'required', NULL, 'Time slot is required', 1),
  ('reservation_delivery', 'delivery_address', 'required', NULL, 'Delivery address is required', 1);

-- 7. Register workflow
SELECT register_guided_form(
    'tool_reservation',
    'Tool Reservation',
    'tool_reservations',
    'Reserve tools and equipment from the tool shed',
    'submit_tool_reservation',
    '/view/tool_reservations/{id}',
    'Reservation Details',
    'Please review your reservation before submitting.',
    FALSE  -- lock_on_submit
);

SELECT add_guided_form_step('tool_reservation', 'parcels',
    'Work Site', 1, 'reservation_parcels', 'reservation_id');
SELECT add_guided_form_step('tool_reservation', 'schedule',
    'Schedule', 2, 'reservation_schedule', 'reservation_id');
SELECT add_guided_form_step('tool_reservation', 'equipment',
    'Select Equipment', 3, 'reservation_equipment', 'reservation_id');
SELECT add_guided_form_step('tool_reservation', 'delivery',
    'Delivery Details', 4, 'reservation_delivery', 'reservation_id',
    'Only needed for staff-delivered equipment', true);

SELECT add_guided_form_step_condition('tool_reservation', 'delivery',
    'skip_if', 'delivery_required', 'eq', 'false');

-- 8. Equipment availability RPC (depends on options_source_rpc feature)
-- INSERT INTO metadata.properties
--     (table_name, column_name, options_source_rpc)
-- VALUES ('reservation_equipment', 'reservation_tool_selections_m2m',
--         'get_available_tools');
```

---

## M:M Fields in Step Forms

M:M relationships are supported in guided form step forms. The existing
`ManyToManyEditorComponent` is embedded in `GuidedFormStepFormComponent` after the step
record's first auto-save (the record must exist for junction table FKs to reference).

**Basic M:M** (e.g., parcel selection): works with the existing editor out of the box.

**Availability-checked M:M** (e.g., tool selection filtered by TimeSlot): requires the
`options_source_rpc` platform feature. See `docs/notes/OPTIONS_SOURCE_RPC_DESIGN.md`.

Without `options_source_rpc`, availability-checked M:M falls back to showing all in-service
options + GIST exclusion constraint at submit time. Functional but poor UX.

---

## Platform Dependencies

| Dependency | Status | Blocks |
|---|---|---|
| `options_source_rpc` on `metadata.properties` | **Implemented** — see separate doc | Tool Shed step 3 (equipment availability filtering) |
| `guided_form_step_status` domain | Part of this design | All step tables |
| `metadata.guided_form_progress` table | Part of this design | Resume, progress tracking |
| Lock trigger (`metadata.enforce_guided_form_lock`) | Part of this design | Condition field stability |
| `metadata.rebuild_guided_form_constraints()` | Part of this design | Auto-generated CHECK constraints |
| Trigger on `metadata.validations` | Part of this design | Automatic constraint rebuild |

The guided form system can ship and be tested with Tool Shed steps 0–2 and 4 before
`options_source_rpc` is built. Step 3 works with the GIST constraint fallback.

---

## What's Out of Scope for v1

| Feature | Notes |
|---|---|
| Convergent DAG branching | Steps with multiple predecessors / fan-in/fan-out; deferred to v2 |
| Visual track grouping in progress bar | `track_key` column reserved; UI grouping deferred |
| Compound conditions (AND/OR) | First matching condition wins; v2 |
| Admin workflow management UI | SQL-only configuration in v1 |
| File upload in step forms | Same deferral as CreatePage (Detail page context needed) |
| Per-step RBAC beyond table grants | Use RLS on step tables |
| Step-to-step condition references | Conditions reference parent fields only |
| Multi-user editing of in-flight instance | RLS allows it; no concurrency UI |
| Computed cross-step display fields | e.g., "suggested duration based on parcel count"; could use VIEW-based step tables later |
| Workflow versioning | Definition changes after instances are in flight; deferred to v2 |

**No longer out of scope** (promoted to v1):
- M:M fields in step forms — basic embed after first auto-save
- Availability-checked M:M — via `options_source_rpc` (separate design)
- Workflow cancellation — `cancel_guided_form` RPC
- Guided form nav overlay on standard pages
- Manual-save-only for completed step re-editing
- Configurable submission locking (`lock_on_submit`)

---

## Resolved Edge Cases

### Auto-save flush on navigation

When the user clicks a progress bar step or browser back while a debounced save is pending,
data would be lost silently. `GuidedFormStepFormComponent` exposes a `flushPendingSave()`
method. `GuidedFormRunnerPage` calls it before any step transition.

Also register a `beforeunload` handler on the `GuidedFormRunnerPage` component to warn if
there are unsaved changes when the user closes the tab or navigates away from the guided form.

### `show_in_sidebar` flag on `metadata.entities`

Step tables should not appear in the sidebar. New column:

```sql
ALTER TABLE metadata.entities ADD COLUMN show_in_sidebar BOOLEAN NOT NULL DEFAULT TRUE;
```

`register_guided_form` auto-sets `show_in_sidebar = FALSE` for each step table when
`add_guided_form_step` is called. The `schema_entities` VIEW filters on
`show_in_sidebar IS NOT FALSE` (preserving backward compatibility — NULL = show).

Parent tables are NOT hidden — they remain visible in the sidebar. Clicking a row in the
List page navigates to the standard Detail page (`/view/:entity/:id`), which renders the
guided form nav overlay.

`register_guided_form_step` also sets `guided_form_key` on step tables:

```sql
UPDATE metadata.entities
   SET guided_form_key = p_guided_form_key,
       show_in_sidebar = FALSE
 WHERE table_name = p_step_table;
```

This allows the frontend to detect workflow membership on any step table page.

### `guided_form_step_status` domain in `public` schema

The domain lives in `public` schema (not `metadata`) to match the convention of existing
domains (`email_address`, `phone_number`, `hex_color`). This ensures:
- `information_schema.columns.udt_name = 'guided_form_step_status'` without schema qualification
- `SchemaService.getPropertyType()` detects it the same way as other domains
- No need to check `udt_schema`

```sql
CREATE DOMAIN public.guided_form_step_status AS VARCHAR(20)
    NOT NULL DEFAULT 'draft'
    CHECK (VALUE IN ('draft', 'complete'));
```

`SchemaService` adds a case: `udt_name = 'guided_form_step_status'` → auto-hide from all
form/list/detail contexts. No `metadata.properties` registration needed per step table.

### `start_guided_form` and nullable parent columns

With the conditional CHECK pattern, all content columns on parent and step tables must be
**nullable** (no `NOT NULL` constraint). The `NOT NULL` enforcement comes from the CHECK
constraint, not the column definition. This is a departure from normal Civic OS convention
and must be documented clearly:

**Convention for workflow tables:**
```sql
-- WRONG: NOT NULL on the column
street_address VARCHAR(255) NOT NULL,

-- RIGHT: nullable column + validation in metadata.validations
street_address VARCHAR(255),
-- framework auto-generates: CHECK (guided_form_status = 'draft' OR street_address IS NOT NULL)
```

The only columns with `NOT NULL` are framework columns: `id`, `guided_form_status` (from domain),
`created_by` (with `DEFAULT current_user_id()`), `created_at`, `updated_at`.

`start_guided_form` uses `INSERT INTO {parent_table} DEFAULT VALUES` which succeeds because all
content columns are nullable.

### Direct navigation to step entity pages

Users can navigate to `/view/reservation_equipment/17` or `/edit/reservation_equipment/17`,
bypassing the guided form runner. This is **intentional and supported**:
- The step record has `guided_form_status` and CHECK constraints regardless
- Step tables hidden from sidebar (`show_in_sidebar = FALSE`) means users won't stumble
  onto these pages accidentally
- The `WorkflowNavComponent` detects `entity.guided_form_key` and renders the guided form nav,
  providing context that this record is part of a larger workflow
- Direct navigation is the canonical way to view/edit completed workflows

### M:M display on the review step

The `GuidedFormReviewStepComponent` renders each step's data as collapsible cards. For steps
with M:M properties, the card loads junction data and renders read-only colored badges using
`ManyToManyEditorComponent` in display mode.

### Condition evaluation parity

Skip/require conditions are evaluated in both:
- Frontend: `GuidedFormService.getEffectiveSteps()` (TypeScript)
- Backend: `complete_guided_form_step` → `_check_guided_form_complete()` (PL/pgSQL)

Both must produce identical results. The operator set is intentionally small (`eq`, `neq`,
`is_null`, `is_not_null`) to make parity trivial. Test plan:

1. Write a shared test fixture: `{ parent_record, conditions[], expected_results[] }`
2. Unit test the TypeScript evaluator against this fixture
3. Functional test the PL/pgSQL evaluator against the same fixture
4. Run both on CI

### Stale draft cleanup

Abandoned workflows leave draft step records and `guided_form_progress` entries. For v1:
- No automatic cleanup — drafts persist indefinitely
- Admin can query and delete via SQL:
  ```sql
  DELETE FROM guided_form_progress
  WHERE guided_form_key = 'tool_reservation'
    AND created_at < NOW() - INTERVAL '30 days'
    AND step_key = '__parent__'
    AND submitted_at IS NULL;
  ```
- Step records are cleaned up via `ON DELETE CASCADE` from the parent FK
- A future enhancement could add a scheduled cleanup job via the consolidated worker

### PostgREST schema cache reload

The migration must include:

```sql
NOTIFY pgrst, 'reload schema';
```

The migration includes it at the end (standard pattern). `register_guided_form` does NOT fire
it — DDL trigger creation is deferred to an idempotent admin function or migration to avoid
PostgREST schema cache issues and PgBouncer DDL problems.

### System evolution: changing validations on existing workflows

When an integrator adds/modifies `metadata.validations` for a guided form step table, the
statement-level trigger calls `rebuild_guided_form_constraints()`. If the table has existing
rows, constraints are added with `NOT VALID` to avoid failing on completed workflows that
predate the new rule. Existing completed rows are grandfathered; re-editing them will require
compliance with the new rule.

### Re-editing completed steps with new validations

If a validation is added after a step is completed, and the user later re-edits that step,
the new CHECK constraint fires on save. The user must fill in the newly required field.
This is desired behavior — old workflows that are never touched remain valid, but any edit
must comply with current rules.

---

## Open Questions / Things to Validate

- The lock trigger uses a dynamic SQL EXECUTE per locked field on every UPDATE. For a parent
  table with frequent edits, this could be slow. Worth benchmarking. Alternative: build a
  cached list of locked fields per parent table at trigger creation time.

- `start_guided_form` uses `INSERT ... DEFAULT VALUES` which assumes the parent table can be
  created with all defaults. If a column is `NOT NULL` without a default, this fails. Should
  `start_guided_form` accept an initial-values JSONB to populate required-at-create columns?

- The `on_submit_rpc` runs inside `submit_guided_form`'s transaction. Long-running submission
  logic (e.g., file generation, external API calls) would hold the transaction open. Should
  we defer those to a worker via NOTIFY/LISTEN or River jobs?

- RLS policy on `guided_form_progress.update` allows users to update their own entries. This is
  needed for `submit_guided_form` to set `submitted_at`. Should that be locked down to only
  the `submit_guided_form` RPC (via SECURITY DEFINER)?

- The lock trigger is created per parent table but the function is generic. What happens if
  two workflows share a parent table? The `metadata.guided_form_step_conditions` lookup will
  union locked fields across all workflows on that parent — which is the correct behavior,
  but worth a test case.

- Building Use eligibility gating: is the full workflow skip_if mechanism the right tool, or
  is this better served by the simpler Conditional Static Text feature (NEH requirements #6)?
  The branching only gates a single field value → static message. Evaluate during implementation.

- GIST exclusion constraint for tool double-booking: the junction table
  `reservation_tool_selections` doesn't carry the `time_slot` column — it lives on
  `reservation_schedule`. The GIST constraint needs both columns on the same row. Options:
  a trigger that copies time_slot to the junction, a materialized VIEW, or enforcement via
  the availability RPC + submit-time validation RPC instead of a raw constraint.

- Auto-save conflict resolution (multi-tab): If a user has the guided form open in two tabs,
  the last write wins. Should we add optimistic locking via `updated_at` on step tables?
