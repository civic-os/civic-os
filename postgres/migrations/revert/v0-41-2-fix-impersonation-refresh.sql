-- Revert civic_os:v0-41-2-fix-impersonation-refresh from pg

BEGIN;

-- ============================================================================
-- 1. Restore refresh_current_user() to use get_user_roles() (v0-36-0 version)
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

  -- REVERTED: back to get_user_roles() (has impersonation bug)
  v_user_roles := public.get_user_roles();

  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    IF metadata.is_keycloak_system_role(v_role_name) THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE role_key = v_role_name;

    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, role_key)
      VALUES (v_role_name, v_role_name)
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    v_filtered_roles := array_append(v_filtered_roles, v_role_name);
  END LOOP;

  DELETE FROM metadata.user_roles
  WHERE user_id = v_user_id
    AND role_id NOT IN (
      SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles)
    );

  INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
  SELECT v_user_id, r.id, NOW()
  FROM metadata.roles r
  WHERE r.role_key = ANY(v_filtered_roles)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.user_roles ur
      WHERE ur.user_id = v_user_id AND ur.role_id = r.id
    );

  UPDATE metadata.user_roles SET synced_at = NOW()
  WHERE user_id = v_user_id
    AND role_id IN (SELECT id FROM metadata.roles WHERE role_key = ANY(v_filtered_roles));

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- 2. Restore get_user_roles() with myclient fallback (v0-26-0 version)
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.get_user_roles()
RETURNS TEXT[] AS $$
DECLARE
  jwt_claims JSON;
  jwt_sub TEXT;
  roles_array TEXT[];
  request_headers JSON;
  impersonate_header TEXT;
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

  BEGIN
    IF jwt_claims->'realm_access'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'realm_access'->'roles'))
      INTO roles_array;
    ELSIF jwt_claims->'resource_access'->'myclient'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'resource_access'->'myclient'->'roles'))
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

  IF 'admin' = ANY(roles_array) THEN
    BEGIN
      request_headers := current_setting('request.headers', true)::JSON;
      impersonate_header := request_headers->>'x-impersonate-roles';

      IF impersonate_header IS NOT NULL AND impersonate_header != '' THEN
        SELECT ARRAY(
          SELECT trim(unnest(string_to_array(impersonate_header, ',')))
        ) INTO roles_array;

        RETURN roles_array;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN roles_array;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ============================================================================
-- 3. Restore is_real_admin() with myclient fallback (v0-26-0 version)
-- ============================================================================

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

  BEGIN
    IF jwt_claims->'realm_access'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'realm_access'->'roles'))
      INTO roles_array;
    ELSIF jwt_claims->'resource_access'->'myclient'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'resource_access'->'myclient'->'roles'))
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
-- 4. Drop protect_builtin_roles trigger and function
-- ============================================================================

DROP TRIGGER IF EXISTS trg_protect_builtin_roles ON metadata.roles;
DROP FUNCTION IF EXISTS metadata.protect_builtin_roles();


-- ============================================================================
-- 5. Restore delete_role() without affected_users (v0-36-0 version)
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
BEGIN
    IF NOT is_admin() THEN
        RETURN json_build_object('success', false, 'error', 'Admin access required');
    END IF;

    SELECT display_name, role_key INTO v_role_name, v_role_key
    FROM metadata.roles WHERE id = p_role_id;
    IF v_role_name IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Role not found');
    END IF;

    IF v_role_key IN ('anonymous', 'user', 'admin') THEN
        RETURN json_build_object('success', false, 'error', format('Cannot delete built-in role "%s"', v_role_name));
    END IF;

    DELETE FROM metadata.roles WHERE id = p_role_id;

    RETURN json_build_object('success', true, 'message', format('Role "%s" deleted', v_role_name));
END;
$$;


-- ============================================================================
-- 6. Drop get_real_user_roles()
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_real_user_roles();
DROP FUNCTION IF EXISTS metadata.get_real_user_roles();


-- ============================================================================
-- 7. NOTIFY POSTGREST
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
