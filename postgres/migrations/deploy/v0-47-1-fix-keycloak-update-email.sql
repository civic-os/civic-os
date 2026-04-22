-- Deploy civic_os:v0-47-1-fix-keycloak-update-email to pg
-- requires: v0-47-0-add-photo-gallery

BEGIN;

-- ============================================================================
-- FIX: KEYCLOAK USER UPDATE + REFRESH_CURRENT_USER NAME REGRESSION
-- ============================================================================
-- Version: v0.47.1
-- Purpose:
--   1. Include email in the River job args for update_keycloak_user so the
--      Go worker can send a complete payload to Keycloak's PUT endpoint.
--      Keycloak treats missing fields as null on PUT, so omitting email
--      was clearing the user's email address in Keycloak.
--   2. Restore first_name/last_name parsing in refresh_current_user().
--      The v0.36.0 and v0.41.2 migrations rewrote the function but dropped
--      the first_name/last_name logic added in v0.31.0, leaving those
--      columns NULL for all users who log in.
--
-- Changes:
--   - update_user_info() RPC now includes email in River job args
--   - Go worker (UpdateUser) uses fetch-then-merge to preserve all fields
--   - refresh_current_user() now parses and writes first_name/last_name
-- ============================================================================


-- ============================================================================
-- 1. REPLACE update_user_info() TO INCLUDE EMAIL IN RIVER JOB ARGS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_user_info(
  p_user_id UUID,
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_full_name TEXT;
  v_public_display TEXT;
  v_email TEXT;
BEGIN
  -- Permission check: must have civic_os_users_private:update permission
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RETURN json_build_object('success', false, 'error', 'Permission denied');
  END IF;

  -- Validate required fields
  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  -- Verify user exists
  IF NOT EXISTS (SELECT 1 FROM metadata.civic_os_users WHERE id = p_user_id) THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Build full name and public display name
  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  -- Fetch current email for Keycloak sync
  SELECT email INTO v_email
  FROM metadata.civic_os_users_private
  WHERE id = p_user_id;

  -- Update civic_os_users (public profile)
  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Update civic_os_users_private (private profile)
  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN NULL ELSE TRIM(p_phone) END,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Enqueue River job for async Keycloak sync (now includes email)
  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', p_user_id::TEXT,
      'email', COALESCE(v_email::TEXT, ''),
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name),
      'phone', CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN '' ELSE TRIM(p_phone) END
    )::JSONB,
    'update_keycloak_user',
    'user_provisioning',
    'available',
    1,
    5
  );

  RETURN json_build_object('success', true, 'message', 'User info updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.update_user_info(UUID, TEXT, TEXT, TEXT) IS
    'Update user profile info (name, phone) and enqueue Keycloak sync.
     Requires civic_os_users_private:update permission. Added in v0.31.0.
     Fixed in v0.47.1 to include email in River job args for Keycloak sync.';


-- ============================================================================
-- 2. FIX refresh_current_user() — RESTORE first_name/last_name PARSING
-- ============================================================================
-- Regression: v0.36.0 and v0.41.2 rewrote this function but dropped the
-- first_name/last_name logic that v0.31.0 added. This left those columns
-- NULL for all users, breaking the Edit User modal name fields.

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_phone TEXT;
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
  v_phone := public.current_user_phone();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Parse first_name/last_name from display_name using last-space split
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

  -- Upsert user record
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert private user record (includes first_name/last_name)
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, first_name, last_name, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, v_first_name, v_last_name, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
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
     phone, first_name, last_name, and roles. Uses diff-based role sync (only
     inserts/deletes changed roles) to avoid trigger storms. Skips Keycloak
     system roles. Uses role_key for lookups. Fixed in v0.41.2 to use
     get_real_user_roles(). Fixed in v0.47.1 to restore first_name/last_name
     parsing that was dropped in v0.36.0.';


-- ============================================================================
-- 3. BACKFILL first_name/last_name FOR EXISTING USERS
-- ============================================================================
-- Parse from display_name for any rows still NULL (same logic as v0.31.0 backfill)

UPDATE metadata.civic_os_users_private
SET first_name = CASE
        WHEN position(' ' IN TRIM(display_name)) > 0
        THEN TRIM(LEFT(TRIM(display_name), length(TRIM(display_name)) - length(split_part(TRIM(display_name), ' ', array_length(string_to_array(TRIM(display_name), ' '), 1))) - 1))
        ELSE TRIM(display_name)
    END,
    last_name = CASE
        WHEN position(' ' IN TRIM(display_name)) > 0
        THEN split_part(TRIM(display_name), ' ', array_length(string_to_array(TRIM(display_name), ' '), 1))
        ELSE NULL
    END
WHERE first_name IS NULL
  AND display_name IS NOT NULL
  AND TRIM(display_name) != '';


-- ============================================================================
-- 4. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
