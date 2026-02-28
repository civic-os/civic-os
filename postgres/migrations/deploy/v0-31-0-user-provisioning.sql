-- Deploy civic_os:v0-31-0-user-provisioning to pg
-- requires: v0-30-0-schema-decisions

BEGIN;

-- ============================================================================
-- USER PROVISIONING & ROLE DELEGATION SYSTEM
-- ============================================================================
-- Version: v0.31.0
-- Purpose: First-class user management in Civic OS. Allows managers to
--          import/create users via the admin UI, which provisions them in
--          Keycloak and immediately populates civic_os_users for notifications
--          and FK references. Also adds role delegation so managers can assign
--          roles they're authorized to manage.
--
-- Architecture:
--   1. Manager creates users via UI → calls create_provisioned_user() RPC
--   2. RPC validates roles, inserts into metadata table, enqueues River job
--   3. Go worker provisions user in Keycloak Admin API
--   4. Worker inserts into civic_os_users/civic_os_users_private/user_roles
--   5. User immediately appears in FK dropdowns and can receive notifications
--   6. Later: user logs in via Google/password → Keycloak links by email
--
-- Key Concepts:
--   - Database-first: records exist immediately for FK/notification use
--   - Async Keycloak sync via River jobs (retry, idempotency)
--   - Role delegation: role_can_manage controls who can assign which roles
--   - Permission-based access: reuses civic_os_users_private permissions
-- ============================================================================


-- ============================================================================
-- 0a. HELPER: Keycloak System Role Filter
-- ============================================================================
-- Keycloak auto-assigns system roles (offline_access, uma_authorization,
-- default-roles-<realm>) to every user. These are Keycloak internals and
-- should not appear in the Civic OS roles system.

CREATE OR REPLACE FUNCTION metadata.is_keycloak_system_role(p_role_name TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN p_role_name IN ('offline_access', 'uma_authorization')
        OR p_role_name LIKE 'default-roles-%';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION metadata.is_keycloak_system_role IS
    'Returns true for Keycloak-internal roles that should be excluded from
     Civic OS role management. Added in v0.31.0.';


-- ============================================================================
-- 0b. UPDATE refresh_current_user() to Skip System Roles
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
  -- Get claims from JWT
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();
  v_phone := public.current_user_phone();

  -- Validate we have required data
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Upsert into civic_os_users (public profile)
  -- Store shortened name (e.g., "John D.") for privacy
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert into civic_os_users_private (private profile)
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        updated_at = NOW();

  -- Sync roles from JWT to metadata.user_roles
  v_user_roles := public.get_user_roles();

  -- Delete old role mappings for this user
  DELETE FROM metadata.user_roles WHERE user_id = v_user_id;

  -- Insert new role mappings (skip Keycloak system roles)
  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    -- Skip Keycloak system roles (offline_access, uma_authorization, default-roles-*)
    IF metadata.is_keycloak_system_role(v_role_name) THEN
      CONTINUE;
    END IF;

    -- Lookup role_id by display_name
    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE display_name = v_role_name;

    -- If role doesn't exist, auto-create it (keeps JWT and DB in sync)
    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, description)
      VALUES (v_role_name, 'Auto-created from JWT claim')
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    -- Insert user-role mapping
    INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
    VALUES (v_user_id, v_role_id, NOW())
    ON CONFLICT (user_id, role_id) DO UPDATE
      SET synced_at = NOW();
  END LOOP;

  -- Return the public user record
  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS
    'Sync current user data from JWT claims to database. Includes name, email,
     phone, and roles. Skips Keycloak system roles. Updated in v0.31.0.';


-- ============================================================================
-- 0c. UPDATE get_roles() to Exclude System Roles
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_roles()
RETURNS TABLE (
  id SMALLINT,
  display_name TEXT,
  description TEXT
) AS $$
BEGIN
  -- Enforce admin-only access
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT r.id, r.display_name, r.description
  FROM metadata.roles r
  WHERE NOT metadata.is_keycloak_system_role(r.display_name)
  ORDER BY r.id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ============================================================================
