-- Revert civic_os:v0-43-1-resolve-role-key from pg
--
-- Restore all functions to their v0.43.0 / v0.36.0 versions (role_key-only
-- lookup, no resolve_role_key helper).

BEGIN;

-- ============================================================================
-- 1. Restore can_manage_role() to v0.36.0 version (direct role_key lookup)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_manage_role(p_role_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_user_roles TEXT[];
BEGIN
    IF is_admin() THEN
        RETURN true;
    END IF;

    v_user_roles := get_user_roles();

    RETURN EXISTS (
        SELECT 1
        FROM metadata.role_can_manage rcm
        JOIN metadata.roles mr ON mr.id = rcm.manager_role_id
        JOIN metadata.roles tr ON tr.id = rcm.managed_role_id
        WHERE mr.role_key = ANY(v_user_roles)
          AND tr.role_key = p_role_name
    );
END;
$$;

-- ============================================================================
-- 2. Restore create_provisioned_user() to v0.43.0 version
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_provisioned_user(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION public.create_provisioned_user(
    p_email TEXT,
    p_first_name TEXT,
    p_last_name TEXT,
    p_phone TEXT DEFAULT NULL,
    p_initial_roles TEXT[] DEFAULT ARRAY['user'],
    p_send_welcome_email BOOLEAN DEFAULT true,
    p_send_welcome_sms BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_name TEXT;
    v_provision_id BIGINT;
    v_initial_roles TEXT[];
BEGIN
    IF NOT metadata.has_permission('civic_os_users_private', 'create') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    v_initial_roles := COALESCE(p_initial_roles, ARRAY['user']);
    IF array_length(v_initial_roles, 1) IS NULL THEN
        v_initial_roles := ARRAY['user'];
    END IF;

    -- Validate each role by role_key
    FOREACH v_role_name IN ARRAY v_initial_roles LOOP
        IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE role_key = v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Role "%s" does not exist', v_role_name));
        END IF;

        IF NOT can_manage_role(v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Your role cannot assign the "%s" role', v_role_name));
        END IF;
    END LOOP;

    INSERT INTO metadata.user_provisioning (
        email, first_name, last_name, phone,
        initial_roles, send_welcome_email, send_welcome_sms,
        status, requested_by
    ) VALUES (
        p_email::email_address,
        p_first_name,
        p_last_name,
        p_phone::phone_number,
        v_initial_roles,
        COALESCE(p_send_welcome_email, true),
        COALESCE(p_send_welcome_sms, false),
        'pending',
        current_user_id()
    )
    RETURNING id INTO v_provision_id;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'provision_keycloak_user',
        jsonb_build_object('provision_id', v_provision_id),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true, 'provision_id', v_provision_id);
END;
$$;

-- ============================================================================
-- 3. Restore bulk_provision_users() to v0.43.0 version
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bulk_provision_users(
    p_users JSON
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_user JSON;
    v_index INT := 0;
    v_created_count INT := 0;
    v_error_count INT := 0;
    v_errors JSON[] := ARRAY[]::JSON[];
    v_role_name TEXT;
    v_initial_roles TEXT[];
    v_provision_id BIGINT;
    v_email TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
    v_phone TEXT;
    v_send_welcome_email BOOLEAN;
    v_send_welcome_sms BOOLEAN;
BEGIN
    IF NOT metadata.has_permission('civic_os_users_private', 'create') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    FOR v_user IN SELECT * FROM json_array_elements(p_users)
    LOOP
        v_index := v_index + 1;
        v_email := v_user->>'email';
        v_first_name := v_user->>'first_name';
        v_last_name := v_user->>'last_name';
        v_phone := v_user->>'phone';
        v_send_welcome_email := COALESCE((v_user->>'send_welcome_email')::BOOLEAN, true);
        v_send_welcome_sms := COALESCE((v_user->>'send_welcome_sms')::BOOLEAN, false);

        IF v_user->'initial_roles' IS NOT NULL AND v_user->>'initial_roles' != 'null' THEN
            SELECT array_agg(r::TEXT) INTO v_initial_roles
            FROM json_array_elements_text(v_user->'initial_roles') r;
        ELSE
            v_initial_roles := ARRAY['user'];
        END IF;

        IF array_length(v_initial_roles, 1) IS NULL THEN
            v_initial_roles := ARRAY['user'];
        END IF;

        BEGIN
            -- Validate roles by role_key
            FOREACH v_role_name IN ARRAY v_initial_roles LOOP
                IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE role_key = v_role_name) THEN
                    RAISE EXCEPTION 'Role "%" does not exist', v_role_name;
                END IF;
                IF NOT can_manage_role(v_role_name) THEN
                    RAISE EXCEPTION 'Your role cannot assign the "%" role', v_role_name;
                END IF;
            END LOOP;

            INSERT INTO metadata.user_provisioning (
                email, first_name, last_name, phone,
                initial_roles, send_welcome_email, send_welcome_sms,
                status, requested_by
            ) VALUES (
                v_email::email_address,
                v_first_name,
                v_last_name,
                v_phone::phone_number,
                v_initial_roles,
                v_send_welcome_email,
                v_send_welcome_sms,
                'pending',
                current_user_id()
            )
            RETURNING id INTO v_provision_id;

            INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
            VALUES (
                'provision_keycloak_user',
                jsonb_build_object('provision_id', v_provision_id),
                'user_provisioning',
                1,
                5,
                NOW(),
                'available'
            );

            v_created_count := v_created_count + 1;
        EXCEPTION WHEN OTHERS THEN
            v_error_count := v_error_count + 1;
            v_errors := array_append(v_errors, json_build_object(
                'index', v_index,
                'email', v_email,
                'error', SQLERRM
            ));
        END;
    END LOOP;

    RETURN json_build_object(
        'success', v_error_count = 0,
        'created_count', v_created_count,
        'error_count', v_error_count,
        'errors', COALESCE(array_to_json(v_errors), '[]'::JSON)
    );
END;
$$;

-- ============================================================================
-- 4. Restore assign_user_role() to v0.36.0 version
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assign_user_role(
    p_user_id UUID,
    p_role_name TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_id SMALLINT;
BEGIN
    IF NOT can_manage_role(p_role_name) THEN
        RETURN json_build_object(
            'success', false,
            'error', format('Your role cannot assign the "%s" role', p_role_name)
        );
    END IF;

    SELECT id INTO v_role_id FROM metadata.roles WHERE role_key = p_role_name;
    IF v_role_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', format('Role "%s" not found', p_role_name));
    END IF;

    INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
    VALUES (p_user_id, v_role_id, NOW())
    ON CONFLICT (user_id, role_id) DO UPDATE SET synced_at = NOW();

    -- Keycloak sync is now handled by trg_user_roles_sync_keycloak trigger

    RETURN json_build_object('success', true, 'message', format('Role "%s" assigned', p_role_name));
END;
$$;

-- ============================================================================
-- 5. Restore revoke_user_role() to v0.36.0 version
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revoke_user_role(
    p_user_id UUID,
    p_role_name TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_id SMALLINT;
BEGIN
    IF NOT can_manage_role(p_role_name) THEN
        RETURN json_build_object(
            'success', false,
            'error', format('Your role cannot revoke the "%s" role', p_role_name)
        );
    END IF;

    SELECT id INTO v_role_id FROM metadata.roles WHERE role_key = p_role_name;
    IF v_role_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', format('Role "%s" not found', p_role_name));
    END IF;

    DELETE FROM metadata.user_roles
    WHERE user_id = p_user_id AND role_id = v_role_id;

    -- Keycloak sync is now handled by trg_user_roles_sync_keycloak trigger

    RETURN json_build_object('success', true, 'message', format('Role "%s" revoked', p_role_name));
END;
$$;

-- ============================================================================
-- 6. Drop resolve_role_key() helper
-- ============================================================================

DROP FUNCTION IF EXISTS public.resolve_role_key(TEXT);

NOTIFY pgrst, 'reload schema';

COMMIT;
