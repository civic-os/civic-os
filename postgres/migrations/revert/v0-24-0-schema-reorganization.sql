-- Revert civic-os:v0-24-0-schema-reorganization from pg
-- Restores the original schema organization (pre-v0.24.0)

BEGIN;

-- ============================================================================
-- 1. MOVE EXTENSIONS BACK TO PUBLIC SCHEMA (if they were moved)
-- ============================================================================
-- On managed databases, extensions may not have been moved (insufficient
-- privileges). Only attempt to move back if they're currently in plugins.

DO $$
DECLARE
    v_ext RECORD;
BEGIN
    FOR v_ext IN
        SELECT e.extname, n.nspname
        FROM pg_extension e
        JOIN pg_namespace n ON e.extnamespace = n.oid
        WHERE e.extname IN ('btree_gist', 'pgcrypto')
    LOOP
        IF v_ext.nspname = 'plugins' THEN
            BEGIN
                EXECUTE format('ALTER EXTENSION %I SET SCHEMA public', v_ext.extname);
                RAISE NOTICE 'Extension % moved back to public schema', v_ext.extname;
            EXCEPTION
                WHEN insufficient_privilege THEN
                    RAISE NOTICE 'Cannot move % back (insufficient privileges) - leaving in plugins', v_ext.extname;
            END;
        ELSE
            RAISE NOTICE 'Extension % already in % schema - no move needed', v_ext.extname, v_ext.nspname;
        END IF;
    END LOOP;
END;
$$;


