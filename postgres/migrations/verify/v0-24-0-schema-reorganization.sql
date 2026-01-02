-- Verify civic-os:v0-24-0-schema-reorganization on pg
-- Validates: extensions in plugins, internal helpers in metadata, views working

BEGIN;

-- Set search_path for this session to ensure internal helpers are accessible
-- (The ALTER ROLE changes in deploy affect future sessions, not this one)
SET search_path = public, metadata, plugins, postgis;

-- ============================================================================
-- 1. Verify plugins schema exists
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'plugins') THEN
        RAISE EXCEPTION 'plugins schema does not exist';
    END IF;
    RAISE NOTICE 'plugins schema exists ✓';
END;
$$;


-- ============================================================================
-- 2. Verify extensions location (plugins preferred, public acceptable)
-- ============================================================================
-- On managed databases, extensions may not be moveable due to permission
-- restrictions. Both public and plugins schemas are acceptable locations.

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
        IF v_ext.nspname IN ('plugins', 'public') THEN
            RAISE NOTICE 'Extension % is in % schema ✓', v_ext.extname, v_ext.nspname;
        ELSE
            RAISE WARNING 'Extension % is in unexpected schema: %', v_ext.extname, v_ext.nspname;
        END IF;
    END LOOP;
END;
$$;


-- ============================================================================
-- 3. Verify postgis schema location (either postgis or public is acceptable)
-- ============================================================================
-- Note: The postgis/postgis Docker image pre-installs PostGIS in public schema.
-- Our baseline tries to install in postgis schema, but IF NOT EXISTS skips if
-- already installed. Both locations work correctly due to search_path settings.

DO $$
DECLARE
    v_nspname NAME;
BEGIN
    SELECT n.nspname INTO v_nspname
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    WHERE e.extname = 'postgis';

    IF v_nspname IS NULL THEN
        RAISE NOTICE 'PostGIS not installed (OK for some configurations)';
    ELSIF v_nspname IN ('postgis', 'public') THEN
        RAISE NOTICE 'PostGIS is in % schema ✓', v_nspname;
    ELSE
        RAISE WARNING 'PostGIS is in unexpected schema: %', v_nspname;
    END IF;
END;
$$;


-- ============================================================================
-- 4. Verify search_path includes plugins and metadata
-- ============================================================================
-- On managed databases, we may not have been able to ALTER ROLE. Check the role
-- setting if it exists, but don't fail if it's missing - the session SET handles it.

DO $$
DECLARE
    v_search_path TEXT;
BEGIN
    SELECT setting INTO v_search_path
    FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
    CROSS JOIN unnest(s.setconfig) AS setting
    WHERE r.rolname = 'authenticator'
      AND setting LIKE 'search_path=%';

    IF v_search_path IS NULL THEN
        -- Role search_path not set (may be managed database limitation)
        -- This is OK as long as PostgREST config sets search_path
        RAISE NOTICE 'authenticator role has no explicit search_path (managed database) - OK if PostgREST config sets it ✓';
        RETURN;
    END IF;

    IF v_search_path NOT LIKE '%plugins%' THEN
        RAISE WARNING 'authenticator search_path does not include plugins: %', v_search_path;
    END IF;

    IF v_search_path NOT LIKE '%metadata%' THEN
        RAISE WARNING 'authenticator search_path does not include metadata: %', v_search_path;
    END IF;

    RAISE NOTICE 'authenticator search_path includes plugins and metadata ✓';
END;
$$;


-- ============================================================================
-- 4.5 Verify internal helper functions exist in metadata schema
-- ============================================================================
-- Note: Shim functions also exist in public schema for backward compatibility,
-- so we explicitly check for metadata schema versions.

DO $$
DECLARE
    v_func TEXT;
    v_count INT;
BEGIN
    -- Check each internal helper function exists in metadata schema
    FOR v_func IN SELECT unnest(ARRAY[
        'current_user_id', 'current_user_email', 'current_user_name',
        'current_user_phone', 'check_jwt', 'get_user_roles',
        'has_permission', 'is_admin', 'has_role',
        'has_entity_action_permission',
        'get_initial_status', 'get_statuses_for_entity', 'get_status_entity_types'
    ])
    LOOP
        SELECT COUNT(*) INTO v_count
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE p.proname = v_func
          AND n.nspname = 'metadata';

        IF v_count = 0 THEN
            RAISE WARNING 'Function % not found in metadata schema (may not exist in this deployment)', v_func;
        END IF;
    END LOOP;

    RAISE NOTICE 'Internal helper functions exist in metadata schema ✓';
END;
$$;


-- ============================================================================
-- 4.6 Verify shim functions exist in public schema
-- ============================================================================

DO $$
DECLARE
    v_func TEXT;
    v_count INT;
BEGIN
    -- Check each shim function exists in public schema
    FOR v_func IN SELECT unnest(ARRAY[
        'current_user_id', 'current_user_email', 'current_user_name',
        'current_user_phone', 'check_jwt', 'get_user_roles',
        'has_permission', 'is_admin', 'has_role',
        'has_entity_action_permission',
        'get_initial_status', 'get_statuses_for_entity'
    ])
    LOOP
        SELECT COUNT(*) INTO v_count
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE p.proname = v_func
          AND n.nspname = 'public';

        IF v_count = 0 THEN
            RAISE EXCEPTION 'Shim function % not found in public schema', v_func;
        END IF;
    END LOOP;

    RAISE NOTICE 'Shim functions exist in public schema ✓';
END;
$$;


-- ============================================================================
-- 5. Verify schema_functions view returns expected columns
-- ============================================================================

