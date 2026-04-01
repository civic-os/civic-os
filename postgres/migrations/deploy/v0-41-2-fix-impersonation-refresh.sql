-- Deploy civic_os:v0-41-2-fix-impersonation-refresh to pg
-- Fix: refresh_current_user() was reading impersonated roles instead of real
-- JWT roles, causing permanent role revocation when admins used impersonation.
-- Also: remove dead 'myclient' code path, protect built-in roles from direct
-- SQL deletion, and add affected_users count to delete_role() response.

BEGIN;

-- ============================================================================
-- FIX 1: Create get_real_user_roles() — reads JWT directly, ignores impersonation
-- ============================================================================
-- Modeled after metadata.is_real_admin() which already bypasses impersonation.
-- Used by refresh_current_user() so role sync always operates on real JWT roles.

CREATE OR REPLACE FUNCTION metadata.get_real_user_roles()
RETURNS TEXT[] AS $$
DECLARE
  jwt_claims JSON;
  jwt_sub TEXT;
  roles_array TEXT[];
BEGIN
  BEGIN
    jwt_claims := current_setting('request.jwt.claims', true)::JSON;
  EXCEPTION WHEN OTHERS THEN
    RETURN ARRAY['anonymous'];
  END;

  IF jwt_claims IS NULL THEN
    RETURN ARRAY['anonymous'];
  END IF;

  jwt_sub := jwt_claims->>'sub';
  IF jwt_sub IS NULL OR jwt_sub = '' THEN
    RETURN ARRAY['anonymous'];
  END IF;

  -- Read roles directly from JWT (no impersonation header check)
  BEGIN
    IF jwt_claims->'realm_access'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'realm_access'->'roles'))
      INTO roles_array;
    ELSIF jwt_claims->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'roles'))
      INTO roles_array;
    ELSE
      roles_array := ARRAY[]::TEXT[];
    END IF;
  EXCEPTION WHEN OTHERS THEN
    roles_array := ARRAY[]::TEXT[];
  END;

  RETURN roles_array;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION metadata.get_real_user_roles() IS
  'Get user roles directly from JWT claims, ignoring impersonation header. '
  'Used by refresh_current_user() to ensure role sync always uses real roles.';

-- Public shim
CREATE OR REPLACE FUNCTION public.get_real_user_roles()
RETURNS TEXT[] AS $$
  SELECT metadata.get_real_user_roles();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION metadata.get_real_user_roles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_real_user_roles() TO authenticated;


-- ============================================================================
-- FIX 2: Update refresh_current_user() to use get_real_user_roles()
-- ============================================================================
-- Only change from v0-36-0: line "v_user_roles := public.get_user_roles()"
-- becomes "v_user_roles := public.get_real_user_roles()"

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
  v_filtered_roles TEXT[] := '{}';
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

  -- Upsert user record
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert private user record
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        updated_at = NOW();

  -- FIX: Use get_real_user_roles() to ignore impersonation header
  -- Previously: v_user_roles := public.get_user_roles();
  v_user_roles := public.get_real_user_roles();

  -- Phase 1: Build filtered roles array (skip system roles, auto-create unknown)
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

    v_filtered_roles := array_append(v_filtered_roles, v_role_name);
  END LOOP;

  -- Phase 2: Delete roles no longer in JWT (triggers fire revoke jobs)
  DELETE FROM metadata.user_roles
  WHERE user_id = v_user_id
    AND role_id NOT IN (
      SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles)
    );

  -- Phase 3: Insert new roles from JWT (triggers fire assign jobs)
  INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
  SELECT v_user_id, r.id, NOW()
  FROM metadata.roles r
  WHERE r.role_key = ANY(v_filtered_roles)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.user_roles ur
      WHERE ur.user_id = v_user_id AND ur.role_id = r.id
    );

  -- Phase 4: Touch synced_at on unchanged roles (no trigger fires)
  UPDATE metadata.user_roles SET synced_at = NOW()
  WHERE user_id = v_user_id
    AND role_id IN (SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles));

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS
    'Sync current user data from JWT claims to database. Includes name, email,
     phone, and roles. Uses diff-based role sync (only inserts/deletes changed
     roles) to avoid trigger storms. Skips Keycloak system roles. Uses role_key
     for lookups. Fixed in v0.41.2 to use get_real_user_roles() instead of
     get_user_roles() to prevent impersonation header from poisoning role sync.';


-- ============================================================================
-- FIX 3: Remove dead 'myclient' code path from get_user_roles() and is_real_admin()
-- ============================================================================

