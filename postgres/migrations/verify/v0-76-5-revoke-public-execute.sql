-- Verify civic_os:v0-76-5-revoke-public-execute on pg

BEGIN;

-- 1. Verify ALTER DEFAULT PRIVILEGES is set for the migration-runner role
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_default_acl da
        JOIN pg_roles r ON r.oid = da.defaclrole
        WHERE r.rolname = current_user
          AND da.defaclobjtype = 'f'
          AND da.defaclnamespace = 0
    ) THEN
        RAISE EXCEPTION 'ALTER DEFAULT PRIVILEGES not set for %', current_user;
    END IF;
END;
$$;

-- 2. Verify key functions are NOT executable by web_anon
DO $$
BEGIN
    IF has_function_privilege('web_anon', 'request_upload_url(text,text,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon should not have EXECUTE on request_upload_url';
    END IF;
    IF has_function_privilege('web_anon', 'cancel_series_occurrence(name,bigint,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon should not have EXECUTE on cancel_series_occurrence';
    END IF;
    IF has_function_privilege('web_anon', 'create_notification(uuid,varchar,varchar,varchar,jsonb,text[])', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon should not have EXECUTE on create_notification';
    END IF;
    IF has_function_privilege('web_anon', 'delete_series_with_instances(bigint)', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon should not have EXECUTE on delete_series_with_instances';
    END IF;
    IF has_function_privilege('web_anon', 'enable_entity_notes(name)', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon should not have EXECUTE on enable_entity_notes';
    END IF;
END;
$$;

-- 3. Verify key functions ARE executable by authenticated
DO $$
BEGIN
    IF NOT has_function_privilege('authenticated', 'request_upload_url(text,text,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated should have EXECUTE on request_upload_url';
    END IF;
    IF NOT has_function_privilege('authenticated', 'get_upload_url(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated should have EXECUTE on get_upload_url';
    END IF;
    IF NOT has_function_privilege('authenticated', 'create_entity_note(name,text,text,varchar,boolean,uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated should have EXECUTE on create_entity_note';
    END IF;
END;
$$;

-- 4. Verify anon functions still work
DO $$
BEGIN
    IF NOT has_function_privilege('web_anon', 'check_jwt()', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon must retain EXECUTE on check_jwt';
    END IF;
    IF NOT has_function_privilege('web_anon', 'current_user_id()', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon must retain EXECUTE on current_user_id';
    END IF;
    IF NOT has_function_privilege('web_anon', 'has_permission(text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon must retain EXECUTE on has_permission';
    END IF;
    IF NOT has_function_privilege('web_anon', 'get_dashboards()', 'EXECUTE') THEN
        RAISE EXCEPTION 'web_anon must retain EXECUTE on get_dashboards';
    END IF;
END;
$$;

-- 5. Verify _is_db_admin uses session_user (function source check)
DO $$
DECLARE
    v_src TEXT;
BEGIN
    SELECT prosrc INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'metadata' AND p.proname = '_is_db_admin';

    IF v_src NOT LIKE '%session_user%' THEN
        RAISE EXCEPTION '_is_db_admin should use session_user, not current_user';
    END IF;
END;
$$;

-- 6. Verify schema decision exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM metadata.schema_decisions
        WHERE migration_id = 'v0-76-5-revoke-public-execute'
    ) THEN
        RAISE EXCEPTION 'Schema decision ADR not found';
    END IF;
END;
$$;

ROLLBACK;
