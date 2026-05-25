-- ============================================================================
-- NEH Script 33b: Fix event_details guided form step registration
-- ============================================================================
-- Root cause: add_guided_form_step() failed silently in script 33 because
-- DigitalOcean managed databases don't grant true SUPERUSER to doadmin.
-- The function's admin guard (is_admin() OR is_superuser) rejected the call,
-- caught it in WHEN OTHERS, and returned {success: false} without raising.
--
-- Fixed in v0.56.1: metadata._is_db_admin() now detects managed DB admins
-- via CREATEROLE privilege. This script is now conditional — it only runs
-- its steps if add_guided_form_step() didn't already succeed.
--
-- IMPORTANT: In Docker, 33b_ sorts BEFORE 33_ (Debian locale collation puts
-- underscore after letters). If script 33 hasn't run yet, the child table
-- doesn't exist and we must skip entirely.
-- ============================================================================

DO $$
BEGIN
    -- Guard: skip entirely if script 33 hasn't run yet (table doesn't exist)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'building_use_event_details'
    ) THEN
        RAISE NOTICE '33b: building_use_event_details table does not exist yet (script 33 not run), skipping.';
        RETURN;
    END IF;

    -- Only register if add_guided_form_step() didn't already create this step
    IF NOT EXISTS (
        SELECT 1 FROM metadata.guided_form_steps
        WHERE guided_form_key = 'building_use_request' AND step_key = 'event_details'
    ) THEN
        RAISE NOTICE '33b: event_details step missing, applying manual fix...';

        -- 1. Register the guided form step
        INSERT INTO metadata.guided_form_steps (
            guided_form_key, step_key, display_name, description,
            step_table, parent_fk_column, step_order, can_skip
        ) VALUES (
            'building_use_request', 'event_details', 'Event Details',
            'Describe your event, scheduling needs, and any equipment or accessibility requirements.',
            'building_use_event_details', 'building_use_request_id', 1, false
        );

        -- 2. Register CRUD permissions (inherits parent table permissions)
        INSERT INTO metadata.permissions (table_name, permission)
        SELECT 'building_use_event_details', p::metadata.permission
        FROM unnest(ARRAY['create', 'read', 'update', 'delete']) AS p
        ON CONFLICT (table_name, permission) DO NOTHING;

        -- 3. Enable RLS with ownership-based and RBAC policies
        ALTER TABLE public.building_use_event_details ENABLE ROW LEVEL SECURITY;

        -- Tier 1: Ownership via parent FK
        EXECUTE 'CREATE POLICY gf_child_select ON public.building_use_event_details FOR SELECT TO authenticated
            USING (EXISTS (SELECT 1 FROM public.building_use_requests
                WHERE building_use_requests.id = building_use_event_details.building_use_request_id
                  AND building_use_requests.created_by = public.current_user_id()))';

        EXECUTE 'CREATE POLICY gf_child_insert ON public.building_use_event_details FOR INSERT TO authenticated
            WITH CHECK (EXISTS (SELECT 1 FROM public.building_use_requests
                WHERE building_use_requests.id = building_use_event_details.building_use_request_id
                  AND building_use_requests.created_by = public.current_user_id()))';

        EXECUTE 'CREATE POLICY gf_child_update ON public.building_use_event_details FOR UPDATE TO authenticated
            USING (EXISTS (SELECT 1 FROM public.building_use_requests
                WHERE building_use_requests.id = building_use_event_details.building_use_request_id
                  AND building_use_requests.created_by = public.current_user_id()))';

        EXECUTE 'CREATE POLICY gf_child_delete ON public.building_use_event_details FOR DELETE TO authenticated
            USING (EXISTS (SELECT 1 FROM public.building_use_requests
                WHERE building_use_requests.id = building_use_event_details.building_use_request_id
                  AND building_use_requests.created_by = public.current_user_id()))';

        -- Tier 2: RBAC blanket access
        EXECUTE 'CREATE POLICY gf_child_rbac_select ON public.building_use_event_details FOR SELECT TO authenticated
            USING (public.has_permission(''building_use_requests'', ''read''))';

        EXECUTE 'CREATE POLICY gf_child_rbac_insert ON public.building_use_event_details FOR INSERT TO authenticated
            WITH CHECK (public.has_permission(''building_use_requests'', ''update''))';

        EXECUTE 'CREATE POLICY gf_child_rbac_update ON public.building_use_event_details FOR UPDATE TO authenticated
            USING (public.has_permission(''building_use_requests'', ''update''))';

        EXECUTE 'CREATE POLICY gf_child_rbac_delete ON public.building_use_event_details FOR DELETE TO authenticated
            USING (public.has_permission(''building_use_requests'', ''delete''))';
    ELSE
        RAISE NOTICE '33b: event_details step already exists (add_guided_form_step succeeded), skipping.';
    END IF;

    -- 4. Skip_if condition: always ensure it exists (idempotent)
    INSERT INTO metadata.guided_form_step_conditions (guided_form_step_id, condition_type, field, operator, value, sort_order)
    SELECT gs.id, 'skip_if', 'group_type', 'eq', '23', 0
    FROM metadata.guided_form_steps gs
    WHERE gs.guided_form_key = 'building_use_request' AND gs.step_key = 'event_details'
      AND NOT EXISTS (
          SELECT 1 FROM metadata.guided_form_step_conditions c
          WHERE c.guided_form_step_id = gs.id AND c.condition_type = 'skip_if' AND c.field = 'group_type'
      );
END $$;

-- 5. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
