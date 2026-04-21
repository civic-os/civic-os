# Workflow System Design

**Status**: Design — revised, implementation ready
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

**Key architectural decisions in this revision:**
- Workflows are **first-class entities** — the parent table is a standard Civic OS entity that
  appears in list views, receives FKs from other tables, and uses standard Detail/Edit pages.
- The **workflow runner** (`/workflow/:key/:id`) is a guided editor for active (in-progress)
  workflows only. Completed/submitted workflows are viewed and edited via standard Civic OS
  pages with a workflow navigation overlay.
- **`metadata.validations`** is the single source of truth for both frontend and backend
  validation. Conditional CHECK constraints are auto-generated from validation rules.
- **BIGINT-only** parent primary keys — framework convention, simplifies type system.
- **`submitted_at`** lives on the parent table (integrator-facing status), while
  `workflow_progress` remains framework-internal.
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
  guaranteeing condition stability for the workflow's lifetime
- **Revisitable**: completed steps can be viewed and re-edited. Constraints are armed but
  manual-save-only prevents accidental modification
- **Explicit submission**: users explicitly submit the workflow via a synthesized review step
- **Configurable immutability**: `lock_on_submit` controls whether submitted workflows become
  read-only or remain editable as standard entities
- **RLS-native access control**: single-owner by default; M:M ownership table can be added
  without framework changes
- **Framework-native validation**: integrators define validations in `metadata.validations`;
  the framework generates conditional CHECK constraints automatically

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
finalize. This is the only point at which `on_submit_rpc` fires.

### Workflow navigation overlay

When viewing or editing any workflow entity (parent or step) via standard Civic OS pages
(`/view/:entity/:id` or `/edit/:entity/:id`), a workflow navigation component renders at the
top of the page. It shows the step progress bar and allows free navigation between steps.

This replaces the "Related Entities" inverse relationship cards for 1:1 workflow steps,
since those steps are semantically part of the same entity. Other unrelated inverse
relationships still render normally below the nav.

The workflow runner (`/workflow/:key/:id`) is reserved for the **guided active experience** —
sequence enforcement, "Save & Continue", and the review step. Once a workflow is complete,
the canonical view is the standard Detail page with the workflow nav overlay.

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

- **`workflow_status` column** enables conditional CHECK constraints. Source of truth for
  step-level data integrity.
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
CREATE DOMAIN public.workflow_step_status AS VARCHAR(20)
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
    on_submit_rpc     NAME,                            -- called by submit_workflow RPC
    on_submit_navigate_to TEXT,                        -- e.g. '/view/permits/{id}'
    review_intro_text TEXT,                            -- markdown shown above review cards
    lock_on_submit    BOOLEAN NOT NULL DEFAULT FALSE,  -- if TRUE, submitted workflows are read-only
    precondition_rpc  NAME,                            -- called by start_workflow before INSERT
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`lock_on_submit`: when TRUE, `submit_workflow` creates a trigger that prevents further edits
to the parent and step tables. When FALSE (default), the workflow remains a fully editable
entity after submission.

`precondition_rpc`: optional integrator hook called by `start_workflow` before creating the
parent record. Use case: verify the user has an approved borrower profile before starting a
tool reservation. Signature: `(p_workflow_key NAME) RETURNS JSONB`.

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
    parent_id       BIGINT NOT NULL,                   -- BIGINT framework convention
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

`parent_id` uses `BIGINT` to match the framework convention that all workflow parent tables
use `BIGSERIAL` primary keys. This eliminates the need for `parent_pk_type` and dynamic casting
in RPCs.

`submitted_at` is stored on the `__parent__` row after `submit_workflow` runs. The frontend
can detect "this workflow is fully submitted" by checking `parent.submitted_at IS NOT NULL`.
Integrators can filter and report on submission status without joining the framework-internal
`workflow_progress` table.

### Parent table requirements

The parent table must:
1. Use `BIGSERIAL PRIMARY KEY` (framework convention)
2. Have a `workflow_status` column typed as `workflow_step_status`
3. Have a `submitted_at TIMESTAMPTZ` column (nullable, set by `submit_workflow`)
4. Have all content columns nullable (enforcement via CHECK constraints, not `NOT NULL`)