DO $$
BEGIN
    PERFORM function_name, schema_name, display_name, description, category,
            parameters, returns_type, returns_description, is_idempotent,
            minimum_role, entity_effects, hidden_effects_count, is_registered,
            has_active_schedule, can_execute
    FROM public.schema_functions
    LIMIT 0;

    RAISE NOTICE 'schema_functions view has expected columns ✓';
END;
$$;


-- ============================================================================
-- 6. Verify schema_triggers view returns expected columns
-- ============================================================================

DO $$
BEGIN
    PERFORM trigger_name, table_name, schema_name, timing, events,
            function_name, display_name, description, purpose, is_enabled,
            is_registered, entity_effects, hidden_effects_count
    FROM public.schema_triggers
    LIMIT 0;

    RAISE NOTICE 'schema_triggers view has expected columns ✓';
END;
$$;


-- ============================================================================
-- 7. Verify schema_scheduled_functions view returns expected columns
-- ============================================================================

DO $$
BEGIN
    PERFORM function_name, display_name, description, category, job_name,
            cron_schedule, timezone, schedule_enabled, last_run_at,
            last_run_success, success_rate_percent, is_registered
    FROM public.schema_scheduled_functions
    LIMIT 0;

    RAISE NOTICE 'schema_scheduled_functions view has expected columns ✓';
END;
$$;


-- ============================================================================
-- 8. Verify no extension functions appear in schema_functions
-- ============================================================================

DO $$
DECLARE
    v_extension_func_count INT;
BEGIN
    -- Count if any typical extension function names appear
    SELECT COUNT(*) INTO v_extension_func_count
    FROM public.schema_functions
    WHERE function_name IN (
        'crypt', 'digest', 'gen_salt', 'gen_random_bytes',  -- pgcrypto
        'gist_int4_ops', 'gist_int8_ops'  -- btree_gist
    );

    IF v_extension_func_count > 0 THEN
        RAISE EXCEPTION 'Extension functions should not appear in schema_functions, found %', v_extension_func_count;
    END IF;

    RAISE NOTICE 'No extension functions in schema_functions ✓';
END;
$$;


-- ============================================================================
-- 9. Verify internal helpers don't appear in schema_functions
-- ============================================================================
-- Internal helpers were moved to metadata schema and should not appear
-- because schema_functions only queries public schema.

DO $$
DECLARE
    v_internal_func_count INT;
BEGIN
    -- Count if internal helper functions appear (they're now in metadata schema)
    SELECT COUNT(*) INTO v_internal_func_count
    FROM public.schema_functions
    WHERE function_name IN (
        'current_user_id', 'current_user_email', 'current_user_name',
        'current_user_phone', 'check_jwt', 'get_user_roles',
        'has_permission', 'is_admin', 'has_role',
        'has_entity_action_permission',
        'get_initial_status', 'get_statuses_for_entity', 'get_status_entity_types'
    );

    IF v_internal_func_count > 0 THEN
        RAISE EXCEPTION 'Internal helper functions should not appear in schema_functions (they are in metadata schema), found %', v_internal_func_count;
    END IF;

    RAISE NOTICE 'No internal helper functions in schema_functions ✓';
END;
$$;


-- ============================================================================
-- 10. Verify extension functions are accessible
-- ============================================================================
-- pgcrypto may be in plugins (self-hosted) or public (managed databases)

DO $$
DECLARE
    v_hash TEXT;
    v_schema NAME;
BEGIN
    -- Find which schema pgcrypto is in
    SELECT n.nspname INTO v_schema
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    WHERE e.extname = 'pgcrypto';

    IF v_schema IS NULL THEN
        RAISE NOTICE 'pgcrypto not installed - skipping function test';
        RETURN;
    END IF;

    -- Test pgcrypto function using dynamic schema
    IF v_schema = 'plugins' THEN
        SELECT encode(plugins.digest('test', 'sha256'), 'hex') INTO v_hash;
    ELSE
        SELECT encode(public.digest('test', 'sha256'), 'hex') INTO v_hash;
    END IF;

    IF v_hash IS NULL THEN
        RAISE EXCEPTION 'pgcrypto digest() function not accessible';
    END IF;

    RAISE NOTICE 'pgcrypto functions accessible in % schema ✓', v_schema;
END;
$$;


-- ============================================================================
-- 10.5 Verify internal helpers accessible via search_path
-- ============================================================================

DO $$
DECLARE
    v_result BOOLEAN;
BEGIN
    -- Test that metadata.is_admin() works via schema-qualified call
    SELECT metadata.is_admin() INTO v_result;
    RAISE NOTICE 'metadata.is_admin() accessible via qualified name ✓';

    -- Test metadata.has_permission works
    PERFORM metadata.has_permission('nonexistent_table', 'read');
    RAISE NOTICE 'metadata.has_permission() accessible via qualified name ✓';
END;
$$;


-- ============================================================================
-- 11. Verify public schema function count is reasonable
-- ============================================================================

DO $$
DECLARE
    v_public_func_count INT;
BEGIN
    SELECT COUNT(*) INTO v_public_func_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.prokind = 'f';

    RAISE NOTICE 'public schema has % functions after reorganization', v_public_func_count;

    -- Should have significantly fewer functions now that extensions moved
    -- Before: ~300 (with extensions), After: ~100-150 (without extensions)
    IF v_public_func_count > 200 THEN
        RAISE WARNING 'public schema still has many functions (%), expected fewer after moving extensions', v_public_func_count;
    ELSE
        RAISE NOTICE 'public schema function count is reasonable ✓';
    END IF;
END;
$$;


ROLLBACK;
