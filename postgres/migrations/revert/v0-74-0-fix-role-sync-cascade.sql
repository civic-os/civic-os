-- Revert civic_os:v0-74-0-fix-role-sync-cascade from pg
-- Restores the v0-65-0 version of refresh_current_user() (continuous sync behavior)

BEGIN;

-- ============================================================================
-- Restore refresh_current_user() to v0-65-0 version (continuous sync)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_first_name TEXT;
  v_last_name TEXT;
  v_user_roles TEXT[];
  v_role_name TEXT;
  v_role_id SMALLINT;
  v_filtered_roles TEXT[] := '{}';
  v_result metadata.civic_os_users;
BEGIN
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Read first_name/last_name from JWT given_name/family_name claims (OIDC standard)
  -- Fall back to last-space split of display_name for non-OIDC providers
  v_first_name := public.current_user_first_name();
  v_last_name := public.current_user_last_name();

  IF v_first_name IS NULL THEN
    -- Fallback: parse from display_name (supports non-Keycloak providers)
    -- "John Michael Doe" → first="John Michael", last="Doe"
    -- "SingleName" → first="SingleName", last=NULL
    IF position(' ' IN TRIM(v_display_name)) > 0 THEN
      v_last_name := split_part(TRIM(v_display_name), ' ',
                       array_length(string_to_array(TRIM(v_display_name), ' '), 1));
      v_first_name := TRIM(LEFT(TRIM(v_display_name),
                       length(TRIM(v_display_name)) - length(v_last_name) - 1));
    ELSE
      v_first_name := TRIM(v_display_name);
      v_last_name := NULL;
    END IF;
  END IF;

  -- Upsert user record
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert private user record (includes first_name/last_name and last_login_at)
  -- NOTE: phone is intentionally excluded — database is the authority for phone,
  -- not JWT claims. Phone is managed via profile page and admin UI.
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, first_name, last_name, last_login_at, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_first_name, v_last_name, NOW(), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        last_login_at = NOW(),
        updated_at = NOW();

  -- FIX: Use get_real_user_roles() to ignore impersonation header
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
     first_name, last_name, last_login_at, and roles. Phone is NOT synced from JWT —
     database is the authority for phone (managed via profile page and admin UI).
     Uses OIDC given_name/family_name claims with fallback to last-space split.
     Uses diff-based role sync. Skips Keycloak system roles. Uses role_key for lookups.
     v0.65.0: deprecated JWT phone sync.';


-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
