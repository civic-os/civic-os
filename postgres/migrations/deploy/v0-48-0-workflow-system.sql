-- Deploy civic_os:v0-48-0-workflow-system to pg
-- requires: v0-47-0-add-photo-gallery

BEGIN;

-- ============================================================================
-- GUIDED FORM SYSTEM (v0.48.0)
-- ============================================================================
-- Purpose: Multi-step guided form framework for permit applications, grant
--   submissions, onboarding flows, and other sequential data collection.
--
-- Architecture:
--   - guided_forms: Guided form definitions (parent table, steps, submission hooks)
--   - guided_form_steps: Ordered step definitions (auto-registers __parent__ step 0)
--   - guided_form_step_conditions: skip_if / require_if branching conditions
--   - guided_form_progress: Denormalized completion log for O(1) resume
--   - status_id FK: references metadata.statuses for lifecycle tracking (draft/complete/submitted)
--   - Auto-generated CHECK constraints from metadata.validations
--
-- UX:
--   - Standard /edit/ and /view/ pages host the guided form experience
--   - EditPage enters "guided form mode" when editing a draft guided form step
--   - GuidedFormNavComponent overlays progress bar and step navigation
--   - Review & Submit section renders inline on parent Detail page
-- ============================================================================


-- ============================================================================
-- 1. HELPER FUNCTION: public.is_guided_form_draft()
-- ============================================================================
-- CHECK constraints cannot contain subqueries but CAN call STABLE functions.
-- Used in guided form CHECK constraints: is_guided_form_draft(status_id) OR col IS NOT NULL.

CREATE OR REPLACE FUNCTION public.is_guided_form_draft(p_status_id INTEGER)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM metadata.statuses
        WHERE id = p_status_id
          AND entity_type = 'guided_form'
          AND status_key = 'draft'
    );
$$;

COMMENT ON FUNCTION public.is_guided_form_draft(INTEGER) IS
    'Returns TRUE if the given status_id corresponds to the guided form ''draft'' status. '
    'Used in CHECK constraints on guided form tables. Added in v0.48.0.';


-- ============================================================================
-- 2. TABLE: metadata.guided_forms
-- ============================================================================

CREATE TABLE metadata.guided_forms (
    guided_form_key          NAME PRIMARY KEY,
    description           TEXT,
    parent_table          NAME NOT NULL,
    ownership_column      NAME DEFAULT 'created_by',       -- column on parent_table for row ownership; NULL = no ownership RLS
    on_submit_rpc         NAME,                            -- called by submit_guided_form
    review_intro_text     TEXT,                            -- markdown shown above review cards
    lock_on_submit        BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = read-only after submit
    precondition_rpc      NAME,                            -- called by start_guided_form before INSERT
    is_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    auto_submit_on_all_skipped BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = auto-submit when all non-parent steps are condition-skipped
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.guided_forms IS
    'Guided form definitions. Each guided form has one parent table (step 0) and N step tables. '
    'Added in v0.48.0.';

COMMENT ON COLUMN metadata.guided_forms.guided_form_key IS
    'Machine-friendly identifier (e.g. permit_application). Primary key.';

COMMENT ON COLUMN metadata.guided_forms.parent_table IS
    'The parent entity table. Must have a BIGINT PK. status_id column is auto-added by register_guided_form().';

COMMENT ON COLUMN metadata.guided_forms.ownership_column IS
    'Column on parent_table that stores the owner UUID (default: created_by). '
    'register_guided_form auto-creates RLS policies for owner access. NULL = no ownership RLS.';

COMMENT ON COLUMN metadata.guided_forms.lock_on_submit IS
    'When TRUE, submit_guided_form creates a trigger preventing further edits.';


-- ============================================================================
-- 3. TABLE: metadata.guided_form_steps
-- ============================================================================

CREATE TABLE metadata.guided_form_steps (
    id                SERIAL PRIMARY KEY,
    guided_form_key      NAME NOT NULL REFERENCES metadata.guided_forms ON DELETE CASCADE,
    step_key          NAME NOT NULL,                   -- '__parent__' for step zero
    display_name      VARCHAR(100) NOT NULL,
    description       TEXT,
    step_table        NAME NOT NULL,
    parent_fk_column  NAME,                            -- NULL for step zero
    step_order        INT NOT NULL,                    -- 0 for parent step
    can_skip          BOOLEAN NOT NULL DEFAULT FALSE,
    track_key         TEXT,                            -- reserved for v1.5 grouping
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (guided_form_key, step_key),
    UNIQUE (guided_form_key, step_order)
);

CREATE INDEX idx_guided_form_steps_key ON metadata.guided_form_steps(guided_form_key);
CREATE INDEX idx_guided_form_steps_step_table ON metadata.guided_form_steps(step_table);

COMMENT ON TABLE metadata.guided_form_steps IS
    'Ordered step definitions within a guided form. Step zero (__parent__) is auto-registered. '
    'Added in v0.48.0.';


-- ============================================================================
-- 4. TABLE: metadata.guided_form_step_conditions
-- ============================================================================

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

CREATE INDEX idx_gfsc_step ON metadata.guided_form_step_conditions(guided_form_step_id);

COMMENT ON TABLE metadata.guided_form_step_conditions IS
    'Skip/require conditions referencing parent record fields. Fields are locked once step zero completes. '
    'Added in v0.48.0.';


-- ============================================================================
-- 5. TABLE: metadata.guided_form_progress
-- ============================================================================

CREATE TABLE metadata.guided_form_progress (
    id              BIGSERIAL PRIMARY KEY,
    guided_form_key    NAME NOT NULL REFERENCES metadata.guided_forms(guided_form_key) ON DELETE CASCADE,
    parent_id       BIGINT NOT NULL,                   -- BIGINT framework convention
    step_key        NAME NOT NULL,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_by    UUID REFERENCES metadata.civic_os_users(id) ON DELETE SET NULL,
    submitted_at    TIMESTAMPTZ,                       -- set by submit_guided_form on __parent__ row
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (guided_form_key, parent_id, step_key)
);

CREATE INDEX idx_gfp_lookup ON metadata.guided_form_progress (guided_form_key, parent_id);
CREATE INDEX idx_gfp_step_key ON metadata.guided_form_progress (step_key);
CREATE INDEX idx_gfp_user ON metadata.guided_form_progress (completed_by);

COMMENT ON TABLE metadata.guided_form_progress IS
    'Denormalized guided form completion log. Single-row-per-step for O(1) resume queries. '
    'submitted_at on the __parent__ row indicates full submission. Added in v0.48.0.';


-- ============================================================================
-- 6. RLS: guided_form_progress
-- ============================================================================

ALTER TABLE metadata.guided_form_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guided form progress SELECT: owner, admin, or table-permitted"
    ON metadata.guided_form_progress
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR completed_by = public.current_user_id()
        OR public.has_permission(
            (SELECT parent_table FROM metadata.guided_forms gf WHERE gf.guided_form_key = guided_form_progress.guided_form_key),
            'read'
        )
    );

CREATE POLICY "Guided form progress INSERT: owner only"
    ON metadata.guided_form_progress
    FOR INSERT TO authenticated
    WITH CHECK (completed_by = public.current_user_id());

CREATE POLICY "Guided form progress UPDATE: owner, admin, or table-permitted"
    ON metadata.guided_form_progress
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR completed_by = public.current_user_id()
        OR public.has_permission(
            (SELECT parent_table FROM metadata.guided_forms gf WHERE gf.guided_form_key = guided_form_progress.guided_form_key),
            'update'
        )
    );

CREATE POLICY "Guided form progress DELETE: owner, admin, or table-permitted"
    ON metadata.guided_form_progress
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR completed_by = public.current_user_id()
        OR public.has_permission(
            (SELECT parent_table FROM metadata.guided_forms gf WHERE gf.guided_form_key = guided_form_progress.guided_form_key),
            'delete'
        )
    );


-- ============================================================================
-- 7. ALTER metadata.entities
-- ============================================================================

ALTER TABLE metadata.entities
    ADD COLUMN show_in_sidebar BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE metadata.entities
    ADD COLUMN guided_form_key NAME REFERENCES metadata.guided_forms;

COMMENT ON COLUMN metadata.entities.show_in_sidebar IS
    'When FALSE, entity is hidden from sidebar navigation. Step tables are auto-hidden. Added in v0.48.0.';

COMMENT ON COLUMN metadata.entities.guided_form_key IS
    'Links entity to its guided form definition. Step tables auto-populated by add_guided_form_step. Added in v0.48.0.';