```sql
CREATE TABLE public.permits (
    id              BIGSERIAL PRIMARY KEY,
    workflow_status public.workflow_step_status,
    submitted_at    TIMESTAMPTZ,                     -- set on submission
    is_self_contractor BOOLEAN NOT NULL DEFAULT FALSE, -- example field driving skip condition
    -- ...other parent fields (all nullable)
    created_by      UUID NOT NULL DEFAULT current_user_id(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The framework enforces (at registration time): the parent table must have a column of type
`workflow_step_status` and must use a `BIGINT` (or `BIGSERIAL`) primary key. If either is
missing, `register_workflow` raises an exception.

### Step table requirements

Same convention; uses the domain for the status column. All content columns must be nullable.

```sql
CREATE TABLE public.permit_site_info (
    id              BIGSERIAL PRIMARY KEY,
    permit_id       BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    workflow_status public.workflow_step_status,
    street_address  VARCHAR(255),
    parcel_number   VARCHAR(50),
    project_description TEXT
);
CREATE UNIQUE INDEX ON permit_site_info(permit_id);
```

The 1:1 with parent is enforced by the unique index on `parent_fk_column`.

**Note:** Integrators do NOT write conditional CHECK constraints by hand. They define
validations in `metadata.validations`, and the framework auto-generates CHECK constraints
via `metadata.rebuild_workflow_constraints()` (see below).

### Auto-generated CHECK constraints from `metadata.validations`

`metadata.validations` is the single source of truth for workflow validation. The framework
reads validation rules and generates conditional CHECK constraints:

| `validation_type` | Auto-generated CHECK constraint |
|---|---|
| `required` | `CHECK (workflow_status = 'draft' OR {col} IS NOT NULL)` |
| `min` | `CHECK (workflow_status = 'draft' OR {col} >= {value}::numeric)` |
| `max` | `CHECK (workflow_status = 'draft' OR {col} <= {value}::numeric)` |
| `minLength` | `CHECK (workflow_status = 'draft' OR LENGTH({col}::text) >= {value}::int)` |
| `maxLength` | `CHECK (workflow_status = 'draft' OR LENGTH({col}::text) <= {value}::int)` |
| `pattern` | `CHECK (workflow_status = 'draft' OR {col}::text ~ '{regex}')` |

Auto-generated constraints are named: `{table}_{column}_{type}_wfcheck`.
This naming convention allows `rebuild_workflow_constraints()` to identify and drop stale
constraints without touching manually-created CHECK constraints.

### `metadata.rebuild_workflow_constraints()`

Idempotent function that synchronizes a workflow step table's CHECK constraints with its
`metadata.validations` entries.

```sql
CREATE OR REPLACE FUNCTION metadata.rebuild_workflow_constraints(p_table_name NAME)
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
        WHERE table_name = p_table_name AND column_name = 'workflow_status'
    ) THEN
        RAISE EXCEPTION 'Table % does not have workflow_status', p_table_name;
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
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workflow_status = ''draft'' OR %I IS NOT NULL)',
                    p_table_name, v_constraint_name, v_validation.column_name);
            WHEN 'min' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workflow_status = ''draft'' OR %I >= %L::numeric)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'max' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workflow_status = ''draft'' OR %I <= %L::numeric)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'minLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workflow_status = ''draft'' OR LENGTH(%I::text) >= %L::int)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'maxLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workflow_status = ''draft'' OR LENGTH(%I::text) <= %L::int)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'pattern' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workflow_status = ''draft'' OR %I::text ~ %L)',
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
            WHERE table_name = touched.table_name AND column_name = 'workflow_status'
        )
    LOOP
        PERFORM metadata.rebuild_workflow_constraints(v_table_name);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER validation_change_rebuild_workflow_constraints
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
CREATE OR REPLACE FUNCTION metadata.enforce_workflow_lock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_locked_field NAME;
BEGIN
    IF public.is_admin() THEN RETURN NEW; END IF;
    IF OLD.workflow_status != 'complete' THEN RETURN NEW; END IF;
    IF NEW.workflow_status != 'complete' THEN
        RAISE EXCEPTION 'Cannot revert workflow_status from complete to draft on %', TG_TABLE_NAME;
    END IF;
    FOR v_locked_field IN
        SELECT DISTINCT wsc.field
        FROM metadata.workflows w
        JOIN metadata.workflow_steps ws ON ws.workflow_key = w.workflow_key
        JOIN metadata.workflow_step_conditions wsc ON wsc.workflow_step_id = ws.id
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