-- 0d. CLEAN UP Existing System Roles
-- ============================================================================
-- Remove any Keycloak system roles that were auto-created by previous logins.

DELETE FROM metadata.user_roles
WHERE role_id IN (
    SELECT id FROM metadata.roles
    WHERE metadata.is_keycloak_system_role(display_name)
);

DELETE FROM metadata.permission_roles
WHERE role_id IN (
    SELECT id FROM metadata.roles
    WHERE metadata.is_keycloak_system_role(display_name)
);

DELETE FROM metadata.roles
WHERE metadata.is_keycloak_system_role(display_name);


-- ============================================================================
-- 1. USER PROVISIONING TABLE
-- ============================================================================

CREATE TABLE metadata.user_provisioning (
    id BIGSERIAL PRIMARY KEY,

    -- User identity
    email email_address NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone phone_number,

    -- Configuration
    initial_roles TEXT[] NOT NULL DEFAULT '{user}',
    send_welcome_email BOOLEAN NOT NULL DEFAULT true,

    -- Lifecycle
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    keycloak_user_id UUID,
    error_message TEXT,
    requested_by UUID REFERENCES metadata.civic_os_users(id),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    -- Constraints
    CONSTRAINT valid_provisioning_status CHECK (
        status IN ('pending', 'processing', 'completed', 'failed')
    ),
    CONSTRAINT first_name_not_empty CHECK (trim(first_name) != ''),
    CONSTRAINT last_name_not_empty CHECK (trim(last_name) != '')
);

COMMENT ON TABLE metadata.user_provisioning IS
    'User provisioning requests. Each row triggers a River job to create the user
     in Keycloak and populate civic_os_users tables. Added in v0.31.0.';

COMMENT ON COLUMN metadata.user_provisioning.initial_roles IS
    'Array of Keycloak realm role names to assign. Validated against role_can_manage
     at insert time. Defaults to {user}.';

COMMENT ON COLUMN metadata.user_provisioning.send_welcome_email IS
    'If true, Keycloak sends a "set your password" email after provisioning.
     User can also log in via Google OpenID (account linking by email).';

COMMENT ON COLUMN metadata.user_provisioning.status IS
    'Lifecycle: pending → processing → completed/failed. River worker manages transitions.';


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Partial unique index: prevents duplicate pending/processing requests
-- but allows re-provisioning after failure or completion
CREATE UNIQUE INDEX idx_user_provisioning_email_active
    ON metadata.user_provisioning (email)
    WHERE status NOT IN ('completed', 'failed');

-- Lookup by status (for admin views and worker queries)
CREATE INDEX idx_user_provisioning_status ON metadata.user_provisioning(status);

-- Lookup by requested_by (who imported these users)
CREATE INDEX idx_user_provisioning_requested_by ON metadata.user_provisioning(requested_by);

-- Chronological listing
CREATE INDEX idx_user_provisioning_created ON metadata.user_provisioning(created_at DESC);


-- ============================================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE metadata.user_provisioning ENABLE ROW LEVEL SECURITY;

-- Read: reuse civic_os_users_private read permission
CREATE POLICY user_provisioning_select ON metadata.user_provisioning
    FOR SELECT TO authenticated
    USING (metadata.has_permission('civic_os_users_private', 'read'));

-- Insert: reuse civic_os_users_private create permission
CREATE POLICY user_provisioning_insert ON metadata.user_provisioning
    FOR INSERT TO authenticated
    WITH CHECK (metadata.has_permission('civic_os_users_private', 'create'));

-- Update: reuse civic_os_users_private update permission (for retry, status changes)
CREATE POLICY user_provisioning_update ON metadata.user_provisioning
    FOR UPDATE TO authenticated
    USING (metadata.has_permission('civic_os_users_private', 'update'));