-- ============================================================================
-- 8. UPDATE schema_entities VIEW
-- ============================================================================
-- Exposes show_in_sidebar as a SELECT field (instead of filtering in WHERE)
-- so the Entity Management admin page can see hidden entities.
-- The frontend's SchemaService.getEntitiesForMenu() filters by show_in_sidebar.

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view,
    entities.guided_form_key,
    COALESCE(entities.show_in_sidebar, true) AS show_in_sidebar
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view. Exposes show_in_sidebar for frontend filtering. '
    'guided_form_key indicates guided form membership. Updated in v0.48.0.';



-- ============================================================================
-- 9. PUBLIC VIEWS (PostgREST-exposed)
-- ============================================================================

-- Guided form definitions
CREATE VIEW public.schema_guided_forms AS
SELECT
    gf.guided_form_key,
    gf.description,
    gf.parent_table,
    gf.ownership_column,
    gf.lock_on_submit,
    gf.on_submit_rpc,
    gf.review_intro_text,
    gf.precondition_rpc,
    gf.is_enabled,
    gf.auto_submit_on_all_skipped,
    (SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'status_key', s.status_key,
        'display_name', s.display_name, 'color', s.color
    ) ORDER BY s.sort_order)
    FROM metadata.statuses s WHERE s.entity_type = 'guided_form') AS status_options
FROM metadata.guided_forms gf
WHERE gf.is_enabled = TRUE;

ALTER VIEW public.schema_guided_forms SET (security_invoker = true);
GRANT SELECT ON public.schema_guided_forms TO web_anon, authenticated;

COMMENT ON VIEW public.schema_guided_forms IS
    'Active guided form definitions for frontend consumption. Added in v0.48.0.';


-- Steps with conditions embedded as JSONB
CREATE VIEW public.schema_guided_form_steps AS
SELECT
    ws.id,
    ws.guided_form_key,
    ws.step_key,
    ws.display_name,
    ws.description,
    ws.step_table,
    ws.parent_fk_column,
    ws.step_order,
    ws.can_skip,
    ws.track_key,
    COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object(
                'id', c.id,
                'condition_type', c.condition_type,
                'field', c.field,
                'operator', c.operator,
                'value', c.value
            ) ORDER BY c.sort_order
         ) FROM metadata.guided_form_step_conditions c WHERE c.guided_form_step_id = ws.id),
        '[]'::jsonb
    ) AS conditions
FROM metadata.guided_form_steps ws
ORDER BY ws.guided_form_key, ws.step_order;

ALTER VIEW public.schema_guided_form_steps SET (security_invoker = true);
GRANT SELECT ON public.schema_guided_form_steps TO web_anon, authenticated;

COMMENT ON VIEW public.schema_guided_form_steps IS
    'Guided form steps with conditions embedded as JSONB. Added in v0.48.0.';


-- Progress thin view
CREATE VIEW public.guided_form_progress AS
SELECT
    id,
    guided_form_key,
    parent_id,
    step_key,
    completed_at,
    completed_by,
    submitted_at,
    created_at
FROM metadata.guided_form_progress;

ALTER VIEW public.guided_form_progress SET (security_invoker = true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guided_form_progress TO authenticated;

-- Grant underlying table access for security_invoker views
GRANT SELECT ON metadata.guided_forms TO web_anon, authenticated;
GRANT SELECT ON metadata.guided_form_steps TO web_anon, authenticated;
GRANT SELECT ON metadata.guided_form_step_conditions TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.guided_form_progress TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.guided_form_progress_id_seq TO authenticated;

COMMENT ON VIEW public.guided_form_progress IS
    'Guided form completion progress. RLS enforced via underlying metadata table. Added in v0.48.0.';


-- ============================================================================
-- 10. FUNCTION: metadata.rebuild_guided_form_constraints()
-- ============================================================================
-- Idempotent: synchronizes a guided form step table's CHECK constraints with its
-- metadata.validations entries. Uses NOT VALID for existing rows.

CREATE OR REPLACE FUNCTION metadata.rebuild_guided_form_constraints(p_table_name NAME)
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
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
    -- Guard: skip tables that aren't part of any guided form
    IF NOT EXISTS (
        SELECT 1 FROM metadata.guided_form_steps WHERE step_table = p_table_name
    ) AND NOT EXISTS (
        SELECT 1 FROM metadata.guided_forms WHERE parent_table = p_table_name
    ) THEN
        RETURN;
    END IF;

    -- Validate the table has status_id (added by register_guided_form/add_guided_form_step)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = p_table_name AND column_name = 'status_id'
    ) THEN
        RAISE EXCEPTION 'Table % does not have status_id column', p_table_name;
    END IF;

    -- Reliable check for existing rows (reltuples is an estimate, often 0 for small tables)
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)', p_table_name) INTO v_has_rows;

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
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(status_id) OR %I IS NOT NULL)',
                    p_table_name, v_constraint_name, v_validation.column_name);
            WHEN 'min' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(status_id) OR %I >= %L::numeric)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'max' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(status_id) OR %I <= %L::numeric)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'minLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(status_id) OR LENGTH(%I::text) >= %L::int)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'maxLength' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(status_id) OR LENGTH(%I::text) <= %L::int)',
                    p_table_name, v_constraint_name, v_validation.column_name, v_validation.validation_value);
            WHEN 'pattern' THEN
                v_constraint_sql := format(
                    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (public.is_guided_form_draft(status_id) OR %I::text ~ %L)',
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

COMMENT ON FUNCTION metadata.rebuild_guided_form_constraints(NAME) IS
    'Idempotently rebuilds conditional CHECK constraints for a guided form step table '
    'from metadata.validations. Uses NOT VALID for existing rows. Added in v0.48.0.';


-- ============================================================================
-- 11. TRIGGER: auto-rebuild constraints on validation changes
-- ============================================================================
-- PostgreSQL does not allow transition tables on triggers with more than one
-- event. We use three separate triggers with wrapper functions.

CREATE OR REPLACE FUNCTION metadata.on_validation_change_rebuild_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_table_name NAME;
BEGIN
    FOR v_table_name IN
        SELECT DISTINCT table_name FROM new_table
        WHERE EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = new_table.table_name AND column_name = 'status_id'
        )
    LOOP
        PERFORM metadata.rebuild_guided_form_constraints(v_table_name);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION metadata.on_validation_change_rebuild_update()
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
            WHERE table_name = touched.table_name AND column_name = 'status_id'
        )
    LOOP
        PERFORM metadata.rebuild_guided_form_constraints(v_table_name);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION metadata.on_validation_change_rebuild_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_table_name NAME;
BEGIN
    FOR v_table_name IN
        SELECT DISTINCT table_name FROM old_table
        WHERE EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = old_table.table_name AND column_name = 'status_id'
        )
    LOOP
        PERFORM metadata.rebuild_guided_form_constraints(v_table_name);
    END LOOP;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS validation_change_rebuild_insert ON metadata.validations;
DROP TRIGGER IF EXISTS validation_change_rebuild_update ON metadata.validations;
DROP TRIGGER IF EXISTS validation_change_rebuild_delete ON metadata.validations;

CREATE TRIGGER validation_change_rebuild_insert
    AFTER INSERT ON metadata.validations
    REFERENCING NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.on_validation_change_rebuild_insert();

CREATE TRIGGER validation_change_rebuild_update
    AFTER UPDATE ON metadata.validations
    REFERENCING NEW TABLE AS new_table OLD TABLE AS old_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.on_validation_change_rebuild_update();

CREATE TRIGGER validation_change_rebuild_delete
    AFTER DELETE ON metadata.validations
    REFERENCING OLD TABLE AS old_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION metadata.on_validation_change_rebuild_delete();


-- ============================================================================
-- 12. FUNCTION: metadata.enforce_guided_form_lock()
-- ============================================================================
-- Prevents modification to fields used in skip/require conditions once step zero
-- completes. Also prevents reverting status_id from complete to draft.

CREATE OR REPLACE FUNCTION metadata.enforce_guided_form_lock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_locked_field NAME;
    v_old_value TEXT;
    v_new_value TEXT;
    v_old_status_key TEXT;
    v_new_status_key TEXT;
