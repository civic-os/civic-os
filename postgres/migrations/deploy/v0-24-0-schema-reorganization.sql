-- Deploy civic-os:v0-24-0-schema-reorganization to pg
-- requires: v0-23-0-system-introspection
-- Schema Reorganization: Extensions to plugins, internal helpers to metadata
-- Version: 0.24.0

BEGIN;

-- ============================================================================
-- SCHEMA REORGANIZATION
-- ============================================================================
-- This migration reorganizes the database schema for clean introspection:
--
-- 1. EXTENSIONS → plugins schema
--    - btree_gist (~164 functions) and pgcrypto (~14 functions)
--    - Removes extension noise from public namespace
--
-- 2. INTERNAL HELPERS → metadata schema
--    - JWT/auth helpers (current_user_id, has_permission, is_admin, etc.)
--    - Status system helpers (get_initial_status, etc.)
--    - These are called by RLS policies and SQL, never by PostgREST
--
-- 3. FRAMEWORK RPCs stay in public (PostgREST needs access)
--    - Dashboard functions (get_dashboards, etc.)
--    - Metadata management (upsert_entity_metadata, etc.)
--    - Permission management (set_role_permission, etc.)
--
-- Benefits:
--   - schema_functions shows only application code
--   - Reduced exclusion list (from ~50 to ~25 items)
--   - metadata schema no longer needs PostgREST exposure
--   - Internal helpers accessible via search_path
--
-- PostGIS Note: PostGIS doesn't support SET SCHEMA, so it stays in its
-- dedicated 'postgis' schema (which is already separate from public).
-- ============================================================================


-- ============================================================================
-- 1. CREATE PLUGINS SCHEMA
-- ============================================================================
-- This schema holds database extensions, keeping them out of public.

CREATE SCHEMA IF NOT EXISTS plugins;

COMMENT ON SCHEMA plugins IS
    'Database extensions (pgcrypto, btree_gist). Separated from public schema to keep introspection clean.';


-- ============================================================================
-- 2. MOVE EXTENSIONS TO PLUGINS SCHEMA
-- ============================================================================
-- Note: ALTER EXTENSION SET SCHEMA moves all extension objects (functions,
-- types, operators, etc.) to the new schema in one atomic operation.

-- Move btree_gist (used for exclusion constraints, adds ~164 functions)
ALTER EXTENSION btree_gist SET SCHEMA plugins;

-- Move pgcrypto (used for crypt/digest, adds ~14 functions)
ALTER EXTENSION pgcrypto SET SCHEMA plugins;

-- Verify extensions moved
DO $$
DECLARE
    v_ext RECORD;
    v_public_count_before INT;
    v_public_count_after INT;
BEGIN
    -- Count functions removed from public
    FOR v_ext IN
        SELECT e.extname, n.nspname
        FROM pg_extension e
        JOIN pg_namespace n ON e.extnamespace = n.oid
        WHERE e.extname IN ('btree_gist', 'pgcrypto')
    LOOP
        IF v_ext.nspname != 'plugins' THEN
            RAISE EXCEPTION 'Extension % is in schema % instead of plugins', v_ext.extname, v_ext.nspname;
        END IF;
        RAISE NOTICE 'Extension % moved to plugins schema', v_ext.extname;
    END LOOP;

    -- Verify postgis is in postgis schema (unchanged)
    SELECT e.extname, n.nspname INTO v_ext
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    WHERE e.extname = 'postgis';

    IF v_ext IS NOT NULL AND v_ext.nspname = 'postgis' THEN
        RAISE NOTICE 'Extension postgis remains in postgis schema (unchanged)';
    END IF;
END;
$$;


-- ============================================================================
-- 2.5 MOVE INTERNAL HELPER FUNCTIONS TO METADATA SCHEMA
-- ============================================================================
-- These functions are called by RLS policies, triggers, and SQL views - never
-- by the frontend via PostgREST. Moving them to metadata keeps the public
-- schema clean for introspection.
--
-- Note: Functions are referenced by OID in triggers and views, so moving them
-- doesn't break existing references. The search_path update (section 3) ensures
-- unqualified calls continue to work.

