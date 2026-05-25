-- Revert v0-56-1-fix-managed-db-admin-guard
-- Restore original inline admin guard (is_admin() OR is_superuser) and drop helper.

BEGIN;

-- ============================================================================
-- 1. Restore register_guided_form() with original inline guard
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
    v_gf_col    NAME;
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

    -- Detect or create GF status column. Do NOT rename — init scripts may still reference status_id.
    v_gf_col := public._gf_status_col(p_parent_table);
    IF v_gf_col IS NULL THEN
        -- Neither column exists; add status_id for backward compat with init script trigger DDL
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN status_id INTEGER REFERENCES metadata.statuses(id)',
            p_parent_table
        );
        v_gf_col := 'status_id';
    END IF;
    -- Ensure DEFAULT is set
    EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT public.get_initial_status(''guided_form'')',
        p_parent_table, v_gf_col
    );
    -- Index for FK lookups and filtered queries
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_gf_status_id ON public.%I (%I)', p_parent_table, p_parent_table, v_gf_col);

    INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order,
        show_on_list, show_on_create, show_on_edit, show_on_detail, filterable, status_entity_type)
    VALUES (p_parent_table, v_gf_col, 'Form Status', -10,
        false, false, false, false, false, 'guided_form')
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET status_entity_type = 'guided_form',
          show_on_list = false, show_on_detail = false,
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
    INSERT INTO metadata.permissions (table_name, permission)
    SELECT p_parent_table, p::metadata.permission
    FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
    ON CONFLICT (table_name, permission) DO NOTHING;

    -- Auto-create RLS policies on parent table when ownership is configured.
    IF p_ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_parent_table);

        -- === Tier 1: Ownership policies ===
        EXECUTE format(
            'CREATE POLICY gf_owner_select ON public.%I FOR SELECT TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_owner_update ON public.%I FOR UPDATE TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_owner_delete ON public.%I FOR DELETE TO authenticated USING (%I = public.current_user_id())',
            p_parent_table, p_ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (true)',
            p_parent_table
        );

        -- === Tier 2: RBAC per-operation blanket access ===
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
    'Register a new guided form definition with auto step-zero and ownership RLS. '
    'SECURITY DEFINER for trigger/RLS creation. '
    'v0.55.2: column-agnostic — detects guided_form_status_id or status_id, does not rename.';


-- ============================================================================
-- 2. Restore add_guided_form_step() with original inline guard
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
    v_gf_col           NAME;
BEGIN
    -- Admin guard: only admins (or superusers running init scripts) can add guided form steps
    IF NOT (public.is_admin() OR current_setting('is_superuser', true) = 'on') THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    SELECT * INTO v_guided_form FROM metadata.guided_forms WHERE guided_form_key = p_guided_form_key;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Guided form %s not found', p_guided_form_key));
    END IF;

    -- Detect or create GF status column on step table. Do NOT rename.
    v_gf_col := public._gf_status_col(p_step_table);
    IF v_gf_col IS NULL THEN
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN status_id INTEGER REFERENCES metadata.statuses(id)',
            p_step_table
        );
        v_gf_col := 'status_id';
    END IF;
    EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT public.get_initial_status(''guided_form'')',
        p_step_table, v_gf_col
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_gf_status_id ON public.%I (%I)', p_step_table, p_step_table, v_gf_col);

    INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
    VALUES (p_step_table, v_gf_col, false, false, false, false)
    ON CONFLICT (table_name, column_name) DO UPDATE
      SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

    INSERT INTO metadata.guided_form_steps (
        guided_form_key, step_key, display_name, description,
        step_table, parent_fk_column, step_order, can_skip
    ) VALUES (
        p_guided_form_key, p_step_key, p_display_name, p_description,
        p_step_table, p_parent_fk_column, p_step_order, p_can_skip
    );

    -- Upgrade FK constraint to ON DELETE CASCADE
    DECLARE
        v_fk_name TEXT;
    BEGIN
        SELECT conname INTO v_fk_name
        FROM pg_constraint
        WHERE conrelid = format('public.%I', p_step_table)::regclass
          AND confrelid = format('public.%I', v_guided_form.parent_table)::regclass
          AND contype = 'f';

        IF v_fk_name IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE public.%I DROP CONSTRAINT %I',
                p_step_table, v_fk_name
            );
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE CASCADE',
                p_step_table, v_fk_name, p_parent_fk_column, v_guided_form.parent_table
            );
        END IF;
    END;

    -- Hide step table from sidebar and propagate guided_form_key
    INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar, guided_form_key)
    VALUES (p_step_table, p_display_name, FALSE, p_guided_form_key)
    ON CONFLICT (table_name) DO UPDATE SET
        show_in_sidebar = FALSE,
        guided_form_key = p_guided_form_key;

    -- Ensure CRUD permission entries exist for the step table.
    INSERT INTO metadata.permissions (table_name, permission)
    SELECT p_step_table, p::metadata.permission
    FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
    ON CONFLICT (table_name, permission) DO NOTHING;

    -- Auto-create RLS policies on step table (inherits parent ownership).
    IF v_guided_form.ownership_column IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_step_table);

        -- === Tier 1: Ownership via parent FK ===
        EXECUTE format(
            'CREATE POLICY gf_child_select ON public.%I FOR SELECT TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_insert ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_update ON public.%I FOR UPDATE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );
        EXECUTE format(
            'CREATE POLICY gf_child_delete ON public.%I FOR DELETE TO authenticated '
            'USING (EXISTS (SELECT 1 FROM public.%I WHERE %I.id = %I.%I AND %I.%I = public.current_user_id()))',
            p_step_table, v_guided_form.parent_table,
            v_guided_form.parent_table, p_step_table, p_parent_fk_column,
            v_guided_form.parent_table, v_guided_form.ownership_column
        );

        -- === Tier 2: RBAC per-operation blanket access (inherits parent table permissions) ===
        EXECUTE format(
            'CREATE POLICY gf_child_rbac_select ON public.%I FOR SELECT TO authenticated '
            'USING (public.has_permission(%L, ''read''))',
            p_step_table, v_guided_form.parent_table::TEXT
        );
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
    'Add a step to a guided form definition with auto child RLS delegation. '
    'SECURITY DEFINER for RLS creation. '
    'v0.55.2: column-agnostic — detects guided_form_status_id or status_id, does not rename.';


-- ============================================================================
-- 3. Restore grant_guided_form_permissions() with original inline guard
-- ============================================================================

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
-- 4. Drop the helper function
-- ============================================================================

DROP FUNCTION IF EXISTS metadata._is_db_admin();

COMMIT;