BEGIN
    -- Users with update permission on this table bypass the lock
    IF public.has_permission(TG_TABLE_NAME::TEXT, 'update') THEN RETURN NEW; END IF;

    -- Look up status keys for old and new status_id
    SELECT status_key INTO v_old_status_key FROM metadata.statuses WHERE id = OLD.status_id;
    SELECT status_key INTO v_new_status_key FROM metadata.statuses WHERE id = NEW.status_id;

    -- Parent status_id follows a forward-only lifecycle: draft → complete → submitted.
    -- Block any reversion from 'complete' except the legitimate forward transition
    -- to 'submitted' (used by submit_guided_form / auto-submit).
    IF v_old_status_key = 'complete' AND v_new_status_key NOT IN ('complete', 'submitted') THEN
        RAISE EXCEPTION 'Cannot revert status from complete to draft on %', TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;

    -- Only lock condition fields when form lifecycle is 'complete'
    IF v_old_status_key != 'complete' THEN RETURN NEW; END IF;

    -- Check each condition field for changes using jsonb for dynamic field access
    FOR v_locked_field IN
        SELECT DISTINCT wsc.field
        FROM metadata.guided_forms w
        JOIN metadata.guided_form_steps ws ON ws.guided_form_key = w.guided_form_key
        JOIN metadata.guided_form_step_conditions wsc ON wsc.guided_form_step_id = ws.id
        WHERE w.parent_table = TG_TABLE_NAME
    LOOP
        EXECUTE format('SELECT to_jsonb($1)->>%L', v_locked_field) INTO v_old_value USING OLD;
        EXECUTE format('SELECT to_jsonb($1)->>%L', v_locked_field) INTO v_new_value USING NEW;
        IF v_old_value IS DISTINCT FROM v_new_value THEN
            RAISE EXCEPTION 'Field % is locked while guided form step is complete', v_locked_field
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.enforce_guided_form_lock() IS
    'Trigger function: enforces forward-only status lifecycle (draft → complete → submitted) '
    'and locks condition fields on guided form parent tables once form is complete. '
    'complete → submitted is allowed for auto-submit. '
    'Users with update permission on the table bypass the lock. Added in v0.48.0.';


-- ============================================================================
-- 13. FUNCTION: metadata.block_submitted_update()
-- ============================================================================
-- Blocks all updates to parent/step tables after submission when lock_on_submit=TRUE.

CREATE OR REPLACE FUNCTION metadata.block_submitted_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Users with update permission on this table can edit even after submission
    IF public.has_permission(TG_TABLE_NAME::TEXT, 'update') THEN RETURN NEW; END IF;

    -- Guard: skip if table doesn't have submitted_at column (defensive)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = TG_TABLE_NAME AND column_name = 'submitted_at'
    ) THEN
        RETURN NEW;
    END IF;

    IF OLD.submitted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Guided form has been submitted and is locked';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION metadata.block_submitted_update() IS
    'Trigger function: blocks updates to submitted guided forms when lock_on_submit=TRUE. '
    'Users with update permission on the table can still edit. Added in v0.48.0.';


-- ============================================================================
-- 13a. FUNCTION: metadata.cascade_guided_form_delete()
-- ============================================================================
-- Cleans up guided_form_progress rows when a parent record is deleted.
-- Child step rows are handled by ON DELETE CASCADE on the FK constraint
-- (upgraded automatically in add_guided_form_step), but progress is a
-- logical FK (parent_id + guided_form_key) with no physical constraint,
-- so this trigger handles it.

CREATE OR REPLACE FUNCTION metadata.cascade_guided_form_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
    DELETE FROM metadata.guided_form_progress
    WHERE guided_form_key = (
        SELECT guided_form_key FROM metadata.guided_forms WHERE parent_table = TG_TABLE_NAME
    ) AND parent_id = OLD.id;
    RETURN OLD;
END;
$$;

COMMENT ON FUNCTION metadata.cascade_guided_form_delete() IS
    'Trigger function: deletes guided_form_progress rows when a parent record is deleted. '
    'Attached by register_guided_form(). Added in v0.48.0.';


-- ============================================================================
-- 13b. SEED DATA: Guided form status values
-- ============================================================================
-- All guided forms share one status entity type ('guided_form') with three values.
-- status_id FK on parent and child tables provides lifecycle tracking, colored badges,
-- filtering, and sorting via the standard Civic OS Status system.
-- CHECK constraints use is_guided_form_draft(status_id) helper function.

INSERT INTO metadata.status_types (entity_type, description)
VALUES ('guided_form', 'Guided form lifecycle status')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, sort_order, is_initial, is_terminal, status_key)
VALUES
    ('guided_form', 'Draft',     '#f59e0b', 1, TRUE,  FALSE, 'draft'),
    ('guided_form', 'Complete',  '#22c55e', 2, FALSE, FALSE, 'complete'),
    ('guided_form', 'Submitted', '#3b82f6', 3, FALSE, TRUE,  'submitted')
ON CONFLICT (entity_type, status_key) DO NOTHING;


