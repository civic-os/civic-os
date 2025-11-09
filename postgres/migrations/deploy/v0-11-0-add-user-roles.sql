-- Deploy civic_os:v0-11-0-add-user-roles to pg
-- Add user_roles table to persist JWT role assignments
-- Enables role-based user queries (e.g., "find all admins")
-- Version: 0.11.0

BEGIN;

-- ===========================================================================
-- User Roles Table
-- ===========================================================================

CREATE TABLE metadata.user_roles (
  user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_role_id ON metadata.user_roles(role_id);

COMMENT ON TABLE metadata.user_roles IS 'Maps users to roles synced from JWT claims on login. Enables queries like "find all users with role X".';
COMMENT ON COLUMN metadata.user_roles.synced_at IS 'When this role assignment was last synced from JWT (via refresh_current_user)';

-- ===========================================================================
-- Row Level Security
-- ===========================================================================

ALTER TABLE metadata.user_roles ENABLE ROW LEVEL SECURITY;

-- Users can only see their own role mappings
CREATE POLICY "Users see own roles" ON metadata.user_roles
  FOR SELECT
  USING (user_id = public.current_user_id());

-- ===========================================================================
-- Update User Refresh Function to Sync Roles
-- ===========================================================================

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

  -- ===========================================================================
  -- NEW: Sync roles from JWT to metadata.user_roles
  -- ===========================================================================

  -- Get roles from JWT (TEXT[] array)
  v_user_roles := public.get_user_roles();

  -- Delete old role mappings for this user
  DELETE FROM metadata.user_roles WHERE user_id = v_user_id;

  -- Insert new role mappings
  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
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

COMMENT ON FUNCTION public.refresh_current_user() IS 'Sync current user data from JWT claims to database. Includes name, email, phone, and roles.';

-- ===========================================================================
-- has_role() Utility Function
-- ===========================================================================

-- Check if a specific user has a role
CREATE OR REPLACE FUNCTION public.has_role(p_user_id UUID, p_role_name TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM metadata.user_roles ur
    JOIN metadata.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND r.display_name = p_role_name
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION public.has_role(UUID, TEXT) IS 'Check if a specific user has a role (based on last JWT sync). Example: has_role(current_user_id(), ''admin'')';

-- ===========================================================================
-- Permissions
-- ===========================================================================

GRANT SELECT ON metadata.user_roles TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, TEXT) TO web_anon, authenticated;

COMMIT;
