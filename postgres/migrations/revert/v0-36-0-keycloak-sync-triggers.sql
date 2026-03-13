-- Revert civic_os:v0-36-0-keycloak-sync-triggers from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE RPCs with manual River job INSERTs
-- ============================================================================
-- These are the v0-36-0-add-role-key versions (role_key lookups + manual jobs)

-- 1a. RESTORE assign_user_role (with manual assign_keycloak_role job)
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

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'assign_keycloak_role',
        jsonb_build_object(
            'user_id', p_user_id::text,
            'role_name', p_role_name
        ),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true, 'message', format('Role "%s" assigned', p_role_name));
END;
$$;


-- 1b. RESTORE revoke_user_role (with manual revoke_keycloak_role job)
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

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'revoke_keycloak_role',
        jsonb_build_object(
            'user_id', p_user_id::text,
            'role_name', p_role_name
        ),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true, 'message', format('Role "%s" revoked', p_role_name));
END;
$$;


-- 1c. RESTORE delete_role (with manual sync_keycloak_role delete job)
CREATE OR REPLACE FUNCTION public.delete_role(p_role_id SMALLINT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_name TEXT;
    v_role_key TEXT;
BEGIN
    IF NOT is_admin() THEN
        RETURN json_build_object('success', false, 'error', 'Admin access required');
    END IF;

    SELECT display_name, role_key INTO v_role_name, v_role_key
    FROM metadata.roles WHERE id = p_role_id;
    IF v_role_name IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Role not found');
    END IF;

    -- Prevent deleting built-in roles (check by role_key for stability)
    IF v_role_key IN ('anonymous', 'user', 'admin') THEN
        RETURN json_build_object('success', false, 'error', format('Cannot delete built-in role "%s"', v_role_name));
    END IF;

    DELETE FROM metadata.roles WHERE id = p_role_id;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'sync_keycloak_role',
        jsonb_build_object(
            'role_name', v_role_key,
            'description', '',
            'action', 'delete'
        ),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true, 'message', format('Role "%s" deleted', v_role_name));
END;
$$;


-- 1d. RESTORE create_role (with manual sync_keycloak_role create job)
CREATE OR REPLACE FUNCTION public.create_role(
  p_display_name TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_new_role_id SMALLINT;
  v_role_key TEXT;
  v_exists BOOLEAN;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin access required'
    );
  END IF;

  IF p_display_name IS NULL OR TRIM(p_display_name) = '' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Role name cannot be empty'
    );
  END IF;

  -- Generate the role_key to check for uniqueness
  v_role_key := LOWER(REGEXP_REPLACE(TRIM(p_display_name), '[^a-zA-Z0-9]+', '_', 'g'));

  -- Check if role with this role_key already exists
  SELECT EXISTS (
    SELECT 1
    FROM metadata.roles
    WHERE role_key = v_role_key
  ) INTO v_exists;

  IF v_exists THEN
    RETURN json_build_object(
      'success', false,
      'error', format('Role with key "%s" already exists', v_role_key)
    );
  END IF;

  -- Insert the new role (trigger auto-generates role_key)
  INSERT INTO metadata.roles (display_name, description)
  VALUES (TRIM(p_display_name), TRIM(p_description))
  RETURNING id, role_key INTO v_new_role_id, v_role_key;

  -- Enqueue Keycloak sync job (use role_key as the Keycloak role name)
  INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
  VALUES (
      'sync_keycloak_role',
      jsonb_build_object(
          'role_name', v_role_key,
          'description', COALESCE(TRIM(p_description), ''),
          'action', 'create'
      ),
      'user_provisioning',
      1,
      5,
      NOW(),
      'available'
  );

  RETURN json_build_object(
    'success', true,
    'role_id', v_new_role_id,
    'role_key', v_role_key
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.create_role IS
    'Create a new role. Admin-only. role_key is auto-generated from display_name.
     Enqueues Keycloak sync job using role_key. Updated in v0.36.0.';


-- ============================================================================
-- 2. RESTORE refresh_current_user() to DELETE-all + re-INSERT pattern
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_user_roles TEXT[];
  v_role_name TEXT;
  v_role_id SMALLINT;
  v_result metadata.civic_os_users;
BEGIN
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();
  v_phone := public.current_user_phone();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        updated_at = NOW();

  v_user_roles := public.get_user_roles();

  DELETE FROM metadata.user_roles WHERE user_id = v_user_id;

  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    IF metadata.is_keycloak_system_role(v_role_name) THEN
      CONTINUE;
    END IF;

    -- Lookup role_id by role_key (JWT role names match role_key)
    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE role_key = v_role_name;

    -- If role doesn't exist, auto-create it from JWT claim.
    -- Explicitly set role_key = display_name to match the Keycloak role name
    -- (bypasses trigger's snake_case transformation for JWT-sourced roles).
    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, role_key)
      VALUES (v_role_name, v_role_name)
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
    VALUES (v_user_id, v_role_id, NOW())
    ON CONFLICT (user_id, role_id) DO UPDATE
      SET synced_at = NOW();
  END LOOP;

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS
    'Sync current user data from JWT claims to database. Includes name, email,
     phone, and roles. Skips Keycloak system roles. Uses role_key for lookups.
     Updated in v0.36.0.';


-- ============================================================================
-- 3. DROP triggers
-- ============================================================================

DROP TRIGGER IF EXISTS trg_roles_sync_keycloak ON metadata.roles;
DROP TRIGGER IF EXISTS trg_user_roles_sync_keycloak ON metadata.user_roles;


-- ============================================================================
-- 4. DROP trigger functions
-- ============================================================================

DROP FUNCTION IF EXISTS metadata.trg_roles_sync_keycloak();
DROP FUNCTION IF EXISTS metadata.trg_user_roles_sync_keycloak();


-- ============================================================================
-- 5. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