-- JWT/Auth helpers (used by RLS policies)
ALTER FUNCTION public.current_user_id() SET SCHEMA metadata;
ALTER FUNCTION public.current_user_email() SET SCHEMA metadata;
ALTER FUNCTION public.current_user_name() SET SCHEMA metadata;
ALTER FUNCTION public.current_user_phone() SET SCHEMA metadata;
ALTER FUNCTION public.check_jwt() SET SCHEMA metadata;
ALTER FUNCTION public.get_user_roles() SET SCHEMA metadata;
ALTER FUNCTION public.has_permission(TEXT, TEXT) SET SCHEMA metadata;
ALTER FUNCTION public.is_admin() SET SCHEMA metadata;
ALTER FUNCTION public.has_role(UUID, TEXT) SET SCHEMA metadata;

-- Entity action permission helper (used by views)
ALTER FUNCTION public.has_entity_action_permission(INT) SET SCHEMA metadata;

-- Status system helpers (used by column defaults and validation)
ALTER FUNCTION public.get_initial_status(TEXT) SET SCHEMA metadata;
ALTER FUNCTION public.get_statuses_for_entity(TEXT) SET SCHEMA metadata;
ALTER FUNCTION public.get_status_entity_types() SET SCHEMA metadata;

DO $$ BEGIN RAISE NOTICE 'Moved 13 internal helper functions to metadata schema'; END $$;


-- ============================================================================
-- 3. UPDATE SEARCH_PATH FOR BACKWARD COMPATIBILITY
-- ============================================================================
-- Add plugins and metadata to the search_path so:
-- - Extension functions (crypt, digest, etc.) work with unqualified names
-- - Internal helpers (has_permission, current_user_id, etc.) resolve in RLS/views
-- Note: postgres role also needs the updated search_path for migrations/verify
-- The SET command updates the current session; ALTER ROLE updates future sessions

SET search_path = public, metadata, plugins, postgis;
ALTER ROLE postgres SET search_path = public, metadata, plugins, postgis;
ALTER ROLE authenticator SET search_path = public, metadata, plugins, postgis;
ALTER ROLE web_anon SET search_path = public, metadata, plugins, postgis;
ALTER ROLE authenticated SET search_path = public, metadata, plugins, postgis;


-- ============================================================================
-- 3.5 UPDATE FUNCTION BODIES WITH CORRECT INTERNAL REFERENCES
-- ============================================================================
-- Some functions (is_admin, has_permission) have bodies that call
-- public.get_user_roles(). After moving them to metadata schema, these
-- references break. We recreate them with unqualified get_user_roles()
-- calls that resolve via the search_path.

-- Recreate has_permission with unqualified get_user_roles()
CREATE OR REPLACE FUNCTION metadata.has_permission(
  p_table_name TEXT,
  p_permission TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
  has_perm BOOLEAN;
BEGIN
  -- Get current user's roles (includes 'anonymous' for unauthenticated users)
  -- Uses unqualified name - resolves via search_path to metadata.get_user_roles()
  user_roles := get_user_roles();

  -- Check if any of the user's roles have the requested permission
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

-- Recreate is_admin with unqualified get_user_roles()
CREATE OR REPLACE FUNCTION metadata.is_admin()
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
BEGIN
  -- Uses unqualified name - resolves via search_path to metadata.get_user_roles()
  user_roles := get_user_roles();
  RETURN 'admin' = ANY(user_roles);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

DO $$ BEGIN RAISE NOTICE 'Recreated has_permission and is_admin with updated internal references'; END $$;


-- ============================================================================
-- 3.6 CREATE BACKWARD-COMPATIBLE SHIM FUNCTIONS IN PUBLIC
-- ============================================================================
-- Other framework functions (set_role_permission, etc.) and RLS policies may
-- reference public.is_admin(), public.has_permission(), etc. Instead of updating
-- all those function bodies, we create thin wrapper functions in public that
-- forward to the metadata versions. This provides backward compatibility.

-- Shim for is_admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT metadata.is_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for has_permission
CREATE OR REPLACE FUNCTION public.has_permission(p_table_name TEXT, p_permission TEXT)
RETURNS BOOLEAN AS $$
  SELECT metadata.has_permission(p_table_name, p_permission);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for get_user_roles
CREATE OR REPLACE FUNCTION public.get_user_roles()
RETURNS TEXT[] AS $$
  SELECT metadata.get_user_roles();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for current_user_id
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID AS $$
  SELECT metadata.current_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for current_user_email
CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS TEXT AS $$
  SELECT metadata.current_user_email();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for current_user_name
CREATE OR REPLACE FUNCTION public.current_user_name()
RETURNS TEXT AS $$
  SELECT metadata.current_user_name();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for current_user_phone
CREATE OR REPLACE FUNCTION public.current_user_phone()
RETURNS TEXT AS $$
  SELECT metadata.current_user_phone();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for check_jwt (pre-request function)
CREATE OR REPLACE FUNCTION public.check_jwt()
RETURNS VOID AS $$
BEGIN
  PERFORM metadata.check_jwt();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Shim for get_initial_status
CREATE OR REPLACE FUNCTION public.get_initial_status(p_entity_type TEXT)
RETURNS INT AS $$
  SELECT metadata.get_initial_status(p_entity_type);
$$ LANGUAGE sql STABLE;

-- Shim for get_statuses_for_entity
CREATE OR REPLACE FUNCTION public.get_statuses_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT,
  is_initial BOOLEAN,
  is_terminal BOOLEAN
) AS $$
  SELECT * FROM metadata.get_statuses_for_entity(p_entity_type);
