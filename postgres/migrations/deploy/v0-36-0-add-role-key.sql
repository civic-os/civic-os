-- Deploy civic_os:v0-36-0-add-role-key to pg
-- requires: v0-35-0-admin-notification-prefs

BEGIN;

-- ============================================================================
-- ROLE KEY COLUMN
-- ============================================================================
-- Version: v0.36.0
-- Purpose: Add stable, system-internal identifier for roles that decouples
--          the JWT-matching key from the human-readable display name.
--
-- Problem: metadata.roles.display_name currently does double duty:
--   1. Human-readable label shown in the UI
--   2. Programmatic identifier matched against JWT role claims
--   This means renaming a role (e.g., "editor" → "Content Editor") breaks
--   all RBAC checks. status_key (v0.25.1) and category_key (v0.34.0) solved
--   this same problem for their respective tables.
--
-- Solution: Add role_key column - a snake_case identifier that:
--   1. Is auto-generated from display_name on insert
--   2. Never changes once set (INSERT-only trigger = immutable)
--   3. Provides stable reference for JWT matching and code lookups
--   4. Globally unique (no entity_type scoping needed, unlike status_key)
--
-- Usage:
--   -- Instead of: WHERE display_name = 'editor'
--   -- Use: WHERE role_key = 'editor'
--   -- Or helper: SELECT get_role_id('editor')
-- ============================================================================


-- ============================================================================
-- 1. ADD role_key COLUMN
-- ============================================================================

ALTER TABLE metadata.roles
  ADD COLUMN IF NOT EXISTS role_key VARCHAR(50);

COMMENT ON COLUMN metadata.roles.role_key IS
  'Stable, snake_case identifier for programmatic reference and JWT matching.
   Auto-generated from display_name on insert. Immutable once set.
   Use this instead of display_name in code, migrations, and JWT comparisons.
   Convention: lowercase, underscores, no spaces (e.g., admin, content_editor).';


-- ============================================================================
-- 2. GENERATE role_key FOR EXISTING RECORDS
-- ============================================================================
-- MIGRATION SAFETY: Use display_name VERBATIM (no snake_case transformation)
-- to preserve JWT compatibility. Keycloak realm roles are named after display_name,
-- and JWTs carry those same strings. has_permission() now matches role_key against
-- JWT claims, so role_key MUST equal the Keycloak role name for existing roles.
--
-- For production instances:
--   - Built-in roles (admin, editor, user, anonymous) are already lowercase → clean
--   - Custom roles created via UI were validated to [a-zA-Z0-9_]+ → already clean
--   - Roles auto-created from JWT (refresh_current_user) match Keycloak names → preserved
--
-- New roles going forward: trigger auto-generates clean snake_case from display_name,
-- and create_role() syncs role_key (not display_name) to Keycloak.

UPDATE metadata.roles
SET role_key = display_name
WHERE role_key IS NULL;


-- ============================================================================
-- 3. MAKE role_key NOT NULL AND ADD UNIQUE CONSTRAINT
-- ============================================================================

ALTER TABLE metadata.roles
  ALTER COLUMN role_key SET NOT NULL;

-- Globally unique (no entity_type scoping needed for roles)
ALTER TABLE metadata.roles
  ADD CONSTRAINT roles_role_key_unique UNIQUE (role_key);


-- ============================================================================
-- 4. ADD TRIGGER TO AUTO-GENERATE role_key ON INSERT
-- ============================================================================
-- INSERT only = immutable. Once a role_key is set, it cannot change.