-- ============================================================================
-- 1.5 DROP SHIM FUNCTIONS BEFORE MOVING ORIGINALS BACK
-- ============================================================================
-- The shims in public schema must be dropped before we can move the originals
-- back from metadata (can't have two functions with same name in same schema)

DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.has_permission(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_user_roles();
DROP FUNCTION IF EXISTS public.current_user_id();
DROP FUNCTION IF EXISTS public.current_user_email();
DROP FUNCTION IF EXISTS public.current_user_name();
DROP FUNCTION IF EXISTS public.current_user_phone();
DROP FUNCTION IF EXISTS public.check_jwt();
DROP FUNCTION IF EXISTS public.get_initial_status(TEXT);
DROP FUNCTION IF EXISTS public.get_statuses_for_entity(TEXT);
DROP FUNCTION IF EXISTS public.has_role(UUID, TEXT);
DROP FUNCTION IF EXISTS public.has_entity_action_permission(INT);


-- ============================================================================
-- 1.6 MOVE INTERNAL HELPER FUNCTIONS BACK TO PUBLIC SCHEMA
-- ============================================================================

-- JWT/Auth helpers
ALTER FUNCTION metadata.current_user_id() SET SCHEMA public;
ALTER FUNCTION metadata.current_user_email() SET SCHEMA public;
ALTER FUNCTION metadata.current_user_name() SET SCHEMA public;
ALTER FUNCTION metadata.current_user_phone() SET SCHEMA public;
ALTER FUNCTION metadata.check_jwt() SET SCHEMA public;
ALTER FUNCTION metadata.get_user_roles() SET SCHEMA public;
ALTER FUNCTION metadata.has_permission(TEXT, TEXT) SET SCHEMA public;
ALTER FUNCTION metadata.is_admin() SET SCHEMA public;
ALTER FUNCTION metadata.has_role(UUID, TEXT) SET SCHEMA public;

-- Entity action permission helper
ALTER FUNCTION metadata.has_entity_action_permission(INT) SET SCHEMA public;

-- Status system helpers
ALTER FUNCTION metadata.get_initial_status(TEXT) SET SCHEMA public;
ALTER FUNCTION metadata.get_statuses_for_entity(TEXT) SET SCHEMA public;
ALTER FUNCTION metadata.get_status_entity_types() SET SCHEMA public;


-- ============================================================================
-- 2. RESTORE ORIGINAL SEARCH_PATH
-- ============================================================================
-- On managed databases, we may not be able to alter certain roles.

SET search_path = public, postgis;

DO $$
DECLARE
    v_role TEXT;
BEGIN
    -- Restore search_path for application roles
    -- Skip postgres role (owned by cloud provider on managed databases)
    FOR v_role IN SELECT unnest(ARRAY['authenticator', 'web_anon', 'authenticated'])
    LOOP
        BEGIN
            EXECUTE format('ALTER ROLE %I SET search_path = public, postgis', v_role);
            RAISE NOTICE 'Restored search_path for role %', v_role;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Cannot alter role % - skipping', v_role;
            WHEN undefined_object THEN
                RAISE NOTICE 'Role % does not exist - skipping', v_role;
        END;
    END LOOP;
END;
$$;


-- ============================================================================
-- 2.5 RESTORE ORIGINAL FUNCTION BODIES
-- ============================================================================
-- Restore has_permission and is_admin with original public.get_user_roles() calls

CREATE OR REPLACE FUNCTION public.has_permission(
  p_table_name TEXT,
  p_permission TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
  has_perm BOOLEAN;
BEGIN
  user_roles := public.get_user_roles();
  SELECT EXISTS (
    SELECT 1
    FROM metadata.roles r
    JOIN metadata.permission_roles pr ON pr.role_id = r.id
    JOIN metadata.permissions p ON p.id = pr.permission_id
    WHERE r.display_name = ANY(user_roles)
      AND p.table_name = p_table_name
      AND p.permission::TEXT = p_permission
  ) INTO has_perm;
  RETURN has_perm;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
BEGIN
  user_roles := public.get_user_roles();
  RETURN 'admin' = ANY(user_roles);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ============================================================================
-- 3. RESTORE ORIGINAL INTROSPECTION VIEWS
-- ============================================================================

-- 3.1 Restore original schema_functions view (metadata-first)
DROP VIEW IF EXISTS public.schema_functions;

CREATE VIEW public.schema_functions
WITH (security_invoker = true) AS
SELECT
    rf.function_name,
    rf.schema_name,
    rf.display_name,
    rf.description,
    rf.category,
    rf.parameters,
    rf.returns_type,
    rf.returns_description,
    rf.is_idempotent,
    rf.minimum_role,

    -- Filtered entity effects (only readable tables)
    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', ree.entity_table,
            'effect', ree.effect_type,
            'auto_detected', ree.is_auto_detected,
            'description', ree.description
        )) FILTER (
            WHERE ree.id IS NOT NULL
              AND public.has_permission(ree.entity_table::TEXT, 'read')
        ),
        '[]'::jsonb
    ) AS entity_effects,

    -- Count of hidden effects (transparency without disclosure)
    COUNT(*) FILTER (
        WHERE ree.id IS NOT NULL
          AND NOT public.has_permission(ree.entity_table::TEXT, 'read')
    )::INT AS hidden_effects_count,

    -- Schedule indicator
    EXISTS (
        SELECT 1 FROM metadata.scheduled_jobs sj
        WHERE sj.function_name = rf.function_name::VARCHAR(200)
          AND sj.enabled = true
    ) AS has_active_schedule,

    -- Permission check for execution (via entity_actions if protected)
    CASE
        -- If this RPC is protected via entity_actions, check permission
        WHEN EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = rf.function_name)
        THEN EXISTS (
            SELECT 1 FROM metadata.entity_actions ea
            WHERE ea.rpc_function = rf.function_name
              AND public.has_entity_action_permission(ea.id)
        )
        -- Unprotected RPCs are executable by all authenticated users
        ELSE true
    END AS can_execute

FROM metadata.rpc_functions rf
LEFT JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
WHERE
    -- Show if user can execute (unprotected or has permission)
    (NOT EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = rf.function_name)
     OR EXISTS (
         SELECT 1 FROM metadata.entity_actions ea
         WHERE ea.rpc_function = rf.function_name
           AND public.has_entity_action_permission(ea.id)
     ))
    -- OR if user can read any affected table
    OR EXISTS (
        SELECT 1 FROM metadata.rpc_entity_effects ree2
        WHERE ree2.function_name = rf.function_name
          AND public.has_permission(ree2.entity_table::TEXT, 'read')
    )