When `lock_on_submit = TRUE`, `submit_workflow` creates a trigger that blocks all updates
to the parent and step tables after submission:

```sql
CREATE OR REPLACE FUNCTION metadata.block_submitted_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.submitted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Workflow has been submitted and is locked';
    END IF;
    RETURN NEW;
END;
$$;
```

This trigger is created dynamically per workflow parent table when `lock_on_submit = TRUE`.
Step tables inherit the lock indirectly: since their parent FK uses `ON DELETE CASCADE`,
updates to step records are allowed only if the parent is not submitted.

### PostgREST views

```sql
-- Workflow definitions
CREATE VIEW public.schema_workflows AS
SELECT workflow_key, display_name, description, parent_table, lock_on_submit,
       on_submit_rpc, on_submit_navigate_to, review_intro_text, precondition_rpc, is_enabled
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

`register_workflow()` inserts metadata rows and validates the parent table:
1. Validates the parent table exists and has a `workflow_step_status` column
2. Validates the parent table uses `BIGINT` (or `BIGSERIAL`) primary key
3. Inserts the workflow row
4. Inserts the auto-step-zero row in `metadata.workflow_steps` (`step_key='__parent__'`)
5. If `lock_on_submit = TRUE`, creates the submitted-workflow lock trigger on the parent table

```sql
SELECT register_workflow(
    p_workflow_key   := 'permit_application',
    p_display_name   := 'Permit Application',
    p_parent_table   := 'permits',
    p_description    := 'Multi-step building permit application',
    p_on_submit_rpc  := 'submit_permit',
    p_on_submit_navigate_to := '/view/permits/{id}',
    p_parent_step_display_name := 'Application Type',
    p_review_intro_text := 'Please review your information before submitting.',
    p_lock_on_submit := FALSE
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
1. Look up `step_table`, `parent_fk_column` from `metadata.workflow_steps`
2. Branch:
   - If `parent_fk_column IS NULL` (step zero): `UPDATE {parent_table} WHERE id = parent_id`
   - Otherwise: `UPDATE {step_table} WHERE {parent_fk_column} = parent_id`
3. CHECK constraints (and the lock trigger for step zero) fire here; violation rolls back
4. `INSERT INTO metadata.workflow_progress ON CONFLICT DO NOTHING`
5. Returns `{success: true, all_data_steps_complete: <bool>}`
6. `EXCEPTION WHEN check_violation THEN` → `{success: false, message: SQLERRM, sqlstate: '23514'}`

### `submit_workflow` (called from review step)

```sql
CREATE FUNCTION public.submit_workflow(
    p_workflow_key NAME,
    p_parent_id    BIGINT
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

    IF NOT public._check_workflow_complete(p_workflow_key, p_parent_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Workflow has incomplete required steps');
    END IF;

    -- Mark parent as submitted (integrator-facing)
    EXECUTE format('UPDATE public.%I SET submitted_at = NOW() WHERE id = $1',
        v_workflow.parent_table) USING p_parent_id;

    -- Mark progress as submitted (framework-internal)
    UPDATE metadata.workflow_progress
       SET submitted_at = NOW()
     WHERE workflow_key = p_workflow_key
       AND parent_id    = p_parent_id
       AND step_key     = '__parent__';

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
                                '{id}', p_parent_id::text)
    );
END;
$$;
```

### `cancel_workflow` (called from runner or entity action)

```sql
CREATE FUNCTION public.cancel_workflow(
    p_workflow_key NAME,
    p_parent_id    BIGINT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_workflow metadata.workflows%ROWTYPE;
BEGIN
    SELECT * INTO v_workflow FROM metadata.workflows WHERE workflow_key = p_workflow_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown workflow');
    END IF;

    -- Delete progress entries (cascades to nothing else)
    DELETE FROM metadata.workflow_progress
    WHERE workflow_key = p_workflow_key AND parent_id = p_parent_id;

    -- Delete parent record (cascades to all step records via ON DELETE CASCADE)
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_workflow.parent_table)
    USING p_parent_id;

    RETURN jsonb_build_object('success', true);
END;
$$;
```

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
    v_new_id   BIGINT;
BEGIN
    SELECT * INTO v_workflow FROM metadata.workflows WHERE workflow_key = p_workflow_key;
    IF NOT FOUND OR NOT v_workflow.is_enabled THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unknown or disabled workflow');
    END IF;

    -- Optional precondition check
    IF v_workflow.precondition_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_workflow.precondition_rpc)
        INTO v_result USING p_workflow_key;
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
        'navigate_to', '/workflow/' || p_workflow_key || '/' || v_new_id::text
    );