-- ============================================================================
-- 14. RPC: register_guided_form()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.register_guided_form(
    p_guided_form_key            NAME,
    p_parent_table            NAME,
    p_description             TEXT DEFAULT NULL,
    p_on_submit_rpc           NAME DEFAULT NULL,
    p_parent_step_display_name VARCHAR(100) DEFAULT 'Application Details',
    p_review_intro_text       TEXT DEFAULT NULL,
    p_lock_on_submit          BOOLEAN DEFAULT FALSE,
    p_precondition_rpc        NAME DEFAULT NULL,
    p_ownership_column        NAME DEFAULT 'created_by'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_pk_column TEXT;
    v_pk_type   TEXT;
BEGIN
    -- Admin guard: only admins (or superusers running init scripts) can register guided forms
    IF NOT (public.is_admin() OR current_setting('is_superuser', true) = 'on') THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    -- Validate parent table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = p_parent_table
    ) THEN
        RETURN jsonb_build_object('success', false, 'message', format('Parent table %s does not exist', p_parent_table));
    END IF;

    -- Auto-add status_id column (lifecycle tracking via Civic OS Status system).
    -- Used by CHECK constraints via is_guided_form_draft(status_id) helper.
    -- Visible on list/detail pages as colored status badge; hidden from create/edit forms.
    EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS status_id INTEGER REFERENCES metadata.statuses(id) DEFAULT public.get_initial_status(''guided_form'')',
        p_parent_table
    );
    -- Index on status_id for FK lookups and filtered queries
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_status_id ON public.%I (status_id)', p_parent_table, p_parent_table);

    INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order,
        show_on_list, show_on_create, show_on_edit, show_on_detail, filterable, status_entity_type)
    VALUES (p_parent_table, 'status_id', 'Status', -10,
        true, false, false, true, true, 'guided_form')
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET status_entity_type = 'guided_form', filterable = true,
          show_on_list = true, show_on_detail = true,
          show_on_create = false, show_on_edit = false;

    -- Validate ownership column exists on parent table (if specified)
    IF p_ownership_column IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = p_parent_table AND column_name = p_ownership_column
        ) THEN
            RETURN jsonb_build_object('success', false, 'message', format('Parent table %s must have an ownership column %s (UUID)', p_parent_table, p_ownership_column));
        END IF;
    END IF;

    -- Validate parent table uses BIGINT PK
    SELECT kcu.column_name, c.data_type
    INTO v_pk_column, v_pk_type
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.columns c ON c.table_name = tc.table_name AND c.column_name = kcu.column_name
    WHERE tc.table_schema = 'public' AND tc.table_name = p_parent_table
      AND tc.constraint_type = 'PRIMARY KEY'
    LIMIT 1;

    IF v_pk_column IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', format('Parent table %s must have a primary key', p_parent_table));
    END IF;

    IF v_pk_type NOT IN ('bigint', 'bigserial') THEN
        RETURN jsonb_build_object('success', false, 'message', format('Parent table %s PK must be bigint or bigserial, found %s', p_parent_table, v_pk_type));
    END IF;

    -- Insert guided form definition
    INSERT INTO metadata.guided_forms (
        guided_form_key, description, parent_table,
        ownership_column, on_submit_rpc, review_intro_text,
        lock_on_submit, precondition_rpc
    ) VALUES (
        p_guided_form_key, p_description, p_parent_table,
        p_ownership_column, p_on_submit_rpc, p_review_intro_text,
        p_lock_on_submit, p_precondition_rpc
    );

    -- Auto-register step zero (__parent__)
    INSERT INTO metadata.guided_form_steps (
        guided_form_key, step_key, display_name, step_table,
        parent_fk_column, step_order, can_skip
    ) VALUES (
        p_guided_form_key, '__parent__', COALESCE(p_parent_step_display_name, 'Application Details'),
        p_parent_table, NULL, 0, FALSE
    );

    -- Update parent entity metadata
    UPDATE metadata.entities
       SET guided_form_key = p_guided_form_key
     WHERE table_name = p_parent_table;

    -- If lock_on_submit, create submitted-guided form lock trigger on parent
    IF p_lock_on_submit THEN
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_block_submitted_update ON %I; '
            'CREATE TRIGGER trg_block_submitted_update '
            'BEFORE UPDATE ON %I FOR EACH ROW '
            'EXECUTE FUNCTION metadata.block_submitted_update();',
            p_parent_table, p_parent_table
        );
    END IF;

    -- Create condition-field lock trigger on parent
    EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_guided_form_lock ON %I; '
        'CREATE TRIGGER trg_guided_form_lock '
        'BEFORE UPDATE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION metadata.enforce_guided_form_lock();',
        p_parent_table, p_parent_table
    );

    -- Create cascade delete trigger to clean up progress rows
    EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_cascade_gf_delete ON %I; '
        'CREATE TRIGGER trg_cascade_gf_delete '
        'BEFORE DELETE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION metadata.cascade_guided_form_delete();',
        p_parent_table, p_parent_table
    );

    -- Ensure CRUD permission entries exist for the parent table.
    -- Guided form child tables inherit their RBAC from the parent table.
    -- Integrators assign roles via set_role_permission or the Permissions UI.
    INSERT INTO metadata.permissions (table_name, permission)
    SELECT p_parent_table, p::metadata.permission
    FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
    ON CONFLICT (table_name, permission) DO NOTHING;

    -- Auto-create RLS policies on parent table when ownership is configured.
    -- Two tiers of access, additive (PostgreSQL ORs permissive policies):
    --   Tier 1 — Ownership: users control their own records via ownership_column
    --   Tier 2 — RBAC: per-operation blanket access for elevated roles
    -- Integrators assign RBAC via grant_guided_form_permissions() or Permissions UI.
    -- Typical grants: user role gets read+create; managers/admins get update+delete.
    IF p_ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_parent_table);

        -- === Tier 1: Ownership policies ===
        -- Owner can SELECT their own rows
        EXECUTE format(
            'CREATE POLICY gf_owner_select ON public.%I FOR SELECT TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );

        -- Owner can UPDATE their own rows
        EXECUTE format(
            'CREATE POLICY gf_owner_update ON public.%I FOR UPDATE TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );

        -- Owner can DELETE their own rows
        EXECUTE format(
            'CREATE POLICY gf_owner_delete ON public.%I FOR DELETE TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );

        -- Any authenticated user can INSERT (start a new guided form)
        EXECUTE format(
            'CREATE POLICY gf_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (true)',
            p_parent_table
        );

        -- === Tier 2: RBAC per-operation blanket access ===
        -- Each permission grants blanket access for that operation to ALL rows.
        -- read = see all rows; update = edit all rows (+ bypasses lock triggers); delete = delete all rows
        EXECUTE format(
            'CREATE POLICY gf_rbac_select ON public.%I FOR SELECT TO authenticated USING (public.has_permission(%L, ''read''))',
            p_parent_table, p_parent_table::TEXT
        );

        EXECUTE format(
            'CREATE POLICY gf_rbac_update ON public.%I FOR UPDATE TO authenticated USING (public.has_permission(%L, ''update''))',
            p_parent_table, p_parent_table::TEXT
        );

        EXECUTE format(
            'CREATE POLICY gf_rbac_delete ON public.%I FOR DELETE TO authenticated USING (public.has_permission(%L, ''delete''))',
            p_parent_table, p_parent_table::TEXT
        );

        -- Hide ownership column from UI
        INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
        VALUES (p_parent_table, p_ownership_column, false, false, false, false)
        ON CONFLICT (table_name, column_name) DO UPDATE
          SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;
    END IF;

    RETURN jsonb_build_object('success', true, 'guided_form_key', p_guided_form_key);
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s already exists', p_guided_form_key));
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME) TO authenticated;

COMMENT ON FUNCTION public.register_guided_form(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, BOOLEAN, NAME, NAME) IS
    'Register a new guided form definition with auto step-zero and ownership RLS. SECURITY DEFINER for trigger/RLS creation. Added in v0.48.0.';


-- ============================================================================
-- 15. RPC: add_guided_form_step()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_guided_form_step(
    p_guided_form_key     NAME,
    p_step_key         NAME,
    p_display_name     VARCHAR(100),
    p_step_order       INT,
    p_step_table       NAME,
    p_parent_fk_column NAME,
    p_description      TEXT DEFAULT NULL,
    p_can_skip         BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form      metadata.guided_forms%ROWTYPE;
BEGIN
    -- Admin guard: only admins (or superusers running init scripts) can add guided form steps
    IF NOT (public.is_admin() OR current_setting('is_superuser', true) = 'on') THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s not found', p_guided_form_key));
    END IF;

    -- Auto-add status_id column on step table (internal, hidden from UI).
    -- Used by CHECK constraints via is_guided_form_draft(status_id) helper.
    EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS status_id INTEGER REFERENCES metadata.statuses(id) DEFAULT public.get_initial_status(''guided_form'')',
        p_step_table
    );
    -- Index on status_id for FK lookups and filtered queries
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_status_id ON public.%I (status_id)', p_step_table, p_step_table);

    INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
    VALUES (p_step_table, 'status_id', false, false, false, false)
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

    INSERT INTO metadata.guided_form_steps (
        guided_form_key, step_key, display_name, description,
        step_table, parent_fk_column, step_order, can_skip
    ) VALUES (
        p_guided_form_key, p_step_key, p_display_name, p_description,
        p_step_table, p_parent_fk_column, p_step_order, p_can_skip
    );

    -- Upgrade FK constraint to ON DELETE CASCADE so deleting the parent
    -- automatically removes child step rows (no orphans).
    DECLARE
        v_fk_name TEXT;
    BEGIN
        SELECT conname INTO v_fk_name
        FROM pg_constraint
        WHERE conrelid = format('public.%I', p_step_table)::regclass
          AND confrelid = format('public.%I', v_guided_form.parent_table)::regclass
          AND contype = 'f';

        IF v_fk_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
                p_step_table, v_fk_name);
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE CASCADE',
                p_step_table, v_fk_name, p_parent_fk_column, v_guided_form.parent_table);
        END IF;
    END;

    -- Hide step table from sidebar
    INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar, guided_form_key)
    VALUES (p_step_table, p_display_name, FALSE, p_guided_form_key)
    ON CONFLICT (table_name) DO UPDATE SET
        show_in_sidebar = FALSE,
        guided_form_key = p_guided_form_key;

    -- Auto-create RLS policies on child table when parent has ownership configured.
    -- Two tiers, mirroring parent:
    --   Tier 1 — Ownership: delegates to parent ownership for write access
    --   Tier 2 — RBAC: per-operation blanket access using parent table permissions
    IF v_guided_form.ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_step_table);

        -- === Tier 1: Ownership delegation ===
        -- SELECT delegates to parent visibility: child is visible if parent row is visible
        EXECUTE format(
            'CREATE POLICY gf_child_select ON public.%I FOR SELECT TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column
        );

        -- Owner can INSERT child rows if they own the parent
        EXECUTE format(
            'CREATE POLICY gf_child_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );

        -- Owner can UPDATE child rows if they own the parent
        EXECUTE format(
            'CREATE POLICY gf_child_update ON public.%I FOR UPDATE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );

        -- Owner can DELETE child rows if they own the parent
        EXECUTE format(
            'CREATE POLICY gf_child_delete ON public.%I FOR DELETE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );

        -- === Tier 2: RBAC per-operation blanket access (inherits parent table permissions) ===
        -- read on parent = see all child rows
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_select ON public.%I FOR SELECT TO authenticated '
            'USING (public.has_permission(%L, ''read''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );

        -- update on parent = create/edit any child row
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (public.has_permission(%L, ''update''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );

        EXECUTE format(
            'CREATE POLICY gf_child_rbac_update ON public.%I FOR UPDATE TO authenticated '
            'USING (public.has_permission(%L, ''update''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );

        -- delete on parent = delete any child row
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_delete ON public.%I FOR DELETE TO authenticated '
            'USING (public.has_permission(%L, ''delete''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'step_key', p_step_key);
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'message', format('Step %s already exists in guided form %s', p_step_key, p_guided_form_key));
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.add_guided_form_step(NAME, NAME, VARCHAR, INT, NAME, NAME, TEXT, BOOLEAN) IS
    'Add a step to a guided form definition with auto child RLS delegation. SECURITY DEFINER for RLS creation. Added in v0.48.0.';


-- ============================================================================
-- 16. RPC: add_guided_form_step_condition()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_guided_form_step_condition(
    p_guided_form_key     NAME,
    p_step_key         NAME,
    p_condition_type   TEXT,
    p_field            NAME,
    p_operator         TEXT,
    p_value            TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_step_id INT;
BEGIN
    SELECT id INTO v_step_id
    FROM metadata.guided_form_steps
    WHERE guided_form_key = p_guided_form_key AND step_key = p_step_key;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Step %s not found in guided form %s', p_step_key, p_guided_form_key));
    END IF;

    -- Step zero cannot have conditions
    IF p_step_key = '__parent__' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Cannot add conditions to step zero (parent)');
    END IF;

    INSERT INTO metadata.guided_form_step_conditions (
        guided_form_step_id, condition_type, field, operator, value
    ) VALUES (v_step_id, p_condition_type, p_field, p_operator, p_value);

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_guided_form_step_condition(NAME, NAME, TEXT, NAME, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_guided_form_step_condition(NAME, NAME, TEXT, NAME, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.add_guided_form_step_condition(NAME, NAME, TEXT, NAME, TEXT, TEXT) IS
    'Add a skip_if or require_if condition to a guided form step. Added in v0.48.0.';


-- ============================================================================
-- 17. RPC: start_guided_form()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.start_guided_form(p_guided_form_key NAME)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form metadata.guided_forms%ROWTYPE;
    v_new_id   BIGINT;
    v_result   JSONB;
BEGIN
    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND OR NOT v_guided_form.is_enabled THEN
        RAISE EXCEPTION 'Unknown or disabled guided form' USING ERRCODE = 'P0001';
    END IF;

    -- Optional precondition check
    IF v_guided_form.precondition_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_guided_form.precondition_rpc)
        INTO v_result USING p_guided_form_key;
        IF v_result IS NOT NULL AND (v_result->>'success')::boolean = false THEN
            RAISE EXCEPTION '%', v_result->>'message' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- Explicitly set ownership column so RLS policies grant access to the creator.
    -- Without this, DEFAULT VALUES leaves ownership_column NULL and the owner
    -- cannot see their own record through gf_owner_select.
    IF v_guided_form.ownership_column IS NOT NULL THEN
        EXECUTE format(
            'INSERT INTO public.%I (%I) VALUES (current_user_id()) RETURNING id',
            v_guided_form.parent_table, v_guided_form.ownership_column
        ) INTO v_new_id;
    ELSE
        EXECUTE format(
            'INSERT INTO public.%I DEFAULT VALUES RETURNING id',
            v_guided_form.parent_table
        ) INTO v_new_id;
    END IF;

    RETURN jsonb_build_object(
        'parent_id', v_new_id
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_guided_form(NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_guided_form(NAME) TO authenticated;

COMMENT ON FUNCTION public.start_guided_form(NAME) IS
    'Create a new guided form instance (bare parent row). Added in v0.48.0.';


-- ============================================================================
-- 18. RPC: complete_guided_form_step()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_guided_form_step(
    p_guided_form_key NAME,
    p_parent_id    BIGINT,
    p_step_key     NAME
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_step           metadata.guided_form_steps%ROWTYPE;
    v_all_complete   BOOLEAN;
    v_parent_table   NAME;
    v_auto_submit    BOOLEAN;
    v_submit_result  JSONB;
    v_next_step      RECORD;
    v_next_result    JSONB;
    v_parent_json    JSONB;
    v_condition_met  BOOLEAN;
    v_condition      RECORD;
    v_field_value    TEXT;
BEGIN
    -- ── STATUS MODEL ──────────────────────────────────────────────────
    -- Parent row's status_id = form lifecycle (draft → complete → submitted).
    -- Step completion is tracked in guided_form_progress for ALL steps,
    -- including step zero.  Only steps 1-N get a step-level status_id
    -- update (on their own table).  The parent's status_id advances
    -- forward only — never reverts from complete to draft.
    -- ──────────────────────────────────────────────────────────────────

    SELECT * INTO v_step
    FROM metadata.guided_form_steps
    WHERE guided_form_key = p_guided_form_key AND step_key = p_step_key;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Step % not found', p_step_key USING ERRCODE = 'P0001';
    END IF;

    -- STEP DATA STATUS: mark step data as validated.
    -- Step zero skipped — parent status_id is the form lifecycle, not step data.
    -- Step zero completion is recorded in guided_form_progress below.
    IF v_step.parent_fk_column IS NOT NULL THEN
        -- Steps 1-N: update the step table's own status_id
        EXECUTE format(
            'UPDATE public.%I SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type = ''guided_form'' AND status_key = ''complete'') WHERE %I = $1',
            v_step.step_table, v_step.parent_fk_column
        ) USING p_parent_id;
    END IF;

    -- PROGRESS TRACKING: record step completion (all steps including step zero)
    INSERT INTO metadata.guided_form_progress (guided_form_key, parent_id, step_key, completed_by)
    VALUES (p_guided_form_key, p_parent_id, p_step_key, public.current_user_id())
    ON CONFLICT (guided_form_key, parent_id, step_key) DO UPDATE SET
        completed_at = NOW(),
        completed_by = public.current_user_id();

    -- ── FIND NEXT STEP FIRST ─────────────────────────────────────────
    -- Before checking overall completion, look for the next non-skipped,
    -- incomplete step.  This ensures can_skip steps are still offered to
    -- the user rather than silently treated as "done".
    -- ──────────────────────────────────────────────────────────────────

    -- Load parent record as JSONB for condition evaluation
    SELECT parent_table INTO v_parent_table
    FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;

    EXECUTE format(
        'SELECT to_jsonb(t.*) FROM public.%I t WHERE t.id = $1',
        v_parent_table
    ) INTO v_parent_json USING p_parent_id;

    FOR v_next_step IN
        SELECT * FROM metadata.guided_form_steps
        WHERE guided_form_key = p_guided_form_key
          AND step_key != '__parent__'
          AND step_order > v_step.step_order
        ORDER BY step_order
    LOOP
        -- Evaluate skip_if conditions for this candidate step
        v_condition_met := FALSE;
        FOR v_condition IN
            SELECT * FROM metadata.guided_form_step_conditions
            WHERE guided_form_step_id = v_next_step.id AND condition_type = 'skip_if'
            ORDER BY sort_order
        LOOP
            v_field_value := v_parent_json->>v_condition.field;
            CASE v_condition.operator
                WHEN 'eq' THEN
                    IF v_field_value = v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'neq' THEN
                    IF v_field_value != v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'is_null' THEN
                    IF v_field_value IS NULL THEN v_condition_met := TRUE; END IF;
                WHEN 'is_not_null' THEN
                    IF v_field_value IS NOT NULL THEN v_condition_met := TRUE; END IF;
            END CASE;
        END LOOP;

        IF v_condition_met THEN
            CONTINUE; -- Skip this step, try next
        END IF;

        -- Check if this step already has progress (already completed)
        IF EXISTS(
            SELECT 1 FROM metadata.guided_form_progress
            WHERE guided_form_key = p_guided_form_key AND parent_id = p_parent_id AND step_key = v_next_step.step_key
        ) THEN
            CONTINUE; -- Already complete, try next
        END IF;

        -- Found the next non-skipped, incomplete step — ensure its draft record
        v_next_result := public.ensure_guided_form_step_record(p_guided_form_key, p_parent_id, v_next_step.step_key);

        RETURN jsonb_build_object(
            'all_data_steps_complete', false,
            'next_step_key', v_next_step.step_key,
            'next_step_table', v_next_step.step_table,
            'next_record_id', (v_next_result->>'record_id')::bigint
        );
    END LOOP;

    -- ── NO MORE INCOMPLETE STEPS ─────────────────────────────────────
    -- All remaining steps are either completed or condition-skipped.
    -- Check formal completion and handle lifecycle transitions.
    -- ──────────────────────────────────────────────────────────────────

    SELECT public._check_guided_form_complete(p_guided_form_key, p_parent_id) INTO v_all_complete;

    IF v_all_complete THEN
        EXECUTE format(
            'UPDATE public.%I SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type = ''guided_form'' AND status_key = ''complete'') WHERE id = $1',
            v_parent_table
        ) USING p_parent_id;

        -- Auto-submit if flag is set and ALL non-parent steps were condition-skipped
        SELECT auto_submit_on_all_skipped INTO v_auto_submit
        FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;

        IF v_auto_submit AND public._all_steps_condition_skipped(p_guided_form_key, p_parent_id) THEN
            v_submit_result := public.submit_guided_form(p_guided_form_key, p_parent_id);
            RETURN v_submit_result || jsonb_build_object(
                'all_data_steps_complete', true,
                'auto_submitted', true
            );
        END IF;

        RETURN jsonb_build_object(
            'all_data_steps_complete', true
        );
    END IF;

    -- Edge case: no next step found but not all complete
    RETURN jsonb_build_object(
        'all_data_steps_complete', false
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_guided_form_step(NAME, BIGINT, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_guided_form_step(NAME, BIGINT, NAME) TO authenticated;

COMMENT ON FUNCTION public.complete_guided_form_step(NAME, BIGINT, NAME) IS
    'Mark a guided form step as complete. Steps 1-N get a step-level status_id update; '
    'step zero completion is recorded in guided_form_progress only (parent status_id is the '
    'form lifecycle, not step data). Advances parent to complete when all steps are done. '
    'Added in v0.48.0.';


-- ============================================================================
-- 19. RPC: _check_guided_form_complete()
-- ============================================================================

CREATE OR REPLACE FUNCTION public._check_guided_form_complete(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_step         RECORD;
    v_parent_json  JSONB;
    v_has_progress BOOLEAN;
    v_condition_met BOOLEAN;
    v_condition    RECORD;
    v_field_value  TEXT;
BEGIN
    -- Load parent record as JSONB for dynamic field access
    -- (RECORD types cannot be decomposed dynamically via EXECUTE/USING)
    EXECUTE format(
        'SELECT to_jsonb(t.*) FROM public.%I t WHERE t.id = $1',
        (SELECT parent_table FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key)
    ) INTO v_parent_json USING p_parent_id;

    IF v_parent_json IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Check each step
    FOR v_step IN
        SELECT * FROM metadata.guided_form_steps
        WHERE guided_form_key = p_guided_form_key AND step_key != '__parent__'
        ORDER BY step_order
    LOOP
        -- Evaluate skip conditions
        v_condition_met := FALSE;
        FOR v_condition IN
            SELECT * FROM metadata.guided_form_step_conditions
            WHERE guided_form_step_id = v_step.id AND condition_type = 'skip_if'
            ORDER BY sort_order
        LOOP
            v_field_value := v_parent_json->>v_condition.field;

            CASE v_condition.operator
                WHEN 'eq' THEN
                    IF v_field_value = v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'neq' THEN
                    IF v_field_value != v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'is_null' THEN
                    IF v_field_value IS NULL THEN v_condition_met := TRUE; END IF;
                WHEN 'is_not_null' THEN
                    IF v_field_value IS NOT NULL THEN v_condition_met := TRUE; END IF;
            END CASE;
        END LOOP;

        IF v_condition_met THEN
            CONTINUE; -- Step is skipped, doesn't need to be complete
        END IF;

        -- Evaluate require_if conditions (override can_skip)
        FOR v_condition IN
            SELECT * FROM metadata.guided_form_step_conditions
            WHERE guided_form_step_id = v_step.id AND condition_type = 'require_if'
            ORDER BY sort_order
        LOOP
            v_field_value := v_parent_json->>v_condition.field;

            CASE v_condition.operator
                WHEN 'eq' THEN
                    IF v_field_value = v_condition.value THEN v_step.can_skip := FALSE; END IF;
                WHEN 'neq' THEN
                    IF v_field_value != v_condition.value THEN v_step.can_skip := FALSE; END IF;
                WHEN 'is_null' THEN
                    IF v_field_value IS NULL THEN v_step.can_skip := FALSE; END IF;
                WHEN 'is_not_null' THEN
                    IF v_field_value IS NOT NULL THEN v_step.can_skip := FALSE; END IF;
            END CASE;
        END LOOP;

        -- Check if step has progress
        SELECT EXISTS(
            SELECT 1 FROM metadata.guided_form_progress
            WHERE guided_form_key = p_guided_form_key AND parent_id = p_parent_id AND step_key = v_step.step_key
        ) INTO v_has_progress;

        IF NOT v_has_progress AND NOT v_step.can_skip THEN
            RETURN FALSE; -- Required step is incomplete
        END IF;
    END LOOP;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public._check_guided_form_complete(NAME, BIGINT) IS
    'Internal: checks if all required steps are complete for a guided form instance. Added in v0.48.0.';


-- ============================================================================
-- 19b. RPC: _all_steps_condition_skipped()
-- ============================================================================
-- Returns TRUE when EVERY non-parent step has a skip_if condition that matches
-- the current parent data. Used by complete_guided_form_step() to decide
-- whether to auto-submit when auto_submit_on_all_skipped is enabled.

CREATE OR REPLACE FUNCTION public._all_steps_condition_skipped(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_step         RECORD;
    v_parent_json  JSONB;
    v_condition_met BOOLEAN;
    v_condition    RECORD;
    v_field_value  TEXT;
    v_has_any_step BOOLEAN := FALSE;
BEGIN
    -- Load parent record as JSONB for dynamic field access
    EXECUTE format(
        'SELECT to_jsonb(t.*) FROM public.%I t WHERE t.id = $1',
        (SELECT parent_table FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key)
    ) INTO v_parent_json USING p_parent_id;

    IF v_parent_json IS NULL THEN
        RETURN FALSE;
    END IF;

    FOR v_step IN
        SELECT * FROM metadata.guided_form_steps
        WHERE guided_form_key = p_guided_form_key AND step_key != '__parent__'
        ORDER BY step_order
    LOOP
        v_has_any_step := TRUE;

        -- Check if this step has a matching skip_if condition
        v_condition_met := FALSE;
        FOR v_condition IN
            SELECT * FROM metadata.guided_form_step_conditions
            WHERE guided_form_step_id = v_step.id AND condition_type = 'skip_if'
            ORDER BY sort_order
        LOOP
            v_field_value := v_parent_json->>v_condition.field;

            CASE v_condition.operator
                WHEN 'eq' THEN
                    IF v_field_value = v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'neq' THEN
                    IF v_field_value != v_condition.value THEN v_condition_met := TRUE; END IF;
                WHEN 'is_null' THEN
                    IF v_field_value IS NULL THEN v_condition_met := TRUE; END IF;
                WHEN 'is_not_null' THEN
                    IF v_field_value IS NOT NULL THEN v_condition_met := TRUE; END IF;
            END CASE;
        END LOOP;

        -- If ANY step does NOT have a matching skip_if, not all are skipped
        IF NOT v_condition_met THEN
            RETURN FALSE;
        END IF;
    END LOOP;

    -- Must have at least one non-parent step to auto-submit
    RETURN v_has_any_step;
END;
$$;

COMMENT ON FUNCTION public._all_steps_condition_skipped(NAME, BIGINT) IS
    'Internal: returns TRUE when every non-parent step is condition-skipped. Used for auto_submit_on_all_skipped. Added in v0.48.0.';


-- ============================================================================
-- 20. RPC: submit_guided_form()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_guided_form(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form metadata.guided_forms%ROWTYPE;
    v_result   JSONB;
BEGIN
    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown guided form' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public._check_guided_form_complete(p_guided_form_key, p_parent_id) THEN
        RAISE EXCEPTION 'Guided form has incomplete required steps' USING ERRCODE = 'P0001';
    END IF;

    -- Call on_submit_rpc BEFORE locking so it can modify the parent record.
    -- If it fails, the transaction rolls back and the guided form remains unsubmitted.
    IF v_guided_form.on_submit_rpc IS NOT NULL THEN
        EXECUTE format('SELECT public.%I($1)', v_guided_form.on_submit_rpc)
            INTO v_result USING p_parent_id;
        IF v_result IS NOT NULL AND (v_result->>'success')::boolean = false THEN
            RAISE EXCEPTION '%', v_result->>'message' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- Mark parent as submitted (triggers block_submitted_update lock)
    EXECUTE format(
        'UPDATE public.%I SET submitted_at = NOW(), status_id = (SELECT id FROM metadata.statuses WHERE entity_type = ''guided_form'' AND status_key = ''submitted'') WHERE id = $1',
        v_guided_form.parent_table
    ) USING p_parent_id;

    -- Mark progress as submitted
    UPDATE metadata.guided_form_progress
       SET submitted_at = NOW()
     WHERE guided_form_key = p_guided_form_key
       AND parent_id    = p_parent_id
       AND step_key     = '__parent__';

    -- Forward navigate_to from on_submit_rpc if it provided one.
    RETURN jsonb_build_object(
        'navigate_to', COALESCE(v_result->>'navigate_to', '')
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_guided_form(NAME, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_guided_form(NAME, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.submit_guided_form(NAME, BIGINT) IS
    'Submit a completed guided form. Sets submitted_at, calls on_submit_rpc. Added in v0.48.0.';


-- ============================================================================
-- 21. RPC: cancel_guided_form()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_guided_form(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form metadata.guided_forms%ROWTYPE;
BEGIN
    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown guided form' USING ERRCODE = 'P0001';
    END IF;

    DELETE FROM metadata.guided_form_progress
    WHERE guided_form_key = p_guided_form_key AND parent_id = p_parent_id;

    EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_guided_form.parent_table)
    USING p_parent_id;

    RETURN jsonb_build_object('cancelled', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_guided_form(NAME, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_guided_form(NAME, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.cancel_guided_form(NAME, BIGINT) IS
    'Cancel a guided form instance. Deletes progress and parent (cascades to steps). Added in v0.48.0.';


-- ============================================================================
-- 22. RPC: get_guided_form_progress()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_guided_form_progress(
    p_guided_form_key NAME,
    p_parent_id    BIGINT
)
RETURNS TABLE(
    id          BIGINT,
    guided_form_key NAME,
    parent_id   BIGINT,
    step_key    NAME,
    completed_at TIMESTAMPTZ,
    completed_by UUID,
    submitted_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
    RETURN QUERY
    SELECT wp.id, wp.guided_form_key, wp.parent_id, wp.step_key,
           wp.completed_at, wp.completed_by, wp.submitted_at, wp.created_at
    FROM metadata.guided_form_progress wp
    WHERE wp.guided_form_key = p_guided_form_key
      AND wp.parent_id = p_parent_id
      AND (
          public.is_admin()
          OR wp.completed_by = public.current_user_id()
          OR public.has_permission(
              (SELECT parent_table FROM metadata.guided_forms gf WHERE gf.guided_form_key = wp.guided_form_key),
              'read'
          )
      )
    ORDER BY wp.created_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_guided_form_progress(NAME, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guided_form_progress(NAME, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.get_guided_form_progress(NAME, BIGINT) IS
    'Get completion progress for a guided form instance. '
    'Cascading visibility: admin > owner > table read permission. Added in v0.48.0.';


-- ============================================================================
-- 23. RPC: rebuild_guided_form_triggers()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rebuild_guided_form_triggers()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_guided_form RECORD;
    v_count INT := 0;
BEGIN
    FOR v_guided_form IN
        SELECT * FROM metadata.guided_forms WHERE is_enabled = TRUE
    LOOP
        -- Recreate condition-field lock trigger
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_guided_form_lock ON %I; '
            'CREATE TRIGGER trg_guided_form_lock '
            'BEFORE UPDATE ON %I FOR EACH ROW '
            'EXECUTE FUNCTION metadata.enforce_guided_form_lock();',
            v_guided_form.parent_table, v_guided_form.parent_table
        );

        -- Recreate submitted lock trigger if lock_on_submit
        IF v_guided_form.lock_on_submit THEN
            EXECUTE format(
                'DROP TRIGGER IF EXISTS trg_block_submitted_update ON %I; '
                'CREATE TRIGGER trg_block_submitted_update '
                'BEFORE UPDATE ON %I FOR EACH ROW '
                'EXECUTE FUNCTION metadata.block_submitted_update();',
                v_guided_form.parent_table, v_guided_form.parent_table
            );
        ELSE
            EXECUTE format(
                'DROP TRIGGER IF EXISTS trg_block_submitted_update ON %I;',
                v_guided_form.parent_table
            );
        END IF;

        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'triggers_rebuilt', v_count);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rebuild_guided_form_triggers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_guided_form_triggers() TO authenticated;

COMMENT ON FUNCTION public.rebuild_guided_form_triggers() IS
    'Idempotently rebuild all guided form lock triggers. Call after schema changes or guided form updates. Added in v0.48.0.';


-- ============================================================================
-- 24. RPC: grant_guided_form_permissions()
-- ============================================================================
-- Convenience helper: assigns a role to one or more CRUD permissions on a
-- guided form's parent table. Child step tables inherit RBAC from the parent,
-- so only the parent table needs permission entries.

CREATE OR REPLACE FUNCTION public.grant_guided_form_permissions(
    p_guided_form_key NAME,
    p_role_id         INTEGER,
    p_permissions     TEXT[] DEFAULT ARRAY['read', 'create', 'update', 'delete']
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_parent_table NAME;
    v_perm         TEXT;
    v_permission_id INTEGER;
    v_assigned     INT := 0;
    v_skipped      INT := 0;
BEGIN
    -- Admin guard: only admins (or database superusers running init scripts) can grant guided form permissions
    IF NOT (public.is_admin() OR current_setting('is_superuser', true) = 'on') THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    SELECT parent_table INTO v_parent_table
    FROM metadata.guided_forms
    WHERE guided_form_key = p_guided_form_key;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s not found', p_guided_form_key));
    END IF;

    FOREACH v_perm IN ARRAY p_permissions
    LOOP
        SELECT id INTO v_permission_id
        FROM metadata.permissions
        WHERE table_name = v_parent_table AND permission::TEXT = v_perm;

        IF v_permission_id IS NOT NULL THEN
            INSERT INTO metadata.permission_roles (permission_id, role_id)
            VALUES (v_permission_id, p_role_id)
            ON CONFLICT (permission_id, role_id) DO NOTHING;

            IF FOUND THEN
                v_assigned := v_assigned + 1;
            ELSE
                v_skipped := v_skipped + 1;
            END IF;
        ELSE
            v_skipped := v_skipped + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'parent_table', v_parent_table,
        'assigned', v_assigned,
        'skipped', v_skipped
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.grant_guided_form_permissions(NAME, INTEGER, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_guided_form_permissions(NAME, INTEGER, TEXT[]) TO authenticated;

COMMENT ON FUNCTION public.grant_guided_form_permissions(NAME, INTEGER, TEXT[]) IS
    'Assign CRUD permissions on a guided form parent table to a role. '
    'Child step tables inherit RBAC from the parent. Added in v0.48.0.';


-- ============================================================================
-- 25. UPDATE upsert_entity_metadata() — add show_in_sidebar parameter
-- ============================================================================

DROP FUNCTION IF EXISTS public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL,
  p_show_calendar BOOLEAN DEFAULT FALSE,
  p_calendar_property_name TEXT DEFAULT NULL,
  p_calendar_color_property TEXT DEFAULT NULL,
  p_enable_notes BOOLEAN DEFAULT FALSE,
  p_supports_recurring BOOLEAN DEFAULT FALSE,
  p_recurring_property_name TEXT DEFAULT NULL,
  p_show_in_sidebar BOOLEAN DEFAULT TRUE
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the entity metadata
  INSERT INTO metadata.entities (
    table_name,
    display_name,
    description,
    sort_order,
    search_fields,
    show_map,
    map_property_name,
    show_calendar,
    calendar_property_name,
    calendar_color_property,
    enable_notes,
    supports_recurring,
    recurring_property_name,
    show_in_sidebar
  )
  VALUES (
    p_table_name,
    p_display_name,
    p_description,
    p_sort_order,
    p_search_fields,
    p_show_map,
    p_map_property_name,
    p_show_calendar,
    p_calendar_property_name,
    p_calendar_color_property,
    p_enable_notes,
    p_supports_recurring,
    p_recurring_property_name,
    p_show_in_sidebar
  )
  ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
    show_map = EXCLUDED.show_map,
    map_property_name = EXCLUDED.map_property_name,
    show_calendar = EXCLUDED.show_calendar,
    calendar_property_name = EXCLUDED.calendar_property_name,
    calendar_color_property = EXCLUDED.calendar_color_property,
    enable_notes = EXCLUDED.enable_notes,
    supports_recurring = EXCLUDED.supports_recurring,
    recurring_property_name = EXCLUDED.recurring_property_name,
    show_in_sidebar = EXCLUDED.show_in_sidebar;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.upsert_entity_metadata IS
  'Insert or update entity metadata. Admin only. Updated in v0.48.0 to add show_in_sidebar.';

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, BOOLEAN) TO authenticated;


-- ============================================================================
-- 26. RPC: ensure_guided_form_step_record()
-- ============================================================================
-- Idempotently ensures a step record exists for a given guided form step.
-- If step zero → returns parent_id directly (no child table).
-- If step 1-N → looks up existing record; creates a draft row if missing.
-- Used by the frontend to replace /create navigation with /edit navigation.

CREATE OR REPLACE FUNCTION public.ensure_guided_form_step_record(
    p_guided_form_key NAME,
    p_parent_id       BIGINT,
    p_step_key        NAME
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_step       RECORD;
    v_record_id  BIGINT;
BEGIN
    -- Look up the step definition
    SELECT * INTO v_step
    FROM metadata.guided_form_steps
    WHERE guided_form_key = p_guided_form_key AND step_key = p_step_key;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Step % not found in guided form %', p_step_key, p_guided_form_key USING ERRCODE = 'P0001';
    END IF;

    -- Step zero (parent table): no child record needed
    IF v_step.parent_fk_column IS NULL THEN
        RETURN jsonb_build_object('record_id', p_parent_id, 'created', false);
    END IF;

    -- Check for existing record in the step table
    EXECUTE format(
        'SELECT id FROM public.%I WHERE %I = $1 LIMIT 1',
        v_step.step_table, v_step.parent_fk_column
    ) INTO v_record_id USING p_parent_id;

    IF v_record_id IS NOT NULL THEN
        RETURN jsonb_build_object('record_id', v_record_id, 'created', false);
    END IF;

    -- Create a draft record with only the FK column populated
    -- status_id defaults to get_initial_status('guided_form') = draft
    -- created_by defaults to current_user_id() if column exists
    EXECUTE format(
        'INSERT INTO public.%I (%I) VALUES ($1) RETURNING id',
        v_step.step_table, v_step.parent_fk_column
    ) INTO v_record_id USING p_parent_id;

    RETURN jsonb_build_object('record_id', v_record_id, 'created', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_guided_form_step_record(NAME, BIGINT, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_guided_form_step_record(NAME, BIGINT, NAME) TO authenticated;

COMMENT ON FUNCTION public.ensure_guided_form_step_record(NAME, BIGINT, NAME) IS
    'Idempotently ensure a draft step record exists. Returns {record_id, created}. '
    'Used by frontend and complete_guided_form_step() to implement draft-first edit flow for guided form steps 1-N. Added in v0.48.0.';


-- ============================================================================
-- 28. RPC: get_statuses_for_entity() — add status_key to return type
-- ============================================================================
-- v0.48.0: Frontend needs status_key to resolve status_id → logical key
-- (e.g., 'draft', 'complete', 'submitted') for guided form button logic.
-- Must DROP first because return type is changing (adding status_key column).

DROP FUNCTION IF EXISTS public.get_statuses_for_entity(TEXT);

CREATE FUNCTION public.get_statuses_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT,
  is_initial BOOLEAN,
  is_terminal BOOLEAN,
  status_key VARCHAR(50)
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name, description, color, sort_order, is_initial, is_terminal, status_key
  FROM metadata.statuses
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

COMMENT ON FUNCTION public.get_statuses_for_entity(TEXT) IS
  'Returns all status values for a given entity_type, ordered by sort_order. '
  'Updated in v0.48.0 to include status_key for programmatic lookups.';


-- ============================================================================
-- 29. RPC: get_guided_form_context()
-- ============================================================================
-- Single-call context loader for the frontend.  Returns everything needed to
-- render a guided form page (definition, steps, progress, parent status,
-- parent/child relationship, step record IDs) in one round-trip.
--
-- Parameters:
--   p_guided_form_key  — the guided form key
--   p_table_name       — the table the user is currently viewing/editing
--   p_record_id        — the record ID in that table
--
-- Uses SECURITY INVOKER so RLS on instance tables applies automatically.
-- Dynamic SQL is required because table names come from metadata.

CREATE OR REPLACE FUNCTION public.get_guided_form_context(
    p_guided_form_key  NAME,
    p_table_name       NAME,
    p_record_id        BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_def            RECORD;
    v_steps          JSONB;
    v_progress       JSONB;
    v_status_options JSONB;
    v_parent_id      BIGINT;
    v_record_id      BIGINT := p_record_id;
    v_is_child_step  BOOLEAN := FALSE;
    v_step_key       NAME := NULL;
    v_parent_status_id   INTEGER;
    v_parent_status_key  TEXT;
    v_step_record_ids    JSONB := '{}'::JSONB;
    v_step              RECORD;
    v_fk_col            NAME;
    v_found_id          BIGINT;
BEGIN
    -- 1. Look up the guided form definition
    SELECT * INTO v_def
    FROM metadata.guided_forms
    WHERE guided_form_key = p_guided_form_key;

    IF v_def IS NULL THEN
        RETURN NULL;
    END IF;

    -- 2. Determine if p_table_name is the parent table or a child step table
    IF p_table_name = v_def.parent_table THEN
        -- Parent table: record_id IS the parent_id
        v_parent_id := p_record_id;
        v_is_child_step := FALSE;
    ELSE
        -- Child step table: find the FK column and resolve parent_id
        SELECT gfs.parent_fk_column, gfs.step_key
        INTO v_fk_col, v_step_key
        FROM metadata.guided_form_steps gfs
        WHERE gfs.guided_form_key = p_guided_form_key
          AND gfs.step_table = p_table_name
          AND gfs.parent_fk_column IS NOT NULL
        LIMIT 1;

        IF v_fk_col IS NULL THEN
            -- Table not found as a step — return null
            RETURN NULL;
        END IF;

        v_is_child_step := TRUE;

        -- Resolve parent_id from the FK column on the child record
        EXECUTE format(
            'SELECT %I FROM %I WHERE id = $1',
            v_fk_col, p_table_name
        ) INTO v_parent_id USING p_record_id;

        IF v_parent_id IS NULL THEN
            RETURN NULL;
        END IF;
    END IF;

    -- 3. Fetch steps with embedded conditions
    SELECT COALESCE(jsonb_agg(step_row ORDER BY step_row->>'step_order'), '[]'::JSONB)
    INTO v_steps
    FROM (
        SELECT jsonb_build_object(
            'id', gfs.id,
            'guided_form_key', gfs.guided_form_key,
            'step_key', gfs.step_key,
            'display_name', gfs.display_name,
            'description', gfs.description,
            'step_table', gfs.step_table,
            'parent_fk_column', gfs.parent_fk_column,
            'step_order', gfs.step_order,
            'can_skip', gfs.can_skip,
            'track_key', gfs.track_key,
            'conditions', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', c.id,
                    'condition_type', c.condition_type,
                    'field', c.field,
                    'operator', c.operator,
                    'value', c.value
                ))
                FROM metadata.guided_form_step_conditions c
                WHERE c.guided_form_step_id = gfs.id
            ), '[]'::JSONB)
        ) AS step_row
        FROM metadata.guided_form_steps gfs
        WHERE gfs.guided_form_key = p_guided_form_key
        ORDER BY gfs.step_order
    ) sub;

    -- 4. Fetch progress for the resolved parent_id
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', gfp.id,
        'guided_form_key', gfp.guided_form_key,
        'parent_id', gfp.parent_id,
        'step_key', gfp.step_key,
        'completed_at', gfp.completed_at,
        'completed_by', gfp.completed_by,
        'submitted_at', gfp.submitted_at,
        'created_at', gfp.created_at
    ) ORDER BY gfp.created_at), '[]'::JSONB)
    INTO v_progress
    FROM metadata.guided_form_progress gfp
    WHERE gfp.guided_form_key = p_guided_form_key
      AND gfp.parent_id = v_parent_id;

    -- 5. Fetch status options for this guided form's entity_type
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id,
        'status_key', s.status_key,
        'display_name', s.display_name,
        'color', s.color
    ) ORDER BY s.sort_order), '[]'::JSONB)
    INTO v_status_options
    FROM metadata.statuses s
    WHERE s.entity_type = 'guided_form';

    -- 6. Read status_id from the parent record via dynamic SQL
    BEGIN
        EXECUTE format(
            'SELECT status_id FROM %I WHERE id = $1',
            v_def.parent_table
        ) INTO v_parent_status_id USING v_parent_id;
    EXCEPTION WHEN undefined_column THEN
        v_parent_status_id := NULL;
    END;

    -- 7. Resolve status_key from status_id
    IF v_parent_status_id IS NOT NULL THEN
        SELECT s.status_key INTO v_parent_status_key
        FROM metadata.statuses s
        WHERE s.id = v_parent_status_id;
    END IF;

    -- 8. For each step, query for existing record IDs
    -- Add __parent__ entry
    v_step_record_ids := jsonb_build_object('__parent__', v_parent_id);

    FOR v_step IN
        SELECT gfs.step_key, gfs.step_table, gfs.parent_fk_column
        FROM metadata.guided_form_steps gfs
        WHERE gfs.guided_form_key = p_guided_form_key
          AND gfs.parent_fk_column IS NOT NULL
        ORDER BY gfs.step_order
    LOOP
        BEGIN
            EXECUTE format(
                'SELECT id FROM %I WHERE %I = $1 LIMIT 1',
                v_step.step_table, v_step.parent_fk_column
            ) INTO v_found_id USING v_parent_id;

            IF v_found_id IS NOT NULL THEN
                v_step_record_ids := v_step_record_ids || jsonb_build_object(v_step.step_key, v_found_id);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Step table may not exist yet or other error — skip silently
            NULL;
        END;
    END LOOP;

    -- 9. Build and return the full context
    RETURN jsonb_build_object(
        'definition', jsonb_build_object(
            'guided_form_key', v_def.guided_form_key,
            'description', v_def.description,
            'parent_table', v_def.parent_table,
            'ownership_column', v_def.ownership_column,
            'lock_on_submit', v_def.lock_on_submit,
            'on_submit_rpc', v_def.on_submit_rpc,
            'review_intro_text', v_def.review_intro_text,
            'precondition_rpc', v_def.precondition_rpc,
            'auto_submit_on_all_skipped', v_def.auto_submit_on_all_skipped,
            'is_enabled', v_def.is_enabled,
            'status_options', v_status_options
        ),
        'steps', v_steps,
        'progress', v_progress,
        'status_options', v_status_options,
        'parent_status_id', v_parent_status_id,
        'parent_status_key', v_parent_status_key,
        'parent_id', v_parent_id,
        'record_id', v_record_id,
        'is_child_step', v_is_child_step,
        'step_key', v_step_key,
        'step_record_ids', v_step_record_ids
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_guided_form_context(NAME, NAME, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guided_form_context(NAME, NAME, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.get_guided_form_context(NAME, NAME, BIGINT) IS
    'Returns full guided form context (definition, steps, progress, parent status, '
    'step record IDs) in a single call. Resolves parent/child relationships via '
    'dynamic SQL. SECURITY INVOKER — RLS applies. Added in v0.48.0.';


-- ============================================================================
-- 30. NOTIFY PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