-- ============================================================================
-- 4. GRANTS
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON metadata.user_provisioning TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.user_provisioning_id_seq TO authenticated;


-- ============================================================================
-- 5. ROLE DELEGATION TABLE
-- ============================================================================

CREATE TABLE metadata.role_can_manage (
    manager_role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    managed_role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    PRIMARY KEY (manager_role_id, managed_role_id)
);

COMMENT ON TABLE metadata.role_can_manage IS
    'Controls which roles can assign/revoke which other roles. Admin can always
     manage all roles (short-circuit in can_manage_role()). Added in v0.31.0.';


-- ============================================================================
-- 6. ROLE DELEGATION RLS & GRANTS
-- ============================================================================

ALTER TABLE metadata.role_can_manage ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read (needed for can_manage_role() checks)
CREATE POLICY role_can_manage_select ON metadata.role_can_manage
    FOR SELECT TO authenticated
    USING (true);

-- Only admins can modify the delegation matrix
CREATE POLICY role_can_manage_insert ON metadata.role_can_manage
    FOR INSERT TO authenticated
    WITH CHECK (is_admin());

CREATE POLICY role_can_manage_delete ON metadata.role_can_manage
    FOR DELETE TO authenticated
    USING (is_admin());

GRANT SELECT, INSERT, DELETE ON metadata.role_can_manage TO authenticated;


-- ============================================================================
-- 7. SEED DEFAULT ROLE DELEGATION
-- ============================================================================
-- Admin can manage all app roles, manager can manage editor/user/staff
-- Excludes 'anonymous' (framework role for table permissions, not a user-assignable role)

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT admin_r.id, managed_r.id
FROM metadata.roles admin_r
CROSS JOIN metadata.roles managed_r
WHERE admin_r.display_name = 'admin'
  AND managed_r.display_name NOT IN ('admin', 'anonymous')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT manager_r.id, managed_r.id
FROM metadata.roles manager_r
CROSS JOIN metadata.roles managed_r
WHERE manager_r.display_name = 'manager'
  AND managed_r.display_name IN ('editor', 'user')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 8. RPC: CAN_MANAGE_ROLE
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
    -- Admins can always manage all roles
    IF is_admin() THEN
        RETURN true;
    END IF;

    v_user_roles := get_user_roles();

    -- Check if any of the user's roles can manage the target role
    RETURN EXISTS (
        SELECT 1
        FROM metadata.role_can_manage rcm
        JOIN metadata.roles mr ON mr.id = rcm.manager_role_id
        JOIN metadata.roles tr ON tr.id = rcm.managed_role_id
        WHERE mr.display_name = ANY(v_user_roles)
          AND tr.display_name = p_role_name
    );
END;
$$;

COMMENT ON FUNCTION public.can_manage_role IS
    'Check if the current user can assign/revoke the given role name.
     Admins always return true. Others checked against role_can_manage table.
     Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.can_manage_role TO authenticated;