GROUP BY rf.function_name, rf.schema_name, rf.display_name, rf.description,
         rf.category, rf.parameters, rf.returns_type, rf.returns_description,
         rf.is_idempotent, rf.minimum_role;

COMMENT ON VIEW public.schema_functions IS
    'Permission-filtered view of registered RPC functions with entity effects.';


-- 3.2 Restore original schema_triggers view (metadata-first)
DROP VIEW IF EXISTS public.schema_triggers;

CREATE VIEW public.schema_triggers
WITH (security_invoker = true) AS
SELECT
    dt.trigger_name,
    dt.table_name,
    dt.schema_name,
    dt.timing,
    dt.events,
    dt.function_name,
    dt.display_name,
    dt.description,
    dt.purpose,
    dt.is_enabled,

    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', tee.affected_table,
            'effect', tee.effect_type,
            'auto_detected', tee.is_auto_detected
        )) FILTER (
            WHERE tee.id IS NOT NULL
              AND public.has_permission(tee.affected_table::TEXT, 'read')
        ),
        '[]'::jsonb
    ) AS entity_effects,

    COUNT(*) FILTER (
        WHERE tee.id IS NOT NULL
          AND NOT public.has_permission(tee.affected_table::TEXT, 'read')
    )::INT AS hidden_effects_count

FROM metadata.database_triggers dt
LEFT JOIN metadata.trigger_entity_effects tee
    ON tee.trigger_name = dt.trigger_name
    AND tee.trigger_table = dt.table_name
    AND tee.trigger_schema = dt.schema_name
WHERE public.has_permission(dt.table_name::TEXT, 'read')
GROUP BY dt.trigger_name, dt.table_name, dt.schema_name, dt.timing, dt.events,
         dt.function_name, dt.display_name, dt.description, dt.purpose, dt.is_enabled;

COMMENT ON VIEW public.schema_triggers IS
    'Permission-filtered view of registered database triggers with entity effects.';


-- 3.3 Restore original schema_scheduled_functions view
DROP VIEW IF EXISTS public.schema_scheduled_functions;

CREATE VIEW public.schema_scheduled_functions
WITH (security_invoker = true) AS
SELECT
    rf.function_name,
    rf.display_name,
    rf.description,
    rf.category,
    sj.name AS job_name,
    sj.schedule AS cron_schedule,
    sj.timezone,
    sj.enabled AS schedule_enabled,
    sj.last_run_at,
    sjs.last_run_success,
    sjs.success_rate_percent
FROM metadata.rpc_functions rf
JOIN metadata.scheduled_jobs sj ON sj.function_name = rf.function_name::VARCHAR(200)
LEFT JOIN public.scheduled_job_status sjs ON sjs.id = sj.id
WHERE public.is_admin();  -- Admin-only for schedule details

COMMENT ON VIEW public.schema_scheduled_functions IS
    'Admin-only view showing RPC functions that run on a schedule with execution statistics.';


-- ============================================================================
-- 4. DROP PLUGINS SCHEMA (if empty)
-- ============================================================================

DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'plugins';

    IF v_count = 0 THEN
        DROP SCHEMA IF EXISTS plugins;
        RAISE NOTICE 'Dropped empty plugins schema';
    ELSE
        RAISE NOTICE 'plugins schema still has % objects, not dropping', v_count;
    END IF;
END;
$$;


-- ============================================================================
-- 5. RE-GRANT PERMISSIONS
-- ============================================================================

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;
GRANT SELECT ON public.schema_triggers TO authenticated, web_anon;
GRANT SELECT ON public.schema_scheduled_functions TO authenticated;


-- ============================================================================
-- 6. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