END;
$$;
```

---

## Routes

### Guided runner (active workflows only)

| Route | Purpose |
|---|---|
| `/workflow/:workflowKey/new` | Creates parent record via `start_workflow`, redirects to runner |
| `/workflow/:workflowKey/:parentId` | Loads existing in-progress instance, resumes at first incomplete step |

Both protected by `[schemaVersionGuard, authGuard]`.

### Standard CRUD with workflow nav overlay

| Route | Behavior |
|---|---|
| `/view/:entityKey/:entityId` | If entity is workflow parent or step, renders Detail page with workflow nav |
| `/edit/:entityKey/:entityId` | If entity is workflow parent or step, renders Edit page with workflow nav |

No special routes needed. The workflow nav is a conditional overlay based on
`entity.workflow_key`.

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

Submitted:     parent.submitted_at IS NOT NULL
```

### New workflow entry

```
User clicks "Start New Permit" link
  → navigate /workflow/permit_application/new
  → WorkflowRunnerPage detects 'new', calls start_workflow RPC
  → backend INSERT INTO permits DEFAULT VALUES (workflow_status='draft' from domain)
  → backend returns { parent_id: 42, navigate_to: '/workflow/permit_application/42' }
  → router.navigate(navigate_to) → reload as resume
```

### Resume (page load) — runner

```
/workflow/permit_application/42
  → combineLatest([
      GET /schema_workflows?workflow_key=eq.permit_application,
      GET /schema_workflow_steps?workflow_key=eq.permit_application,
      callRpc('get_workflow_progress', { workflow_key, parent_id: 42 })
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

### Resume (page load) — standard pages with workflow nav

```
/view/tool_reservations/42
  → DetailPage loads entity metadata
  → entity.workflow_key = 'tool_reservation' detected
  → renders <app-workflow-nav [workflowKey]="'tool_reservation'" [parentId]="42">
  → nav loads schema_workflow_steps + workflow_progress
  → resolves step record IDs for each step
  → highlights parent step (step 0) as current
  → standard Detail properties render below nav
```

### Step record lifecycle

```
User navigates to a data step (1–N) in runner
  → WorkflowStepFormComponent loads
  → GET /reservation_parcels?reservation_id=eq.42
  → if no record:
       POST /reservation_parcels { reservation_id: 42 }
       (creates minimal row; workflow_status='draft' from domain default)
       sets existingRecordId signal → M:M editor activates immediately
  → if record exists: sets existingRecordId from response
  → form + M:M editors are now live
