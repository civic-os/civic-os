-- Deploy civic_os:v0-36-0-keycloak-sync-triggers to pg
-- requires: v0-36-0-notification-role-helpers

BEGIN;

-- ============================================================================
-- KEYCLOAK SYNC TRIGGERS
-- ============================================================================
-- Version: v0.36.0
-- Purpose: Move Keycloak sync job creation from manual RPC inserts into
--          database triggers on metadata.roles and metadata.user_roles.
--
-- Problem: Keycloak sync jobs are currently enqueued by manual
--   INSERT INTO metadata.river_job inside 4 RPCs (create_role, delete_role,
--   assign_user_role, revoke_user_role). Direct SQL operations (migration
--   scripts, init scripts) silently skip Keycloak sync.
--
-- Solution:
--   1. Refactor refresh_current_user() to diff-based approach so triggers
--      don't fire a storm of revoke+assign jobs on every login.
--   2. Create AFTER INSERT/DELETE triggers on metadata.roles and
--      metadata.user_roles that enqueue sync jobs automatically.
--   3. Remove manual River job INSERTs from the 4 RPCs.
--
-- Result: Any code path that modifies roles or user_roles (RPCs, migrations,
--   init scripts, direct SQL) automatically enqueues Keycloak sync jobs.
-- ============================================================================


-- ============================================================================
-- STEP 1: Refactor refresh_current_user() to diff-based approach
-- ============================================================================
-- BEFORE: DELETE all user_roles, then re-INSERT everything from JWT.
--   This causes N DELETE + N INSERT trigger fires every login, even when
--   roles haven't changed.
--
-- AFTER: Build a filtered role array from JWT, then:
--   Phase 1: FOREACH loop filters system roles, auto-creates unknown roles
--   Phase 2: DELETE only roles no longer in JWT
--   Phase 3: INSERT only new roles from JWT
--   Phase 4: UPDATE synced_at on unchanged roles

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

  v_user_roles := public.get_user_roles();

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
     for lookups. Refactored in v0.36.0.';


-- ============================================================================
-- STEP 2: Create trigger functions in metadata schema
-- ============================================================================
-- These live in metadata (not public) so they're not exposed via PostgREST.
-- SECURITY DEFINER ensures they can INSERT into metadata.river_job regardless
-- of the calling context.

-- 2a. Trigger function for metadata.roles (INSERT or DELETE)
CREATE OR REPLACE FUNCTION metadata.trg_roles_sync_keycloak()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Skip built-in roles — these exist in Keycloak realm config already
    IF NEW.role_key IN ('anonymous', 'user', 'admin', 'editor', 'manager') THEN
      RETURN NEW;
    END IF;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
      'sync_keycloak_role',
      jsonb_build_object(
        'role_name', NEW.role_key,
        'description', COALESCE(NEW.description, ''),
        'action', 'create'
      ),
      'user_provisioning',
      1,
      5,
      NOW(),
      'available'
    );

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
      'sync_keycloak_role',
      jsonb_build_object(
        'role_name', OLD.role_key,
        'description', '',
        'action', 'delete'
      ),
      'user_provisioning',
      1,
      5,
      NOW(),
      'available'
    );

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata.trg_roles_sync_keycloak() IS
  'AFTER INSERT/DELETE trigger on metadata.roles. Enqueues sync_keycloak_role
   River job to create/delete the role in Keycloak. Skips built-in roles
   (anonymous, user, admin, editor, manager) on INSERT. Added in v0.36.0.';


-- 2b. Trigger function for metadata.user_roles (INSERT or DELETE)
CREATE OR REPLACE FUNCTION metadata.trg_user_roles_sync_keycloak()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_role_key TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT role_key INTO v_role_key
    FROM metadata.roles
    WHERE id = NEW.role_id;

    -- If role not found (shouldn't happen due to FK), skip
    IF v_role_key IS NULL THEN
      RETURN NEW;
    END IF;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
      'assign_keycloak_role',
      jsonb_build_object(
        'user_id', NEW.user_id::text,
        'role_name', v_role_key
      ),
      'user_provisioning',
      1,
      5,
      NOW(),
      'available'
    );

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Use LEFT JOIN to handle CASCADE deletes where role may already be gone
    SELECT role_key INTO v_role_key
    FROM metadata.roles
    WHERE id = OLD.role_id;

    -- If role not found (CASCADE deleted), skip — the roles trigger already
    -- enqueued the role deletion job
    IF v_role_key IS NULL THEN
      RETURN OLD;
    END IF;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
      'revoke_keycloak_role',
      jsonb_build_object(
        'user_id', OLD.user_id::text,
        'role_name', v_role_key
      ),
      'user_provisioning',
      1,
      5,
      NOW(),
      'available'
    );

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION metadata.trg_user_roles_sync_keycloak() IS
  'AFTER INSERT/DELETE trigger on metadata.user_roles. Enqueues assign/revoke
   Keycloak role River jobs. On DELETE, skips if role not found (CASCADE from
   role deletion — the roles trigger handles that case). Added in v0.36.0.';


-- ============================================================================
-- STEP 3: Attach triggers
-- ============================================================================

DROP TRIGGER IF EXISTS trg_roles_sync_keycloak ON metadata.roles;
CREATE TRIGGER trg_roles_sync_keycloak
  AFTER INSERT OR DELETE ON metadata.roles
  FOR EACH ROW EXECUTE FUNCTION metadata.trg_roles_sync_keycloak();

DROP TRIGGER IF EXISTS trg_user_roles_sync_keycloak ON metadata.user_roles;
CREATE TRIGGER trg_user_roles_sync_keycloak
  AFTER INSERT OR DELETE ON metadata.user_roles
  FOR EACH ROW EXECUTE FUNCTION metadata.trg_user_roles_sync_keycloak();


-- ============================================================================
-- STEP 4: Remove manual River job INSERTs from RPCs
-- ============================================================================
-- The triggers now handle Keycloak sync, so the RPCs no longer need to
-- manually enqueue jobs. Re-CREATE OR REPLACE each function without the
-- INSERT INTO metadata.river_job block.

-- 4a. assign_user_role() — remove assign_keycloak_role job INSERT
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


-- 4b. revoke_user_role() — remove revoke_keycloak_role job INSERT
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


-- 4c. delete_role() — remove sync_keycloak_role delete job INSERT
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

    -- Keycloak sync is now handled by trg_roles_sync_keycloak trigger
    -- CASCADE on user_roles won't create orphan revoke jobs because
    -- trg_user_roles_sync_keycloak skips when the role no longer exists

    RETURN json_build_object('success', true, 'message', format('Role "%s" deleted', v_role_name));
END;
$$;


-- 4d. create_role() — remove sync_keycloak_role create job INSERT
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
  -- trg_roles_sync_keycloak fires automatically to enqueue Keycloak sync
  INSERT INTO metadata.roles (display_name, description)
  VALUES (TRIM(p_display_name), TRIM(p_description))
  RETURNING id, role_key INTO v_new_role_id, v_role_key;

  RETURN json_build_object(
    'success', true,
    'role_id', v_new_role_id,
    'role_key', v_role_key
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.create_role IS
    'Create a new role. Admin-only. role_key is auto-generated from display_name.
     Keycloak sync is handled by trg_roles_sync_keycloak trigger. Updated in v0.36.0.';


-- ============================================================================
-- STEP 5: NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