CREATE OR REPLACE FUNCTION metadata.set_role_key()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-generate if role_key is NULL or empty
  IF NEW.role_key IS NULL OR TRIM(NEW.role_key) = '' THEN
    NEW.role_key := LOWER(REGEXP_REPLACE(TRIM(NEW.display_name), '[^a-zA-Z0-9]+', '_', 'g'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_roles_set_key ON metadata.roles;
CREATE TRIGGER trg_roles_set_key
  BEFORE INSERT ON metadata.roles
  FOR EACH ROW EXECUTE FUNCTION metadata.set_role_key();

COMMENT ON FUNCTION metadata.set_role_key() IS
  'Auto-generates role_key from display_name if not provided on INSERT.
   INSERT-only trigger ensures immutability. Converts to snake_case:
   "Content Editor" → "content_editor"';


-- ============================================================================
-- 5. ADD HELPER FUNCTION: get_role_id(role_key)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_role_id(p_role_key TEXT)
RETURNS SMALLINT
LANGUAGE SQL
STABLE
AS $$
  SELECT id FROM metadata.roles
  WHERE role_key = p_role_key
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_role_id(TEXT) IS
  'Returns the role ID for a given role_key.
   Use this instead of display_name lookups for stable code references.
   Example: SELECT get_role_id(''admin'');';

GRANT EXECUTE ON FUNCTION public.get_role_id(TEXT) TO web_anon, authenticated;


-- ============================================================================
-- 6. UPDATE SQL FUNCTIONS TO USE role_key
-- ============================================================================
-- All functions that looked up roles by display_name now use role_key.
-- This ensures JWT role strings match role_key (which for existing roles
-- equals the original display_name lowercased with underscores).

-- 6a. metadata.has_permission() — v0-24-0 section 3.5
-- Changed: r.display_name = ANY(user_roles) → r.role_key = ANY(user_roles)
CREATE OR REPLACE FUNCTION metadata.has_permission(
  p_table_name TEXT,
  p_permission TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
  has_perm BOOLEAN;
BEGIN
  user_roles := get_user_roles();

  SELECT EXISTS (
    SELECT 1
    FROM metadata.roles r
    JOIN metadata.permission_roles pr ON pr.role_id = r.id
    JOIN metadata.permissions p ON p.id = pr.permission_id
    WHERE r.role_key = ANY(user_roles)
      AND p.table_name = p_table_name
      AND p.permission::TEXT = p_permission
  ) INTO has_perm;

  RETURN has_perm;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- 6b. metadata.has_role() — v0-11-0, moved to metadata in v0-24-0
-- Changed: r.display_name = p_role_name → r.role_key = p_role_name
CREATE OR REPLACE FUNCTION metadata.has_role(p_user_id UUID, p_role_name TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM metadata.user_roles ur
    JOIN metadata.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND r.role_key = p_role_name
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- 6c. public.refresh_current_user() — v0-31-0 section 0b
-- Changed: role lookup and auto-create both use role_key
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


-- 6d. public.get_roles() — v0-31-0 section 0c
-- Added: role_key to RETURNS TABLE
-- Must DROP first because CREATE OR REPLACE cannot change return type
DROP FUNCTION IF EXISTS public.get_roles();
CREATE FUNCTION public.get_roles()
RETURNS TABLE (
  id SMALLINT,
  display_name TEXT,
  description TEXT,
  role_key TEXT
) AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT r.id, r.display_name, r.description, r.role_key::TEXT
  FROM metadata.roles r
  WHERE NOT metadata.is_keycloak_system_role(r.display_name)
  ORDER BY r.id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- 6e. public.can_manage_role() — v0-31-0 section 8
-- Changed: JOINs use role_key instead of display_name
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


-- 6f. public.get_manageable_roles() — v0-31-0 section 9
-- Added: role_key to RETURNS TABLE; filter uses role_key
-- Must DROP first because CREATE OR REPLACE cannot change return type
DROP FUNCTION IF EXISTS public.get_manageable_roles();
CREATE FUNCTION public.get_manageable_roles()
RETURNS TABLE (role_id SMALLINT, display_name TEXT, description TEXT, role_key TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_user_roles TEXT[];
BEGIN
    IF is_admin() THEN
        RETURN QUERY
        SELECT r.id, r.display_name::TEXT, r.description::TEXT, r.role_key::TEXT
        FROM metadata.roles r
        WHERE NOT metadata.is_keycloak_system_role(r.display_name)
          AND r.role_key != 'anonymous'
        ORDER BY r.display_name;
        RETURN;
    END IF;

    v_user_roles := get_user_roles();

    RETURN QUERY
    SELECT DISTINCT r.id, r.display_name::TEXT, r.description::TEXT, r.role_key::TEXT
    FROM metadata.role_can_manage rcm
    JOIN metadata.roles mr ON mr.id = rcm.manager_role_id
    JOIN metadata.roles r ON r.id = rcm.managed_role_id
    WHERE mr.role_key = ANY(v_user_roles)
      AND r.role_key != 'anonymous'
    ORDER BY r.display_name;
END;
$$;


-- 6g. public.assign_user_role() — v0-31-0 section 10
-- Changed: lookup by role_key instead of display_name
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


-- 6h. public.revoke_user_role() — v0-31-0 section 11
-- Changed: lookup by role_key instead of display_name
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


-- 6i. public.delete_role() — v0-31-0 section 12
-- Changed: built-in protection uses role_key
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


-- 6j. public.get_role_can_manage() — v0-31-0 section 14
-- Added: managed_role_key to RETURNS TABLE
-- Must DROP first because CREATE OR REPLACE cannot change return type
DROP FUNCTION IF EXISTS public.get_role_can_manage(SMALLINT);
CREATE FUNCTION public.get_role_can_manage(p_manager_role_id SMALLINT)
RETURNS TABLE (managed_role_id SMALLINT, managed_role_name TEXT, managed_role_key TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    IF NOT is_admin() THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT rcm.managed_role_id, r.display_name::TEXT, r.role_key::TEXT
    FROM metadata.role_can_manage rcm
    JOIN metadata.roles r ON r.id = rcm.managed_role_id
    WHERE rcm.manager_role_id = p_manager_role_id
    ORDER BY r.display_name;
END;
$$;


-- 6k. public.create_role() — v0-31-0 section 15
-- Changed: uniqueness check uses role_key; Keycloak sync sends role_key
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


-- 6l. public.create_provisioned_user() — v0-31-0 section 17
-- Changed: role validation lookup uses role_key
CREATE OR REPLACE FUNCTION public.create_provisioned_user(
    p_email TEXT,
    p_first_name TEXT,
    p_last_name TEXT,
    p_phone TEXT DEFAULT NULL,
    p_initial_roles TEXT[] DEFAULT ARRAY['user'],
    p_send_welcome_email BOOLEAN DEFAULT true
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
        initial_roles, send_welcome_email,
        status, requested_by
    ) VALUES (
        p_email::email_address,
        p_first_name,
        p_last_name,
        p_phone::phone_number,
        v_initial_roles,
        COALESCE(p_send_welcome_email, true),
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


-- 6m. public.bulk_provision_users() — v0-31-0 section 18b
-- Changed: role validation lookup uses role_key
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
    v_send_welcome BOOLEAN;
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
        v_send_welcome := COALESCE((v_user->>'send_welcome_email')::BOOLEAN, true);

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
                initial_roles, send_welcome_email,
                status, requested_by
            ) VALUES (
                v_email::email_address,
                v_first_name,
                v_last_name,
                v_phone::phone_number,
                v_initial_roles,
                v_send_welcome,
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


-- 6n. public.managed_users VIEW — v0-31-0 section 16
-- Changed: array_agg uses display_name for human-readable role labels
DROP VIEW IF EXISTS public.managed_users;

CREATE VIEW public.managed_users
WITH (security_invoker = true) AS

-- Active users (fully provisioned, have Keycloak accounts)
SELECT
    u.id,
    u.display_name,
    p.display_name AS full_name,
    p.first_name,
    p.last_name,
    p.email::TEXT AS email,
    p.phone::TEXT AS phone,
    'active'::TEXT AS status,
    NULL::TEXT AS error_message,
    COALESCE(
        (SELECT array_agg(r.display_name ORDER BY r.display_name)
         FROM metadata.user_roles ur
         JOIN metadata.roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id
           AND NOT metadata.is_keycloak_system_role(r.display_name)
           AND r.role_key != 'anonymous'),
        (SELECT up2.initial_roles
         FROM metadata.user_provisioning up2
         WHERE up2.keycloak_user_id = u.id
         ORDER BY up2.completed_at DESC NULLS LAST
         LIMIT 1)
    ) AS roles,
    u.created_at,
    NULL::BIGINT AS provision_id,
    np_email.enabled AS email_notif_enabled,
    np_sms.enabled AS sms_notif_enabled,
    np_sms.sms_opted_out
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id
LEFT JOIN metadata.notification_preferences np_email
    ON np_email.user_id = u.id AND np_email.channel = 'email'
LEFT JOIN metadata.notification_preferences np_sms
    ON np_sms.user_id = u.id AND np_sms.channel = 'sms'

UNION ALL

-- Pending/failed provisioning requests (not yet in civic_os_users)
SELECT
    up.keycloak_user_id AS id,
    (up.first_name || ' ' || substring(up.last_name from 1 for 1) || '.')::TEXT AS display_name,
    (up.first_name || ' ' || up.last_name)::TEXT AS full_name,
    up.first_name,
    up.last_name,
    up.email::TEXT,
    up.phone::TEXT,
    up.status::TEXT,
    up.error_message,
    up.initial_roles AS roles,
    up.created_at,
    up.id AS provision_id,
    NULL::BOOLEAN AS email_notif_enabled,
    NULL::BOOLEAN AS sms_notif_enabled,
    NULL::BOOLEAN AS sms_opted_out
FROM metadata.user_provisioning up
WHERE up.status NOT IN ('completed');

COMMENT ON VIEW public.managed_users IS
    'Combined view of all users for admin User Management page. Active users
     from civic_os_users UNION pending/failed provisioning requests.
     roles array contains display_name values (human-readable labels).
     Updated in v0.36.0.';

GRANT SELECT ON public.managed_users TO authenticated;


-- ============================================================================
-- 7. UPDATE schema_functions EXCLUSION LIST
-- ============================================================================
-- Add get_role_id to the exclusion list so it doesn't appear in System Functions

DROP VIEW IF EXISTS public.parsed_source_code;
DROP VIEW IF EXISTS public.schema_functions;

CREATE VIEW public.schema_functions
WITH (security_invoker = true) AS
WITH
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
    COALESCE(rf.display_name, initcap(replace(p.proname::text, '_', ' '))) AS display_name,
    rf.description,
    rf.category,
    rf.parameters,
    pg_get_function_result(p.oid) AS returns_type,
    rf.returns_description,
    COALESCE(rf.is_idempotent, false) AS is_idempotent,
    rf.minimum_role,
    COALESCE(ee.visible_effects, '[]'::jsonb) AS entity_effects,
    COALESCE(ee.hidden_count, 0) AS hidden_effects_count,
    rf.function_name IS NOT NULL AS is_registered,
    EXISTS (
        SELECT 1 FROM metadata.scheduled_jobs sj
        WHERE sj.function_name = p.proname::TEXT
          AND sj.enabled = true
    ) AS has_active_schedule,
    CASE
        WHEN EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
        THEN EXISTS (
            SELECT 1 FROM metadata.entity_actions ea
            WHERE ea.rpc_function = p.proname::NAME
              AND metadata.has_entity_action_permission(ea.id)
        )
        ELSE true
    END AS can_execute,
    pg_get_functiondef(p.oid) AS source_code,
    l.lanname AS language,
    psc.ast_json

FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN metadata.rpc_functions rf ON rf.function_name = p.proname
LEFT JOIN entity_effects ee ON ee.function_name = p.proname
LEFT JOIN metadata.parsed_source_code psc
    ON psc.object_name = p.proname AND psc.object_type = 'function'

WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND p.proname NOT IN (
      'is_admin', 'has_permission', 'get_user_roles',
      'current_user_id', 'current_user_email', 'current_user_name', 'current_user_phone',
      'check_jwt', 'get_initial_status', 'get_statuses_for_entity', 'get_status_entity_types',
      'has_role', 'has_entity_action_permission',
      'refresh_current_user',
      'grant_entity_action_permission', 'revoke_entity_action_permission', 'get_entity_action_roles',
      'upsert_entity_metadata', 'upsert_property_metadata',
      'update_entity_sort_order', 'update_property_sort_order',
      'create_role', 'get_roles', 'get_role_permissions',
      'set_role_permission', 'ensure_table_permissions', 'enable_entity_notes',
      'get_dashboards', 'get_dashboard', 'get_user_default_dashboard',
      'schema_relations_func', 'schema_view_relations_func', 'schema_view_validations_func',
      'set_created_at', 'set_updated_at', 'set_file_created_by',
      'add_status_change_note', 'add_payment_status_change_note',
      'add_reservation_status_change_note', 'validate_status_entity_type',
      'enqueue_notification_job', 'create_notification', 'create_default_notification_preferences',
      'notify_new_reservation_request', 'notify_reservation_status_change',
      'insert_s3_presign_job', 'insert_thumbnail_job', 'create_payment_intent_sync',
      'cleanup_old_validation_results', 'get_validation_results',
      'get_preview_results', 'preview_template_parts', 'validate_template_parts',
      'get_upload_url', 'request_upload_url',
      'format_public_display_name',
      'get_entity_source_code',
      'create_schema_decision',
      'can_manage_role', 'get_manageable_roles',
      'assign_user_role', 'revoke_user_role',
      'delete_role', 'set_role_can_manage', 'get_role_can_manage',
      'create_provisioned_user', 'retry_user_provisioning', 'bulk_provision_users',
      -- v0.36.0: Exclude role helper
      'get_role_id'
  )
  AND (
      NOT EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
      OR EXISTS (
          SELECT 1 FROM metadata.entity_actions ea
          WHERE ea.rpc_function = p.proname::NAME
            AND metadata.has_entity_action_permission(ea.id)
      )
      OR EXISTS (
          SELECT 1 FROM metadata.rpc_entity_effects ree
          WHERE ree.function_name = p.proname
            AND metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
      )
  );

COMMENT ON VIEW public.schema_functions IS
    'Catalog-first view of public functions with source code. Updated in v0.36.0 to exclude get_role_id.';

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;


-- Recreate parsed_source_code view (depends on schema_functions)
CREATE VIEW public.parsed_source_code
WITH (security_invoker = true) AS
SELECT psc.schema_name, psc.object_name, psc.object_type, psc.language,
       psc.ast_json, psc.parse_error, psc.parsed_at
FROM metadata.parsed_source_code psc
WHERE
  (psc.object_type = 'function' AND (
    EXISTS (
      SELECT 1 FROM public.schema_functions sf
      WHERE sf.function_name = psc.object_name
    )
    OR
    EXISTS (
      SELECT 1 FROM public.schema_triggers st
      WHERE st.function_name = psc.object_name
    )
  ))
  OR
  (psc.object_type = 'view'
    AND metadata.has_permission(psc.object_name::TEXT, 'read'::TEXT));

COMMENT ON VIEW public.parsed_source_code IS
    'Permission-filtered view of pre-parsed AST JSON. Delegates visibility to
     schema_functions/schema_triggers for functions and has_permission for views.
     Added in v0.29.0.';

GRANT SELECT ON public.parsed_source_code TO authenticated, web_anon;


-- ============================================================================
-- 8. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