```

### Auto-save (draft steps only)

```
User types in form fields
  → 1500ms debounce
  → PATCH /{step_table}?id=eq.{stepRecordId} with { ...changedFieldsOnly }
       PATCH never touches workflow_status
  → step stays 'draft'; no workflow_progress entry written

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
  → CHECK constraints fire (workflow_status = 'complete')
  → on success: return to view mode
  → on failure: show error, stay in edit mode
  → "Cancel" discards local changes
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
           -- CHECK constraints enforce required fields
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
         UPDATE parent_table SET submitted_at = NOW() WHERE id = parent_id
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
  → NO auto-save; manual save only
  → "Save Changes" PATCHes all changes; CHECK constraints fire
  → "Cancel" discards local changes
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
| `cancelWorkflow(key, parentId)` | `Observable<ApiResponse>` | calls `cancel_workflow` RPC |
| `getEffectiveSteps(definition, parent, progress)` | `EffectiveWorkflowStep[]` | pure/sync — evaluates conditions and progress |
| `getLockedFields(definition)` | `Set<string>` | pure/sync — returns the union of all condition fields |

`getEffectiveSteps` produces an array indexed `[step0, step1, ..., stepN, reviewStep]` where
the review step is synthesized client-side with a sentinel `step_key = '__review__'`.

### `WorkflowRunnerPage`

Route: `/workflow/:workflowKey/:parentId` (`:parentId` may be the literal `'new'`)
Guards: `[schemaVersionGuard, authGuard]`

If `parentId === 'new'`: call `startWorkflow`, then `router.navigate` to the resolved URL.

Otherwise load definition + parent + progress, compute effective steps (including synthetic
review step), seek to first incomplete step, render.

If `parent.submitted_at IS NOT NULL` and `lock_on_submit = TRUE`: show "submitted" state.
If `parent.submitted_at IS NOT NULL` and `lock_on_submit = FALSE`: redirect to standard
Detail page (`/view/:parentTable/:parentId`).

`advanceStep()` handles the auto-save→complete sequencing including debounce cancellation
and pendingSave wait.

### `WorkflowStepFormComponent`

Two render modes via `isViewMode` signal, plus two save modes based on `workflow_status`:

**Draft steps:**
- Auto-save every 1500ms (PATCH, never touches `workflow_status`)
- "Save & Continue" button visible
- On click: flush pending save, call `complete_workflow_step`

**Completed steps:**
- No auto-save
- "Edit" button toggles edit mode
- In edit mode: "Save Changes" and "Cancel" buttons
- "Save Changes" forces a synchronous PATCH with all changed fields
- CHECK constraints fire; errors shown via `ErrorService`
- "Cancel" discards local changes

**Eager step record creation**: On first load, if the step record doesn't exist, the
component creates it immediately (`POST` with just the parent FK; `workflow_status` defaults
to `'draft'`). This ensures the `existingRecordId` signal is set before any M:M editor
renders.

**Locked fields on step zero**: the locked-field set from `getLockedFields()` is passed in.
The form marks those fields as read-only when `parent.workflow_status === 'complete'`.

### `WorkflowReviewStepComponent`

Rendered for the synthesized `__review__` step. Inputs: `definition`, `parentRecord`,
`completedSteps`. Loads each completed step's record in parallel, renders one collapsible
card per step using `DisplayPropertyComponent`. Provides:
- "Edit" link on each card → emits `editStep` output → parent navigates back
- "Submit Application" button → emits `submit` output → parent calls `submitWorkflow`

### `WorkflowProgressBarComponent`

DaisyUI 5 `steps steps-horizontal`. Shows non-skipped data steps + the review step at the end.
Step zero appears as the first step. Clicking a completed step emits its index for back-nav.
The review step is reachable only when all data steps are complete.

### `WorkflowNavComponent` (new)

Renders on standard Detail and Edit pages when the current entity has `workflow_key` set.

Inputs: `workflowKey`, `parentId`, `currentStepKey?`

Behavior:
1. Loads `schema_workflow_steps` for the workflow
2. For each step, resolves the record ID:
   - Step 0 (parent): ID = `parentId`
   - Steps 1–N: queries step table for record where parent FK = `parentId`
3. Loads `workflow_progress` to show completion state
4. Renders clickable step links to `/view/:stepTable/:stepRecordId`
5. Highlights current step based on current route