-- ============================================================================
-- 9. RPC: GET_MANAGEABLE_ROLES
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_manageable_roles()
RETURNS TABLE (role_id SMALLINT, display_name TEXT, description TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_user_roles TEXT[];
BEGIN
    -- Admins can manage all roles (excluding Keycloak system roles and anonymous)
    -- anonymous is a Civic OS framework role used for table permissions only,
    -- not for user assignment or delegation.
    IF is_admin() THEN
        RETURN QUERY
        SELECT r.id, r.display_name::TEXT, r.description::TEXT
        FROM metadata.roles r
        WHERE NOT metadata.is_keycloak_system_role(r.display_name)
          AND r.display_name != 'anonymous'
        ORDER BY r.display_name;
        RETURN;
    END IF;

    v_user_roles := get_user_roles();

    RETURN QUERY
    SELECT DISTINCT r.id, r.display_name::TEXT, r.description::TEXT
    FROM metadata.role_can_manage rcm
    JOIN metadata.roles mr ON mr.id = rcm.manager_role_id
    JOIN metadata.roles r ON r.id = rcm.managed_role_id
    WHERE mr.display_name = ANY(v_user_roles)
      AND r.display_name != 'anonymous'
    ORDER BY r.display_name;
END;
$$;

COMMENT ON FUNCTION public.get_manageable_roles IS
    'Returns all roles the current user can assign based on role_can_manage.
     Admins see all roles. Used by UI to populate role dropdowns.
     Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.get_manageable_roles TO authenticated;


-- ============================================================================
-- 10. RPC: ASSIGN_USER_ROLE
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
    -- Check delegation permission
    IF NOT can_manage_role(p_role_name) THEN
        RETURN json_build_object(
            'success', false,
            'error', format('Your role cannot assign the "%s" role', p_role_name)
        );
    END IF;

    -- Look up role
    SELECT id INTO v_role_id FROM metadata.roles WHERE display_name = p_role_name;
    IF v_role_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', format('Role "%s" not found', p_role_name));
    END IF;

    -- Insert into user_roles (idempotent)
    INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
    VALUES (p_user_id, v_role_id, NOW())
    ON CONFLICT (user_id, role_id) DO UPDATE SET synced_at = NOW();

    -- Enqueue Keycloak sync job
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

COMMENT ON FUNCTION public.assign_user_role IS
    'Assign a role to a user. Validates delegation permission via can_manage_role().
     Inserts into user_roles immediately, enqueues Keycloak sync job.
     Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.assign_user_role TO authenticated;


-- ============================================================================
-- 11. RPC: REVOKE_USER_ROLE
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
    -- Check delegation permission
    IF NOT can_manage_role(p_role_name) THEN
        RETURN json_build_object(
            'success', false,
            'error', format('Your role cannot revoke the "%s" role', p_role_name)
        );
    END IF;

    -- Look up role
    SELECT id INTO v_role_id FROM metadata.roles WHERE display_name = p_role_name;
    IF v_role_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', format('Role "%s" not found', p_role_name));
    END IF;

    -- Delete from user_roles
    DELETE FROM metadata.user_roles
    WHERE user_id = p_user_id AND role_id = v_role_id;

    -- Enqueue Keycloak sync job
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

COMMENT ON FUNCTION public.revoke_user_role IS
    'Revoke a role from a user. Validates delegation permission via can_manage_role().
     Deletes from user_roles immediately, enqueues Keycloak sync job.
     Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.revoke_user_role TO authenticated;


-- ============================================================================
-- 12. RPC: DELETE_ROLE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_role(p_role_id SMALLINT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_name TEXT;
BEGIN
    -- Admin-only
    IF NOT is_admin() THEN
        RETURN json_build_object('success', false, 'error', 'Admin access required');
    END IF;

    -- Get role name
    SELECT display_name INTO v_role_name FROM metadata.roles WHERE id = p_role_id;
    IF v_role_name IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Role not found');
    END IF;

    -- Prevent deleting built-in roles
    IF v_role_name IN ('anonymous', 'user', 'admin') THEN
        RETURN json_build_object('success', false, 'error', format('Cannot delete built-in role "%s"', v_role_name));
    END IF;

    -- Delete from metadata.roles (CASCADE cleans up permission_roles, role_can_manage, user_roles)
    DELETE FROM metadata.roles WHERE id = p_role_id;

    -- Enqueue Keycloak sync job to remove the role
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'sync_keycloak_role',
        jsonb_build_object(
            'role_name', v_role_name,
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

COMMENT ON FUNCTION public.delete_role IS
    'Delete a custom role. Admin-only. Cannot delete built-in roles (anonymous, user, admin).
     CASCADE deletes from permission_roles, role_can_manage, user_roles.
     Enqueues Keycloak sync to remove the role. Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.delete_role TO authenticated;


-- ============================================================================
-- 13. RPC: SET_ROLE_CAN_MANAGE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_role_can_manage(
    p_manager_role_id SMALLINT,
    p_managed_role_id SMALLINT,
    p_enabled BOOLEAN
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Admin-only
    IF NOT is_admin() THEN
        RETURN json_build_object('success', false, 'error', 'Admin access required');
    END IF;

    IF p_enabled THEN
        INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
        VALUES (p_manager_role_id, p_managed_role_id)
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM metadata.role_can_manage
        WHERE manager_role_id = p_manager_role_id
          AND managed_role_id = p_managed_role_id;
    END IF;

    RETURN json_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.set_role_can_manage IS
    'Toggle whether a manager role can assign/revoke a managed role.
     Admin-only. Used by Role Delegation tab on Permissions page.
     Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.set_role_can_manage TO authenticated;


-- ============================================================================
-- 14. RPC: GET_ROLE_CAN_MANAGE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_role_can_manage(p_manager_role_id SMALLINT)
RETURNS TABLE (managed_role_id SMALLINT, managed_role_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Admin-only
    IF NOT is_admin() THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT rcm.managed_role_id, r.display_name::TEXT
    FROM metadata.role_can_manage rcm
    JOIN metadata.roles r ON r.id = rcm.managed_role_id
    WHERE rcm.manager_role_id = p_manager_role_id
    ORDER BY r.display_name;
END;
$$;

COMMENT ON FUNCTION public.get_role_can_manage IS
    'Returns roles that a given manager role can manage. Admin-only.
     Used by Role Delegation tab. Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.get_role_can_manage TO authenticated;


-- ============================================================================
-- 15. ENHANCE CREATE_ROLE TO ENQUEUE KEYCLOAK SYNC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_role(
  p_display_name TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_new_role_id SMALLINT;
  v_exists BOOLEAN;
BEGIN
  -- Enforce admin-only access
  IF NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin access required'
    );
  END IF;

  -- Validate display_name is not empty
  IF p_display_name IS NULL OR TRIM(p_display_name) = '' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Role name cannot be empty'
    );
  END IF;

  -- Check if role with this display_name already exists
  SELECT EXISTS (
    SELECT 1
    FROM metadata.roles
    WHERE display_name = TRIM(p_display_name)
  ) INTO v_exists;

  IF v_exists THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Role with this name already exists'
    );
  END IF;

  -- Insert the new role
  INSERT INTO metadata.roles (display_name, description)
  VALUES (TRIM(p_display_name), TRIM(p_description))
  RETURNING id INTO v_new_role_id;

  -- v0.31.0: Enqueue Keycloak sync job to create the role there too
  INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
  VALUES (
      'sync_keycloak_role',
      jsonb_build_object(
          'role_name', TRIM(p_display_name),
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
    'role_id', v_new_role_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.create_role IS
    'Create a new role. Admin-only. Also enqueues Keycloak sync job to create
     the role in Keycloak. Enhanced in v0.31.0 with Keycloak sync.';


-- ============================================================================
-- 16. PUBLIC VIEW: MANAGED_USERS (Combined Admin View)
-- ============================================================================
-- Read-only view for the User Management page. Mutations go through RPCs.
-- This view is excluded from schema_entities (section 26) so it does not
-- appear in the sidebar or Schema Editor ERD.

CREATE VIEW public.managed_users
WITH (security_invoker = true) AS

-- Active users (fully provisioned, have Keycloak accounts)
SELECT
    u.id,
    u.display_name,
    p.display_name AS full_name,
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
           AND r.display_name != 'anonymous'),
        (SELECT up2.initial_roles
         FROM metadata.user_provisioning up2
         WHERE up2.keycloak_user_id = u.id
         ORDER BY up2.completed_at DESC NULLS LAST
         LIMIT 1)
    ) AS roles,
    u.created_at,
    NULL::BIGINT AS provision_id
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id

UNION ALL

-- Pending/failed provisioning requests (not yet in civic_os_users)
SELECT
    up.keycloak_user_id AS id,
    (up.first_name || ' ' || substring(up.last_name from 1 for 1) || '.')::TEXT AS display_name,
    (up.first_name || ' ' || up.last_name)::TEXT AS full_name,
    up.email::TEXT,
    up.phone::TEXT,
    up.status::TEXT,
    up.error_message,
    up.initial_roles AS roles,
    up.created_at,
    up.id AS provision_id
FROM metadata.user_provisioning up
WHERE up.status NOT IN ('completed');

COMMENT ON VIEW public.managed_users IS
    'Combined view of all users for admin User Management page. Active users
     from civic_os_users UNION pending/failed provisioning requests.
     Includes provision_id for retry functionality on failed records.
     Mutations use RPCs (create_provisioned_user, retry_user_provisioning).
     Excluded from schema_entities to avoid sidebar/ERD pollution.
     Added in v0.31.0.';

GRANT SELECT ON public.managed_users TO authenticated;


-- ============================================================================
-- 17. RPC: CREATE_PROVISIONED_USER (replaces INSERT trigger)
-- ============================================================================

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
    -- Permission check
    IF NOT metadata.has_permission('civic_os_users_private', 'create') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    -- Default initial_roles if NULL or empty
    v_initial_roles := COALESCE(p_initial_roles, ARRAY['user']);
    IF array_length(v_initial_roles, 1) IS NULL THEN
        v_initial_roles := ARRAY['user'];
    END IF;

    -- Validate each role
    FOREACH v_role_name IN ARRAY v_initial_roles LOOP
        IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE display_name = v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Role "%s" does not exist', v_role_name));
        END IF;

        IF NOT can_manage_role(v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Your role cannot assign the "%s" role', v_role_name));
        END IF;
    END LOOP;

    -- Insert into metadata table
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

    -- Enqueue River job for Keycloak provisioning
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

COMMENT ON FUNCTION public.create_provisioned_user IS
    'Create a new user provisioning request. Validates roles and delegation,
     inserts into metadata.user_provisioning, and enqueues River job.
     Returns JSON {success, provision_id} or {success, error}. Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.create_provisioned_user(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) TO authenticated;


-- ============================================================================
-- 18. RPC: RETRY_USER_PROVISIONING (replaces UPDATE trigger)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retry_user_provisioning(
    p_provision_id BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_status TEXT;
BEGIN
    -- Permission check
    IF NOT metadata.has_permission('civic_os_users_private', 'update') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    -- Validate record exists and is in failed state
    SELECT status INTO v_status
    FROM metadata.user_provisioning
    WHERE id = p_provision_id;

    IF v_status IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Provisioning record not found');
    END IF;

    IF v_status != 'failed' THEN
        RETURN json_build_object('success', false, 'error', 'Only failed requests can be retried');
    END IF;

    -- Reset to pending and clear error
    UPDATE metadata.user_provisioning
    SET status = 'pending',
        error_message = NULL
    WHERE id = p_provision_id;

    -- Re-enqueue River job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'provision_keycloak_user',
        jsonb_build_object('provision_id', p_provision_id),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.retry_user_provisioning IS
    'Retry a failed user provisioning request. Resets status to pending,
     clears error, and re-enqueues River job. Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.retry_user_provisioning(BIGINT) TO authenticated;


-- ============================================================================
-- 18b. RPC: BULK_PROVISION_USERS (for import feature)
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
    v_send_welcome BOOLEAN;
BEGIN
    -- Permission check
    IF NOT metadata.has_permission('civic_os_users_private', 'create') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    -- Iterate through users array
    FOR v_user IN SELECT * FROM json_array_elements(p_users)
    LOOP
        v_index := v_index + 1;
        v_email := v_user->>'email';
        v_first_name := v_user->>'first_name';
        v_last_name := v_user->>'last_name';
        v_phone := v_user->>'phone';
        v_send_welcome := COALESCE((v_user->>'send_welcome_email')::BOOLEAN, true);

        -- Parse initial_roles from JSON array
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
            -- Validate roles
            FOREACH v_role_name IN ARRAY v_initial_roles LOOP
                IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE display_name = v_role_name) THEN
                    RAISE EXCEPTION 'Role "%" does not exist', v_role_name;
                END IF;
                IF NOT can_manage_role(v_role_name) THEN
                    RAISE EXCEPTION 'Your role cannot assign the "%" role', v_role_name;
                END IF;
            END LOOP;

            -- Insert provisioning record
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

            -- Enqueue River job
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

COMMENT ON FUNCTION public.bulk_provision_users IS
    'Bulk create user provisioning requests from a JSON array. Each user is
     validated independently; partial failures are reported per-row.
     Returns {success, created_count, error_count, errors}. Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.bulk_provision_users(JSON) TO authenticated;


-- ============================================================================
-- 19a. USER MANAGEMENT RLS POLICY ON user_roles
-- ============================================================================
-- The existing "Users see own roles" policy only lets users see their own
-- role assignments. Users with civic_os_users_private:read permission need
-- to see ALL users' roles for the managed_users view and user management.

CREATE POLICY "User managers see all roles" ON metadata.user_roles
  FOR SELECT
  USING (metadata.has_permission('civic_os_users_private', 'read'));


-- (managed_users view moved to section 16 above)


-- (Entity registration removed — user_provisioning no longer needs a public view
-- or metadata.entities entry since it uses RPCs exclusively)


-- ============================================================================
-- 21. PERMISSION ENTRIES
-- ============================================================================
-- RLS policies reference civic_os_users_private create/update permissions,
-- but only 'read' exists in the baseline. Add create/update and grant to admin/manager.

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('civic_os_users_private', 'create'),
  ('civic_os_users_private', 'update')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant to admin and manager
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission IN ('create', 'update')
  AND r.display_name IN ('admin', 'manager')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 22. UPDATE SCHEMA_FUNCTIONS VIEW (EXCLUDE NEW RPCs)
-- ============================================================================
-- parsed_source_code depends on schema_functions, so drop both and recreate.

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
      -- v0.29.0: Exclude source code RPC itself
      'get_entity_source_code',
      -- v0.30.0: Exclude schema decisions RPC
      'create_schema_decision',
      -- v0.31.0: Exclude user provisioning and role management RPCs
      'can_manage_role', 'get_manageable_roles',
      'assign_user_role', 'revoke_user_role',
      'delete_role', 'set_role_can_manage', 'get_role_can_manage',
      'create_provisioned_user', 'retry_user_provisioning', 'bulk_provision_users'
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
    'Catalog-first view of public functions with source code. Updated in v0.31.0 to exclude user provisioning RPCs.';

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;


-- ============================================================================
-- 23. RECREATE PARSED_SOURCE_CODE VIEW (depends on schema_functions)
-- ============================================================================

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


-- (ADR removed — user provisioning is a core framework feature, not an instance-level decision)


-- ============================================================================
-- 25. UPDATE schema_entities VIEW (add managed_users to exclusion list)
-- ============================================================================
-- System views that have dedicated admin pages (managed_users, time_slot_series,
-- etc.) are excluded from schema_entities so they don't appear in the sidebar
-- or Schema Editor ERD. No show_in_menu column needed.

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN ('time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users')
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with Virtual Entities support.
     Tables are auto-discovered; VIEWs require explicit metadata.entities entry.
     System views (schema_*, time_slot_*, civic_os_users, managed_users) are excluded.
     Updated in v0.31.0.';


-- ============================================================================
-- 26. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