-- 3a. Update get_user_roles() — remove myclient fallback
CREATE OR REPLACE FUNCTION metadata.get_user_roles()
RETURNS TEXT[] AS $$
DECLARE
  jwt_claims JSON;
  jwt_sub TEXT;
  roles_array TEXT[];
  request_headers JSON;
  impersonate_header TEXT;
BEGIN
  -- Get full JWT claims as JSON
  BEGIN
    jwt_claims := current_setting('request.jwt.claims', true)::JSON;
  EXCEPTION WHEN OTHERS THEN
    RETURN ARRAY['anonymous'];
  END;

  IF jwt_claims IS NULL THEN
    RETURN ARRAY['anonymous'];
  END IF;

  -- Extract sub from JSON claims
  jwt_sub := jwt_claims->>'sub';

  IF jwt_sub IS NULL OR jwt_sub = '' THEN
    RETURN ARRAY['anonymous'];
  END IF;

  -- Get real roles from JWT (removed dead client-specific fallback in v0.41.2)
  BEGIN
    IF jwt_claims->'realm_access'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'realm_access'->'roles'))
      INTO roles_array;
    ELSIF jwt_claims->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'roles'))
      INTO roles_array;
    ELSE
      roles_array := ARRAY[]::TEXT[];
    END IF;
  EXCEPTION WHEN OTHERS THEN
    roles_array := ARRAY[]::TEXT[];
  END;

  -- Check for impersonation header (only if real user is admin)
  IF 'admin' = ANY(roles_array) THEN
    BEGIN
      request_headers := current_setting('request.headers', true)::JSON;
      -- PostgREST lowercases header names
      impersonate_header := request_headers->>'x-impersonate-roles';

      IF impersonate_header IS NOT NULL AND impersonate_header != '' THEN
        -- Parse comma-separated roles and return them
        SELECT ARRAY(
          SELECT trim(unnest(string_to_array(impersonate_header, ',')))
        ) INTO roles_array;

        RETURN roles_array;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Header not present or invalid JSON, continue with real roles
      NULL;
    END;
  END IF;

  -- Return real roles
  RETURN roles_array;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 3b. Update is_real_admin() — remove myclient fallback
CREATE OR REPLACE FUNCTION metadata.is_real_admin()
RETURNS BOOLEAN AS $$
DECLARE
  jwt_claims JSON;
  roles_array TEXT[];
BEGIN
  BEGIN
    jwt_claims := current_setting('request.jwt.claims', true)::JSON;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF jwt_claims IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Get roles directly from JWT (removed dead client-specific fallback in v0.41.2)
  BEGIN
    IF jwt_claims->'realm_access'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'realm_access'->'roles'))
      INTO roles_array;
    ELSIF jwt_claims->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'roles'))
      INTO roles_array;
    ELSE
      RETURN FALSE;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  RETURN 'admin' = ANY(roles_array);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ============================================================================
-- FIX 4a: Protect built-in roles from direct SQL deletion
-- ============================================================================
-- delete_role() RPC already checks, but direct SQL bypasses it.

CREATE OR REPLACE FUNCTION metadata.protect_builtin_roles()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role_key IN ('anonymous', 'user', 'admin') THEN
    RAISE EXCEPTION 'Cannot delete built-in role "%" (role_key: %)', OLD.display_name, OLD.role_key;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_builtin_roles
  BEFORE DELETE ON metadata.roles
  FOR EACH ROW
  EXECUTE FUNCTION metadata.protect_builtin_roles();

COMMENT ON FUNCTION metadata.protect_builtin_roles() IS
  'Prevents deletion of built-in roles (anonymous, user, admin) via direct SQL. '
  'The delete_role() RPC already checks this, but this trigger catches bypasses.';


-- ============================================================================
-- FIX 4b: delete_role() reports affected user count
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_role(p_role_id SMALLINT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_name TEXT;
    v_role_key TEXT;
    v_affected_users INT;
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

    -- Count affected users before cascade delete
    SELECT count(*) INTO v_affected_users
    FROM metadata.user_roles WHERE role_id = p_role_id;

    DELETE FROM metadata.roles WHERE id = p_role_id;

    -- Keycloak sync is now handled by trg_roles_sync_keycloak trigger
    -- CASCADE on user_roles will remove assignments; the user_roles trigger
    -- skips revoke jobs when the role no longer exists

    RETURN json_build_object(
      'success', true,
      'message', format('Role "%s" deleted', v_role_name),
      'affected_users', v_affected_users
    );
END;
$$;


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