The nav replaces inverse relationship cards for workflow step tables. Other unrelated
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
    workflow_status     public.workflow_step_status,
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
    workflow_status   public.workflow_step_status,
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
    workflow_status   public.workflow_step_status,
    time_slot         TSTZRANGE
);
CREATE UNIQUE INDEX ON reservation_schedule(reservation_id);

-- 4. Step: Equipment (step 3, M:M with availability check)
CREATE TABLE public.reservation_equipment (
    id                BIGSERIAL PRIMARY KEY,
    reservation_id    BIGINT NOT NULL REFERENCES tool_reservations(id) ON DELETE CASCADE,
    workflow_status   public.workflow_step_status
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
    workflow_status   public.workflow_step_status,
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
SELECT register_workflow(
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

SELECT add_workflow_step('tool_reservation', 'parcels',
    'Work Site', 1, 'reservation_parcels', 'reservation_id');
SELECT add_workflow_step('tool_reservation', 'schedule',
    'Schedule', 2, 'reservation_schedule', 'reservation_id');
SELECT add_workflow_step('tool_reservation', 'equipment',
    'Select Equipment', 3, 'reservation_equipment', 'reservation_id');
SELECT add_workflow_step('tool_reservation', 'delivery',
    'Delivery Details', 4, 'reservation_delivery', 'reservation_id',
    'Only needed for staff-delivered equipment', true);

SELECT add_workflow_step_condition('tool_reservation', 'delivery',
    'skip_if', 'delivery_required', 'eq', 'false');

-- 8. Equipment availability RPC (depends on options_source_rpc feature)
-- INSERT INTO metadata.properties
--     (table_name, column_name, options_source_rpc)
-- VALUES ('reservation_equipment', 'reservation_tool_selections_m2m',
--         'get_available_tools');
```

---

## M:M Fields in Step Forms

M:M relationships are supported in workflow step forms. The existing
`ManyToManyEditorComponent` is embedded in `WorkflowStepFormComponent` after the step
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
| `workflow_step_status` domain | Part of this design | All step tables |
| `metadata.workflow_progress` table | Part of this design | Resume, progress tracking |
| Lock trigger (`metadata.enforce_workflow_lock`) | Part of this design | Condition field stability |
| `metadata.rebuild_workflow_constraints()` | Part of this design | Auto-generated CHECK constraints |
| Trigger on `metadata.validations` | Part of this design | Automatic constraint rebuild |

The workflow system can ship and be tested with Tool Shed steps 0–2 and 4 before
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
- Workflow cancellation — `cancel_workflow` RPC
- Workflow nav overlay on standard pages
- Manual-save-only for completed step re-editing
- Configurable submission locking (`lock_on_submit`)

---

## Resolved Edge Cases

### Auto-save flush on navigation

When the user clicks a progress bar step or browser back while a debounced save is pending,
data would be lost silently. `WorkflowStepFormComponent` exposes a `flushPendingSave()`
method. `WorkflowRunnerPage` calls it before any step transition.

Also register a `beforeunload` handler on the `WorkflowRunnerPage` component to warn if
there are unsaved changes when the user closes the tab or navigates away from the workflow.

### `show_in_sidebar` flag on `metadata.entities`

Step tables should not appear in the sidebar. New column:

```sql
ALTER TABLE metadata.entities ADD COLUMN show_in_sidebar BOOLEAN NOT NULL DEFAULT TRUE;
```

`register_workflow` auto-sets `show_in_sidebar = FALSE` for each step table when
`add_workflow_step` is called. The `schema_entities` VIEW filters on
`show_in_sidebar IS NOT FALSE` (preserving backward compatibility — NULL = show).

Parent tables are NOT hidden — they remain visible in the sidebar. Clicking a row in the
List page navigates to the standard Detail page (`/view/:entity/:id`), which renders the
workflow nav overlay.

`register_workflow_step` also sets `workflow_key` on step tables:

```sql
UPDATE metadata.entities
   SET workflow_key = p_workflow_key,
       show_in_sidebar = FALSE
 WHERE table_name = p_step_table;
```

This allows the frontend to detect workflow membership on any step table page.

### `workflow_step_status` domain in `public` schema

The domain lives in `public` schema (not `metadata`) to match the convention of existing
domains (`email_address`, `phone_number`, `hex_color`). This ensures:
- `information_schema.columns.udt_name = 'workflow_step_status'` without schema qualification
- `SchemaService.getPropertyType()` detects it the same way as other domains
- No need to check `udt_schema`

```sql
CREATE DOMAIN public.workflow_step_status AS VARCHAR(20)
    NOT NULL DEFAULT 'draft'
    CHECK (VALUE IN ('draft', 'complete'));
```

`SchemaService` adds a case: `udt_name = 'workflow_step_status'` → auto-hide from all
form/list/detail contexts. No `metadata.properties` registration needed per step table.

### `start_workflow` and nullable parent columns

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
-- framework auto-generates: CHECK (workflow_status = 'draft' OR street_address IS NOT NULL)
```

The only columns with `NOT NULL` are framework columns: `id`, `workflow_status` (from domain),
`created_by` (with `DEFAULT current_user_id()`), `created_at`, `updated_at`.

`start_workflow` uses `INSERT INTO {parent_table} DEFAULT VALUES` which succeeds because all
content columns are nullable.

### Direct navigation to step entity pages

Users can navigate to `/view/reservation_equipment/17` or `/edit/reservation_equipment/17`,
bypassing the workflow runner. This is **intentional and supported**:
- The step record has `workflow_status` and CHECK constraints regardless
- Step tables hidden from sidebar (`show_in_sidebar = FALSE`) means users won't stumble
  onto these pages accidentally
- The `WorkflowNavComponent` detects `entity.workflow_key` and renders the workflow nav,
  providing context that this record is part of a larger workflow
- Direct navigation is the canonical way to view/edit completed workflows

### M:M display on the review step

The `WorkflowReviewStepComponent` renders each step's data as collapsible cards. For steps
with M:M properties, the card loads junction data and renders read-only colored badges using
`ManyToManyEditorComponent` in display mode.

### Condition evaluation parity

Skip/require conditions are evaluated in both:
- Frontend: `WorkflowService.getEffectiveSteps()` (TypeScript)
- Backend: `complete_workflow_step` → `_check_workflow_complete()` (PL/pgSQL)

Both must produce identical results. The operator set is intentionally small (`eq`, `neq`,
`is_null`, `is_not_null`) to make parity trivial. Test plan:

1. Write a shared test fixture: `{ parent_record, conditions[], expected_results[] }`
2. Unit test the TypeScript evaluator against this fixture
3. Functional test the PL/pgSQL evaluator against the same fixture
4. Run both on CI

### Stale draft cleanup

Abandoned workflows leave draft step records and `workflow_progress` entries. For v1:
- No automatic cleanup — drafts persist indefinitely
- Admin can query and delete via SQL:
  ```sql
  DELETE FROM workflow_progress
  WHERE workflow_key = 'tool_reservation'
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

The migration includes it at the end (standard pattern). `register_workflow` does NOT fire
it — DDL trigger creation is deferred to an idempotent admin function or migration to avoid
PostgREST schema cache issues and PgBouncer DDL problems.

### System evolution: changing validations on existing workflows

When an integrator adds/modifies `metadata.validations` for a workflow step table, the
statement-level trigger calls `rebuild_workflow_constraints()`. If the table has existing
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

- Building Use eligibility gating: is the full workflow skip_if mechanism the right tool, or
  is this better served by the simpler Conditional Static Text feature (NEH requirements #6)?
  The branching only gates a single field value → static message. Evaluate during implementation.

- GIST exclusion constraint for tool double-booking: the junction table
  `reservation_tool_selections` doesn't carry the `time_slot` column — it lives on
  `reservation_schedule`. The GIST constraint needs both columns on the same row. Options:
  a trigger that copies time_slot to the junction, a materialized VIEW, or enforcement via
  the availability RPC + submit-time validation RPC instead of a raw constraint.

- Auto-save conflict resolution (multi-tab): If a user has the workflow open in two tabs,
  the last write wins. Should we add optimistic locking via `updated_at` on step tables?