$$ LANGUAGE sql STABLE;

-- Shim for has_role
CREATE OR REPLACE FUNCTION public.has_role(p_user_id UUID, p_role_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT metadata.has_role(p_user_id, p_role_name);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Shim for has_entity_action_permission
CREATE OR REPLACE FUNCTION public.has_entity_action_permission(p_action_id INT)
RETURNS BOOLEAN AS $$
  SELECT metadata.has_entity_action_permission(p_action_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Re-grant execute permissions on shims
GRANT EXECUTE ON FUNCTION public.is_admin() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(TEXT, TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_roles() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_id() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_email() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_name() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_phone() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_jwt() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_initial_status(TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_statuses_for_entity(TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_entity_action_permission(INT) TO web_anon, authenticated;

DO $$ BEGIN RAISE NOTICE 'Created backward-compatible shim functions in public schema'; END $$;


-- ============================================================================
-- 4. UPDATE INTROSPECTION VIEWS
-- ============================================================================
-- Now that extensions are in plugins schema, the introspection views can
-- simply query public schema without complex exclusion patterns.

-- 4.1 schema_functions: Catalog-first with reduced exclusions
-- Note: Internal helpers (has_permission, is_admin, etc.) are now in metadata
-- schema. We use fully-qualified names (metadata.function_name) to ensure the
-- views work correctly within this transaction before search_path takes effect.
DROP VIEW IF EXISTS public.schema_functions;

CREATE VIEW public.schema_functions
WITH (security_invoker = true) AS
WITH
-- Get registered entity effects per function
entity_effects AS (
    SELECT
        ree.function_name,
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', ree.entity_table,
            'effect', ree.effect_type,
            'auto_detected', ree.is_auto_detected,
            'description', ree.description
        )) FILTER (
            WHERE metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
        ) AS visible_effects,
        COUNT(*) FILTER (
            WHERE NOT metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
        )::INT AS hidden_count
    FROM metadata.rpc_entity_effects ree
    GROUP BY ree.function_name
)
SELECT
    p.proname AS function_name,
    n.nspname::NAME AS schema_name,

    -- Overlay metadata or use smart defaults
    COALESCE(rf.display_name, initcap(replace(p.proname::text, '_', ' '))) AS display_name,
    rf.description,
    rf.category,
    rf.parameters,

    -- Get return type from pg_proc
    pg_get_function_result(p.oid) AS returns_type,
    rf.returns_description,

    COALESCE(rf.is_idempotent, false) AS is_idempotent,
    rf.minimum_role,

    -- Entity effects (only from registered functions)
    COALESCE(ee.visible_effects, '[]'::jsonb) AS entity_effects,
    COALESCE(ee.hidden_count, 0) AS hidden_effects_count,

    -- Whether this function is registered (has custom metadata)
    rf.function_name IS NOT NULL AS is_registered,

    -- Schedule indicator
    EXISTS (
        SELECT 1 FROM metadata.scheduled_jobs sj
        WHERE sj.function_name = p.proname::TEXT
          AND sj.enabled = true
    ) AS has_active_schedule,

    -- Permission check for execution (via entity_actions if protected)
    CASE
        -- If this RPC is protected via entity_actions, check permission
        WHEN EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
        THEN EXISTS (
            SELECT 1 FROM metadata.entity_actions ea
            WHERE ea.rpc_function = p.proname::NAME
              AND metadata.has_entity_action_permission(ea.id)
        )
        -- Unprotected RPCs are executable by all authenticated users
        ELSE true
    END AS can_execute

FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN metadata.rpc_functions rf ON rf.function_name = p.proname
LEFT JOIN entity_effects ee ON ee.function_name = p.proname

WHERE n.nspname = 'public'
  AND p.prokind = 'f'  -- functions only (not procedures/aggregates)
  -- Exclude framework functions that stay in public (PostgREST-callable or trigger support)
  -- Note: Internal helpers are now in metadata, with shims in public for backward compatibility
  AND p.proname NOT IN (
      -- Shim functions (forward to metadata.* for backward compatibility)
      'is_admin', 'has_permission', 'get_user_roles',
      'current_user_id', 'current_user_email', 'current_user_name', 'current_user_phone',
      'check_jwt', 'get_initial_status', 'get_statuses_for_entity', 'get_status_entity_types',
      'has_role', 'has_entity_action_permission',
      -- Framework RPCs (PostgREST-callable, stay in public)
      'refresh_current_user',
      'grant_entity_action_permission', 'revoke_entity_action_permission', 'get_entity_action_roles',
      'upsert_entity_metadata', 'upsert_property_metadata',
      'update_entity_sort_order', 'update_property_sort_order',
      'create_role', 'get_roles', 'get_role_permissions',
      'set_role_permission', 'ensure_table_permissions', 'enable_entity_notes',
      'get_dashboards', 'get_dashboard', 'get_user_default_dashboard',
      'schema_relations_func',
      -- Trigger support functions (must stay in public for trigger definitions)
      'set_created_at', 'set_updated_at', 'set_file_created_by',
      'add_status_change_note', 'add_payment_status_change_note',
      'add_reservation_status_change_note', 'validate_status_entity_type',
      'enqueue_notification_job', 'create_notification', 'create_default_notification_preferences',
      'notify_new_reservation_request', 'notify_reservation_status_change',
      'insert_s3_presign_job', 'insert_thumbnail_job', 'create_payment_intent_sync',
      -- Validation/file internals (stay in public for now)
      'cleanup_old_validation_results', 'get_validation_results',
      'get_preview_results', 'preview_template_parts', 'validate_template_parts',
      'get_upload_url', 'request_upload_url',
      'format_public_display_name'
  )
  -- Visibility: Show if user can execute OR if registered and user can read affected tables
  AND (
      -- Unprotected functions are visible to all
      NOT EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
      -- Protected functions visible if user has permission
      OR EXISTS (
          SELECT 1 FROM metadata.entity_actions ea
          WHERE ea.rpc_function = p.proname::NAME
            AND metadata.has_entity_action_permission(ea.id)
      )
      -- Also visible if registered and user can read any affected table
      OR EXISTS (
          SELECT 1 FROM metadata.rpc_entity_effects ree
          WHERE ree.function_name = p.proname
            AND metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
      )
  );

COMMENT ON VIEW public.schema_functions IS
    'Catalog-first view of public functions with optional metadata overlay. Extension functions are in plugins schema; internal helpers are in metadata schema; framework RPCs are filtered by name.';


-- 4.2 schema_triggers: Catalog-first with optional metadata overlay
DROP VIEW IF EXISTS public.schema_triggers;

CREATE VIEW public.schema_triggers
WITH (security_invoker = true) AS
WITH
-- Get registered entity effects per trigger
trigger_effects AS (
    SELECT
        tee.trigger_name,
        tee.trigger_table,
        tee.trigger_schema,
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', tee.affected_table,
            'effect', tee.effect_type,
            'auto_detected', tee.is_auto_detected,
            'description', tee.description
        )) FILTER (
            WHERE metadata.has_permission(tee.affected_table::TEXT, 'read'::TEXT)
        ) AS visible_effects,
        COUNT(*) FILTER (
            WHERE NOT metadata.has_permission(tee.affected_table::TEXT, 'read'::TEXT)
        )::INT AS hidden_count
    FROM metadata.trigger_entity_effects tee
    GROUP BY tee.trigger_name, tee.trigger_table, tee.trigger_schema
)
SELECT
    t.tgname AS trigger_name,
    c.relname AS table_name,
    n.nspname::NAME AS schema_name,

    -- Decode timing from tgtype bitmask
    CASE
        WHEN (t.tgtype::int & 2) != 0 THEN 'BEFORE'
        WHEN (t.tgtype::int & 64) != 0 THEN 'INSTEAD OF'
        ELSE 'AFTER'
    END::VARCHAR(10) AS timing,

    -- Decode events from tgtype bitmask
    ARRAY_REMOVE(ARRAY[
        CASE WHEN (t.tgtype::int & 4) != 0 THEN 'INSERT'::VARCHAR(20) END,
        CASE WHEN (t.tgtype::int & 8) != 0 THEN 'DELETE'::VARCHAR(20) END,
        CASE WHEN (t.tgtype::int & 16) != 0 THEN 'UPDATE'::VARCHAR(20) END
    ], NULL) AS events,

    proc.proname AS function_name,

    -- Overlay metadata or use smart defaults
    COALESCE(dt.display_name, initcap(replace(t.tgname::text, '_', ' '))) AS display_name,
    dt.description,
    dt.purpose,

    -- Enabled status from pg_trigger
    t.tgenabled != 'D' AS is_enabled,

    -- Whether this trigger is registered (has custom metadata)
    dt.trigger_name IS NOT NULL AS is_registered,

    -- Entity effects (only from registered triggers)
    COALESCE(te.visible_effects, '[]'::jsonb) AS entity_effects,
    COALESCE(te.hidden_count, 0) AS hidden_effects_count

FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc proc ON proc.oid = t.tgfoid
LEFT JOIN metadata.database_triggers dt
    ON dt.trigger_name = t.tgname
    AND dt.table_name = c.relname
    AND dt.schema_name = n.nspname
LEFT JOIN trigger_effects te
    ON te.trigger_name = t.tgname
    AND te.trigger_table = c.relname
    AND te.trigger_schema = n.nspname

WHERE n.nspname = 'public'
  AND NOT t.tgisinternal  -- Exclude internal/system triggers
  AND metadata.has_permission(c.relname::TEXT, 'read'::TEXT);

COMMENT ON VIEW public.schema_triggers IS
    'Catalog-first view of public triggers with optional metadata overlay.';


-- 4.3 schema_scheduled_functions: Updated to use catalog-first pattern
DROP VIEW IF EXISTS public.schema_scheduled_functions;

CREATE VIEW public.schema_scheduled_functions
WITH (security_invoker = true) AS
SELECT
    sj.function_name,
    -- Overlay from rpc_functions or use smart default
    COALESCE(rf.display_name, initcap(replace(sj.function_name, '_', ' '))) AS display_name,
    rf.description,
    rf.category,
    sj.name AS job_name,
    sj.schedule AS cron_schedule,
    sj.timezone,
    sj.enabled AS schedule_enabled,
    sj.last_run_at,
    sjs.last_run_success,
    sjs.success_rate_percent,
    -- Whether the underlying function is registered
    rf.function_name IS NOT NULL AS is_registered
FROM metadata.scheduled_jobs sj
LEFT JOIN metadata.rpc_functions rf ON rf.function_name = sj.function_name::NAME
LEFT JOIN public.scheduled_job_status sjs ON sjs.id = sj.id
WHERE metadata.is_admin();  -- Admin-only for schedule details

COMMENT ON VIEW public.schema_scheduled_functions IS
    'Admin-only view showing scheduled jobs with optional RPC metadata overlay.';


-- ============================================================================
-- 5. RE-GRANT PERMISSIONS
-- ============================================================================
-- Grants are lost when views are dropped and recreated

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;
GRANT SELECT ON public.schema_triggers TO authenticated, web_anon;
GRANT SELECT ON public.schema_scheduled_functions TO authenticated;  -- Admin check in view


-- ============================================================================
-- 6. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
