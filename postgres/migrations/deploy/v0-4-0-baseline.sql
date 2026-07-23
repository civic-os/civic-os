-- Deploy civic_os:v0-4-0-baseline to pg

BEGIN;

-- =====================================================
-- Civic OS v0.4.0 Baseline Schema
-- =====================================================
-- This migration consolidates all core Civic OS objects from the original
-- init scripts in the correct dependency order:
-- - PostGIS setup (separate schema)
-- - PostgREST roles and JWT functions
-- - RBAC functions (MUST come before tables with RLS policies)
-- - Metadata schema (entities, properties, users, permissions)
-- - Custom domains (hex_color, email_address, phone_number)
-- - Core views (schema_entities, schema_properties, civic_os_users)
-- - RBAC sample data (default roles and permissions)
-- - Schema cache versioning
-- - Dashboard schema
--
-- This baseline represents the complete Civic OS v0.4.0 schema.


-- =====================================================
-- PostGIS Setup (from 0_postgis_setup.sql)
-- =====================================================

-- =====================================================
-- PostGIS Setup (Separate Schema)
-- =====================================================
-- Install PostGIS into its own schema to keep public schema clean
-- PostGIS functions will still be accessible via search_path

-- Create postgis schema
CREATE SCHEMA IF NOT EXISTS postgis;

-- Install PostGIS extension into postgis schema
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA postgis;

-- Grant usage on postgis schema to all roles
GRANT USAGE ON SCHEMA postgis TO PUBLIC;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- PostgREST Roles and JWT Functions (from 1_postgrest_setup.sql)
-- =====================================================
-- PREREQUISITES: Before running migrations, create the authenticator role manually:
--
--   DO $$ BEGIN
--     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
--       CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'your-secure-password';
--     END IF;
--   END $$;
--
-- The migration will create web_anon and authenticated roles (checking for existence
-- first for multi-tenant compatibility where multiple schemas share these roles).
--
-- For development setup: see example/init-scripts/00_create_authenticator.sh
-- For production setup: see docs/deployment/PRODUCTION.md

-- =====================================================
-- PostgREST Role Setup
-- =====================================================

-- Create PostgREST roles (with multi-tenant support)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

-- Grant role switching to authenticator
GRANT web_anon TO authenticator;
GRANT authenticated TO authenticator;

-- Set search_path to include postgis schema
-- This allows PostGIS functions to be called without schema qualification
ALTER ROLE web_anon SET search_path TO public, postgis;
ALTER ROLE authenticated SET search_path TO public, postgis;

-- =====================================================
-- JWT Helper Functions (Keycloak Integration)
-- =====================================================

-- Get current user ID from JWT 'sub' claim
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::UUID;
$$ LANGUAGE SQL STABLE;

-- Get user email from JWT 'email' claim
CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS TEXT AS $$
  SELECT current_setting('request.jwt.claims', true)::json->>'email';
$$ LANGUAGE SQL STABLE;

-- Get user name from JWT 'name' or 'preferred_username' claim
CREATE OR REPLACE FUNCTION public.current_user_name()
RETURNS TEXT AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::json->>'name',
    current_setting('request.jwt.claims', true)::json->>'preferred_username'
  );
$$ LANGUAGE SQL STABLE;

-- Check JWT and set role
CREATE OR REPLACE FUNCTION public.check_jwt()
RETURNS VOID AS $$
BEGIN
  IF current_setting('request.jwt.claims', true)::json->>'sub' IS NOT NULL THEN
    EXECUTE 'SET LOCAL ROLE authenticated';
  ELSE
    EXECUTE 'SET LOCAL ROLE web_anon';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- RBAC Functions (from 2_rbac_functions.sql)
-- CRITICAL: Must be defined BEFORE tables with RLS policies
-- =====================================================

-- =====================================================
-- Role-Based Access Control (RBAC) Functions
-- =====================================================

-- Get current user's roles from JWT claims
-- Returns array of role names from JWT, or ['anonymous'] for unauthenticated users
CREATE OR REPLACE FUNCTION public.get_user_roles()
RETURNS TEXT[] AS $$
DECLARE
  jwt_claims JSON;
  jwt_sub TEXT;
  roles_array TEXT[];
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

  -- Try to extract roles from various Keycloak claim locations
  -- Priority order: realm_access.roles -> resource_access.myclient.roles -> roles
  BEGIN
    -- Try realm_access.roles first (most common for Keycloak)
    IF jwt_claims->'realm_access'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'realm_access'->'roles'))
      INTO roles_array;
      RETURN roles_array;
    END IF;

    -- Try resource_access.myclient.roles (client-specific roles)
    IF jwt_claims->'resource_access'->'myclient'->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'resource_access'->'myclient'->'roles'))
      INTO roles_array;
      RETURN roles_array;
    END IF;

    -- Try top-level roles claim
    IF jwt_claims->'roles' IS NOT NULL THEN
      SELECT ARRAY(SELECT json_array_elements_text(jwt_claims->'roles'))
      INTO roles_array;
      RETURN roles_array;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN ARRAY[]::TEXT[];
  END;

  -- If no roles found, return empty array
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Check if current user has a specific permission on a table
-- Returns true if any of the user's roles grant the requested permission
CREATE OR REPLACE FUNCTION public.has_permission(
  p_table_name TEXT,
  p_permission TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
  has_perm BOOLEAN;
BEGIN
  -- Get current user's roles (includes 'anonymous' for unauthenticated users)
  user_roles := public.get_user_roles();

  -- Check if any of the user's roles have the requested permission
  SELECT EXISTS (
    SELECT 1
    FROM metadata.roles r
    JOIN metadata.permission_roles pr ON pr.role_id = r.id
    JOIN metadata.permissions p ON p.id = pr.permission_id
    WHERE r.display_name = ANY(user_roles)
      AND p.table_name = p_table_name
      AND p.permission::TEXT = p_permission
  ) INTO has_perm;

  RETURN has_perm;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Check if current user has admin role
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
DECLARE
  user_roles TEXT[];
BEGIN
  user_roles := public.get_user_roles();
  RETURN 'admin' = ANY(user_roles);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Set or unset a permission for a role (Admin-only)
-- p_enabled: true to grant permission, false to revoke
CREATE OR REPLACE FUNCTION public.set_role_permission(
  p_role_id SMALLINT,
  p_table_name TEXT,
  p_permission TEXT,
  p_enabled BOOLEAN
)
RETURNS JSON AS $$
DECLARE
  v_permission_id INTEGER;
  v_exists BOOLEAN;
BEGIN
  -- Enforce admin-only access
  IF NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin access required'
    );
  END IF;

  -- Get the permission ID
  SELECT id INTO v_permission_id
  FROM metadata.permissions
  WHERE table_name = p_table_name
    AND permission::TEXT = p_permission;

  IF v_permission_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Permission not found'
    );
  END IF;

  -- Check if the role-permission mapping exists
  SELECT EXISTS (
    SELECT 1
    FROM metadata.permission_roles
    WHERE role_id = p_role_id AND permission_id = v_permission_id
  ) INTO v_exists;

  -- Add or remove the permission based on p_enabled
  IF p_enabled AND NOT v_exists THEN
    INSERT INTO metadata.permission_roles (role_id, permission_id)
    VALUES (p_role_id, v_permission_id);
  ELSIF NOT p_enabled AND v_exists THEN
    DELETE FROM metadata.permission_roles
    WHERE role_id = p_role_id AND permission_id = v_permission_id;
  END IF;

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all roles (Admin-only)
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
  ORDER BY r.id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Get role permissions (Admin-only)
CREATE OR REPLACE FUNCTION public.get_role_permissions(p_role_id SMALLINT DEFAULT NULL)
RETURNS TABLE (
  role_id SMALLINT,
  role_name TEXT,
  table_name TEXT,
  permission_type TEXT,
  has_permission BOOLEAN
) AS $$
BEGIN
  -- Enforce admin-only access
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT
    r.id AS role_id,
    r.display_name AS role_name,
    p.table_name::TEXT AS table_name,
    p.permission::TEXT AS permission_type,
    EXISTS (
      SELECT 1
      FROM metadata.permission_roles pr
      WHERE pr.role_id = r.id AND pr.permission_id = p.id
    ) AS has_permission
  FROM metadata.roles r
  CROSS JOIN metadata.permissions p
  WHERE p_role_id IS NULL OR r.id = p_role_id
  ORDER BY r.id, p.table_name, p.permission;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Create a new role (Admin-only)
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

  RETURN json_build_object(
    'success', true,
    'role_id', v_new_role_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_user_roles() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(TEXT, TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_roles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_role_permissions(SMALLINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_role_permission(SMALLINT, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_role(TEXT, TEXT) TO authenticated;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- Metadata Schema and Tables (from 3_civic_os_schema.sql)
-- =====================================================

-- =====================================================
-- Metadata Schema (Create First)
-- =====================================================

CREATE SCHEMA IF NOT EXISTS metadata;

-- =====================================================
-- Civic OS User Tables (Metadata Schema)
-- =====================================================

-- Public user information
CREATE TABLE metadata.civic_os_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE metadata.civic_os_users ENABLE ROW LEVEL SECURITY;

-- Everyone can read public user info
CREATE POLICY "Everyone can read users"
  ON metadata.civic_os_users
  FOR SELECT
  TO PUBLIC
  USING (true);

-- Private user information
CREATE TABLE metadata.civic_os_users_private (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone VARCHAR(255),
  email VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT civic_os_users_private_user_id FOREIGN KEY (id)
    REFERENCES metadata.civic_os_users (id)
    ON UPDATE NO ACTION ON DELETE CASCADE
);

ALTER TABLE metadata.civic_os_users_private ENABLE ROW LEVEL SECURITY;

-- Anonymous users see no private data (prevents permission errors on LEFT JOINs)
CREATE POLICY "Anonymous users see no private data"
  ON metadata.civic_os_users_private
  FOR SELECT
  TO web_anon
  USING (false);

-- Users can only read their own private info
CREATE POLICY "Users can read own private info"
  ON metadata.civic_os_users_private
  FOR SELECT
  TO authenticated
  USING (id = public.current_user_id());

-- Permitted roles (editor, admin, etc.) can see all private data
CREATE POLICY "Permitted roles see all private data"
  ON metadata.civic_os_users_private
  FOR SELECT
  TO authenticated
  USING (public.has_permission('civic_os_users_private', 'read'));

-- =====================================================
-- User Display Name Formatting
-- =====================================================

-- Function to format full name as "First L." for public display
-- Filters out titles (Mr., Dr., etc.) and suffixes (Jr., PhD, etc.)
-- Examples: "Mr. John Doe Jr." -> "John D.", "Dr. Sarah Johnson PhD" -> "Sarah J."
CREATE OR REPLACE FUNCTION public.format_public_display_name(full_name TEXT)
RETURNS TEXT AS $$
DECLARE
  name_parts TEXT[];
  filtered_parts TEXT[];
  name_part TEXT;
  part_normalized TEXT;
  first_name TEXT;
  last_initial TEXT;
  -- Common titles/prefixes to filter out (case-insensitive, with or without periods)
  titles TEXT[] := ARRAY['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'PROFESSOR', 'REV', 'REVEREND',
                         'SIR', 'MADAM', 'LORD', 'LADY', 'CAPT', 'CAPTAIN', 'LT', 'LIEUTENANT',
                         'COL', 'COLONEL', 'GEN', 'GENERAL', 'MAJ', 'MAJOR', 'SGT', 'SERGEANT'];
  -- Common suffixes to filter out (case-insensitive, with or without periods)
  suffixes TEXT[] := ARRAY['JR', 'JUNIOR', 'SR', 'SENIOR', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
                           'PHD', 'MD', 'DDS', 'ESQ', 'MBA', 'JD', 'DVM', 'RN', 'LPN',
                           '1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH', '9TH'];
BEGIN
  -- Handle NULL or empty string
  IF full_name IS NULL OR TRIM(full_name) = '' THEN
    RETURN 'User';
  END IF;

  -- Split name by spaces and filter out empty parts
  name_parts := ARRAY(SELECT TRIM(part) FROM UNNEST(string_to_array(full_name, ' ')) AS part WHERE TRIM(part) != '');

  -- Filter out titles and suffixes
  filtered_parts := ARRAY[]::TEXT[];
  FOREACH name_part IN ARRAY name_parts
  LOOP
    -- Normalize: uppercase and remove periods for comparison
    part_normalized := UPPER(REPLACE(name_part, '.', ''));

    -- Skip if it's a title or suffix
    IF NOT (part_normalized = ANY(titles) OR part_normalized = ANY(suffixes)) THEN
      filtered_parts := filtered_parts || name_part;
    END IF;
  END LOOP;

  -- Handle edge cases after filtering
  IF array_length(filtered_parts, 1) IS NULL OR array_length(filtered_parts, 1) = 0 THEN
    RETURN 'User';
  END IF;

  -- Handle single name (e.g., "Madonna")
  IF array_length(filtered_parts, 1) = 1 THEN
    RETURN INITCAP(filtered_parts[1]);
  END IF;

  -- Extract first name and capitalize
  first_name := INITCAP(filtered_parts[1]);

  -- Extract last name initial and capitalize
  last_initial := UPPER(SUBSTRING(filtered_parts[array_length(filtered_parts, 1)] FROM 1 FOR 1));

  -- Return formatted name: "First L."
  RETURN first_name || ' ' || last_initial || '.';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =====================================================
-- Unified User View (Public API Surface)
-- =====================================================

-- Combines civic_os_users and civic_os_users_private into a single view
-- Private fields (full_name, phone, email) are NULL unless user has access
-- Access rules: view own data OR have 'civic_os_users_private:read' permission
CREATE VIEW public.civic_os_users AS
SELECT
  u.id,
  u.display_name,                     -- Public shortened name ("John D.")
  u.created_at,
  u.updated_at,
  -- Private fields: visible only to self or authorized roles
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.display_name
    ELSE NULL
  END AS full_name,                   -- Private full name ("John Doe")
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.email
    ELSE NULL
  END AS email,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.phone
    ELSE NULL
  END AS phone
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

-- Security invoker ensures permission checks use caller's role
ALTER VIEW public.civic_os_users SET (security_invoker = true);

GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;

-- =====================================================
-- User Refresh Function
-- =====================================================

-- Function to refresh current user data from JWT claims
-- Automatically creates/updates user records from authentication token
-- Can be called via PostgREST: POST /rpc/refresh_current_user
CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_result metadata.civic_os_users;
BEGIN
  -- Get claims from JWT
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();

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
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        updated_at = NOW();

  -- Return the public user record
  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execution to authenticated users only
GRANT EXECUTE ON FUNCTION public.refresh_current_user() TO authenticated;

-- =====================================================
-- Custom Domain Types
-- =====================================================

-- Hex color domain for storing RGB colors in #RRGGBB format
CREATE DOMAIN hex_color AS VARCHAR(7)
  CHECK (VALUE ~ '^#[0-9A-Fa-f]{6}$')
  DEFAULT '#3B82F6';

COMMENT ON DOMAIN hex_color IS 'RGB hex color in #RRGGBB format (e.g., #3B82F6)';

-- Email address domain with RFC 5322 simplified validation
CREATE DOMAIN email_address AS VARCHAR(255)
  CHECK (VALUE ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
  DEFAULT NULL;

COMMENT ON DOMAIN email_address IS 'Email address with RFC 5322 validation (e.g., user@example.com)';

-- US phone number domain (10 digits, no formatting)
CREATE DOMAIN phone_number AS VARCHAR(10)
  CHECK (VALUE ~ '^\d{10}$')
  DEFAULT NULL;

COMMENT ON DOMAIN phone_number IS 'US phone number as 10 digits (e.g., 5551234567)';

-- =====================================================
-- Metadata Tables (Entity/Property Configuration)
-- =====================================================

-- Entity metadata table
CREATE TABLE metadata.entities (
  table_name NAME PRIMARY KEY,
  display_name TEXT,
  description TEXT,
  sort_order INT,
  search_fields TEXT[],
  show_map BOOLEAN DEFAULT FALSE,
  map_property_name TEXT
);

ALTER TABLE metadata.entities ENABLE ROW LEVEL SECURITY;

-- Everyone can read entity metadata
CREATE POLICY "Everyone can read entities"
  ON metadata.entities
  FOR SELECT
  TO PUBLIC
  USING (true);

-- Admins can insert entity metadata
CREATE POLICY "Admins can insert entities"
  ON metadata.entities
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- Admins can update entity metadata
CREATE POLICY "Admins can update entities"
  ON metadata.entities
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Admins can delete entity metadata
CREATE POLICY "Admins can delete entities"
  ON metadata.entities
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- Property metadata table
CREATE TABLE metadata.properties (
  table_name NAME,
  column_name NAME,
  display_name TEXT,
  description TEXT,
  sort_order INT,
  column_width INT,
  sortable BOOLEAN DEFAULT true,
  filterable BOOLEAN DEFAULT false,
  show_on_list BOOLEAN DEFAULT true,
  show_on_create BOOLEAN DEFAULT true,
  show_on_edit BOOLEAN DEFAULT true,
  show_on_detail BOOLEAN DEFAULT true,
  PRIMARY KEY (table_name, column_name)
);

-- Permissions enum
CREATE TYPE metadata.permission AS ENUM ('create', 'read', 'update', 'delete');

-- Permissions table
CREATE TABLE metadata.permissions (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL,
  permission metadata.permission NOT NULL,
  UNIQUE (table_name, permission)
);

-- Roles table
CREATE TABLE metadata.roles (
  id SMALLSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT
);

ALTER TABLE metadata.roles ENABLE ROW LEVEL SECURITY;

-- Everyone can read roles
CREATE POLICY "Everyone can read roles"
  ON metadata.roles
  FOR SELECT
  TO PUBLIC
  USING (true);

-- Admins can insert roles
CREATE POLICY "Admins can insert roles"
  ON metadata.roles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- Admins can update roles
CREATE POLICY "Admins can update roles"
  ON metadata.roles
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Admins can delete roles
CREATE POLICY "Admins can delete roles"
  ON metadata.roles
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- Permission-Role mapping
CREATE TABLE metadata.permission_roles (
  permission_id INTEGER,
  role_id SMALLINT,
  PRIMARY KEY (permission_id, role_id),
  FOREIGN KEY (permission_id) REFERENCES metadata.permissions (id),
  FOREIGN KEY (role_id) REFERENCES metadata.roles (id)
);

-- Validation rules table
CREATE TABLE metadata.validations (
  id SERIAL PRIMARY KEY,
  table_name NAME NOT NULL,
  column_name NAME NOT NULL,
  validation_type TEXT NOT NULL,  -- 'required', 'min', 'max', 'minLength', 'maxLength', 'pattern'
  validation_value TEXT,           -- e.g., '0', '100', '^\d{5}$'
  error_message TEXT NOT NULL,     -- User-friendly: "Age must be at least 18"
  sort_order INT DEFAULT 0,
  UNIQUE(table_name, column_name, validation_type)
);

-- CHECK constraint error message mapping
CREATE TABLE metadata.constraint_messages (
  id SERIAL PRIMARY KEY,
  constraint_name NAME NOT NULL UNIQUE,
  table_name NAME NOT NULL,
  column_name NAME,                -- NULL for multi-column constraints
  error_message TEXT NOT NULL
);

-- Grant permissions on metadata schema
GRANT USAGE ON SCHEMA metadata TO web_anon, authenticated;
GRANT SELECT ON metadata.entities TO web_anon, authenticated;
GRANT UPDATE, INSERT ON metadata.entities TO authenticated;
GRANT SELECT ON metadata.properties TO web_anon, authenticated;
GRANT SELECT ON metadata.permissions TO web_anon, authenticated;
GRANT SELECT ON metadata.roles TO web_anon, authenticated;
GRANT SELECT ON metadata.permission_roles TO web_anon, authenticated;
GRANT SELECT ON metadata.validations TO web_anon, authenticated;
GRANT SELECT ON metadata.constraint_messages TO web_anon, authenticated;

-- =====================================================
-- Schema Relations Function
-- =====================================================

CREATE FUNCTION public.schema_relations_func()
RETURNS TABLE (
  src_schema NAME,
  src_table NAME,
  src_column NAME,
  constraint_schema NAME,
  constraint_name NAME,
  join_schema NAME,
  join_table NAME,
  join_column NAME
)
LANGUAGE 'sql'
SECURITY DEFINER
AS $BODY$
SELECT
  k_c_u.table_schema AS src_schema,
  k_c_u.table_name AS src_table,
  k_c_u.column_name AS src_column,
  c_c_u.constraint_schema,
  c_c_u.constraint_name,
  c_c_u.table_schema AS join_schema,
  c_c_u.table_name AS join_table,
  c_c_u.column_name AS join_column
FROM
  information_schema.key_column_usage AS k_c_u
  JOIN information_schema.referential_constraints r_c
    ON k_c_u.constraint_name::name = r_c.constraint_name::name
  JOIN information_schema.constraint_column_usage c_c_u
    ON r_c.unique_constraint_name::name = c_c_u.constraint_name::name;
$BODY$;

GRANT EXECUTE ON FUNCTION public.schema_relations_func() TO web_anon, authenticated;

-- =====================================================
-- Schema Entities View
-- =====================================================

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
  COALESCE(entities.display_name, tables.table_name::text) AS display_name,
  COALESCE(entities.sort_order, 0) AS sort_order,
  entities.description,
  entities.search_fields,
  COALESCE(entities.show_map, FALSE) AS show_map,
  entities.map_property_name,
  tables.table_name,
  public.has_permission(tables.table_name::text, 'create') AS insert,
  public.has_permission(tables.table_name::text, 'read') AS "select",
  public.has_permission(tables.table_name::text, 'update') AS update,
  public.has_permission(tables.table_name::text, 'delete') AS delete
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text = 'BASE TABLE'::text
ORDER BY COALESCE(entities.sort_order, 0), tables.table_name;

ALTER VIEW public.schema_entities SET (security_invoker = true);

GRANT SELECT ON public.schema_entities TO web_anon, authenticated;

-- =====================================================
-- Schema Properties View
-- =====================================================

CREATE OR REPLACE VIEW public.schema_properties AS
SELECT
  columns.table_catalog,
  columns.table_schema,
  columns.table_name,
  columns.column_name,
  COALESCE(
    properties.display_name,
    initcap(replace(columns.column_name::text, '_'::text, ' '::text))
  ) AS display_name,
  properties.description,
  COALESCE(
    properties.sort_order,
    columns.ordinal_position::integer
  ) AS sort_order,
  properties.column_width,
  COALESCE(properties.sortable, true) AS sortable,
  COALESCE(properties.filterable, false) AS filterable,
  -- Smart defaults: system fields hidden by default, but can be overridden via metadata
  COALESCE(properties.show_on_list,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_list,
  COALESCE(properties.show_on_create,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_create,
  COALESCE(properties.show_on_edit,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search', 'created_at', 'updated_at')
      THEN false
      ELSE true
    END
  ) AS show_on_edit,
  COALESCE(properties.show_on_detail,
    CASE WHEN columns.column_name::text IN ('id', 'civic_os_text_search') THEN false
         WHEN columns.column_name::text IN ('created_at', 'updated_at') THEN true
         ELSE true
    END
  ) AS show_on_detail,
  columns.column_default,
  columns.is_nullable::text = 'YES'::text AS is_nullable,
  columns.data_type,
  columns.character_maximum_length,
  columns.udt_schema,
  COALESCE(pg_type_info.domain_name, columns.udt_name) AS udt_name,
  columns.is_self_referencing::text = 'YES'::text AS is_self_referencing,
  columns.is_identity::text = 'YES'::text AS is_identity,
  columns.is_generated::text = 'ALWAYS'::text AS is_generated,
  columns.is_updatable::text = 'YES'::text AS is_updatable,
  relations.join_schema,
  relations.join_table,
  relations.join_column,
  -- Extract geography/geometry subtype (e.g., 'Point' from 'geography(Point,4326)')
  CASE
    WHEN columns.udt_name::text IN ('geography', 'geometry') THEN
      SUBSTRING(
        pg_type_info.formatted_type
        FROM '\(([A-Za-z]+)'
      )
    ELSE NULL
  END AS geography_type,
  -- Validation rules as JSONB array
  COALESCE(
    validation_rules_agg.validation_rules,
    '[]'::jsonb
  ) AS validation_rules
FROM information_schema.columns
LEFT JOIN (
  SELECT
    schema_relations_func.src_schema,
    schema_relations_func.src_table,
    schema_relations_func.src_column,
    schema_relations_func.constraint_schema,
    schema_relations_func.constraint_name,
    schema_relations_func.join_schema,
    schema_relations_func.join_table,
    schema_relations_func.join_column
  FROM schema_relations_func() schema_relations_func(
    src_schema,
    src_table,
    src_column,
    constraint_schema,
    constraint_name,
    join_schema,
    join_table,
    join_column
  )
) relations
  ON columns.table_schema::name = relations.src_schema
  AND columns.table_name::name = relations.src_table
  AND columns.column_name::name = relations.src_column
LEFT JOIN metadata.properties
  ON properties.table_name = columns.table_name::name
  AND properties.column_name = columns.column_name::name
LEFT JOIN (
  SELECT
    c.relname AS table_name,
    a.attname AS column_name,
    format_type(a.atttypid, a.atttypmod) AS formatted_type,
    CASE WHEN t.typtype = 'd' THEN t.typname ELSE NULL END AS domain_name
  FROM pg_attribute a
  JOIN pg_class c ON a.attrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_type t ON a.atttypid = t.oid
  WHERE n.nspname = 'public'
    AND a.attnum > 0
    AND NOT a.attisdropped
) pg_type_info
  ON pg_type_info.table_name = columns.table_name::name
  AND pg_type_info.column_name = columns.column_name::name
LEFT JOIN (
  SELECT
    table_name,
    column_name,
    jsonb_agg(
      jsonb_build_object(
        'type', validation_type,
        'value', validation_value,
        'message', error_message
      )
      ORDER BY sort_order
    ) AS validation_rules
  FROM metadata.validations
  GROUP BY table_name, column_name
) validation_rules_agg
  ON validation_rules_agg.table_name = columns.table_name::name
  AND validation_rules_agg.column_name = columns.column_name::name
WHERE columns.table_schema::name = 'public'::name
  AND columns.table_name::name IN (
    SELECT schema_entities.table_name FROM schema_entities
  );

ALTER VIEW public.schema_properties SET (security_invoker = true);

GRANT SELECT ON public.schema_properties TO web_anon, authenticated;

-- =====================================================
-- Reusable Timestamp Trigger Functions
-- =====================================================

-- Automatically set created_at on INSERT
CREATE OR REPLACE FUNCTION public.set_created_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.created_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Automatically set updated_at on INSERT or UPDATE
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers to user tables
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON metadata.civic_os_users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.civic_os_users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON metadata.civic_os_users_private
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.civic_os_users_private
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =====================================================
-- Entity Management RPC Functions
-- =====================================================

-- Upsert entity metadata (admin only)
CREATE OR REPLACE FUNCTION public.upsert_entity_metadata(
  p_table_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_search_fields TEXT[] DEFAULT NULL,
  p_show_map BOOLEAN DEFAULT FALSE,
  p_map_property_name TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the entity metadata
  INSERT INTO metadata.entities (table_name, display_name, description, sort_order, search_fields, show_map, map_property_name)
  VALUES (p_table_name, p_display_name, p_description, p_sort_order, p_search_fields, p_show_map, p_map_property_name)
  ON CONFLICT (table_name) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        sort_order = EXCLUDED.sort_order,
        search_fields = COALESCE(EXCLUDED.search_fields, metadata.entities.search_fields),
        show_map = EXCLUDED.show_map,
        map_property_name = EXCLUDED.map_property_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.upsert_entity_metadata(NAME, TEXT, TEXT, INT, TEXT[], BOOLEAN, TEXT) TO authenticated;

-- Update entity sort order (admin only)
CREATE OR REPLACE FUNCTION public.update_entity_sort_order(
  p_table_name NAME,
  p_sort_order INT
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Update or insert with just sort_order
  INSERT INTO metadata.entities (table_name, sort_order)
  VALUES (p_table_name, p_sort_order)
  ON CONFLICT (table_name) DO UPDATE
    SET sort_order = EXCLUDED.sort_order;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.update_entity_sort_order(NAME, INT) TO authenticated;

-- Upsert property metadata (admin only)
CREATE OR REPLACE FUNCTION public.upsert_property_metadata(
  p_table_name NAME,
  p_column_name NAME,
  p_display_name TEXT,
  p_description TEXT,
  p_sort_order INT,
  p_column_width INT,
  p_sortable BOOLEAN,
  p_filterable BOOLEAN,
  p_show_on_list BOOLEAN,
  p_show_on_create BOOLEAN,
  p_show_on_edit BOOLEAN,
  p_show_on_detail BOOLEAN
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Upsert the property metadata
  INSERT INTO metadata.properties (
    table_name,
    column_name,
    display_name,
    description,
    sort_order,
    column_width,
    sortable,
    filterable,
    show_on_list,
    show_on_create,
    show_on_edit,
    show_on_detail
  )
  VALUES (
    p_table_name,
    p_column_name,
    p_display_name,
    p_description,
    p_sort_order,
    p_column_width,
    p_sortable,
    p_filterable,
    p_show_on_list,
    p_show_on_create,
    p_show_on_edit,
    p_show_on_detail
  )
  ON CONFLICT (table_name, column_name) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        sort_order = EXCLUDED.sort_order,
        column_width = EXCLUDED.column_width,
        sortable = EXCLUDED.sortable,
        filterable = EXCLUDED.filterable,
        show_on_list = EXCLUDED.show_on_list,
        show_on_create = EXCLUDED.show_on_create,
        show_on_edit = EXCLUDED.show_on_edit,
        show_on_detail = EXCLUDED.show_on_detail;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.upsert_property_metadata(NAME, NAME, TEXT, TEXT, INT, INT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated;

-- Update property sort order (admin only)
CREATE OR REPLACE FUNCTION public.update_property_sort_order(
  p_table_name NAME,
  p_column_name NAME,
  p_sort_order INT
)
RETURNS void AS $$
BEGIN
  -- Check if user is admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  -- Update or insert with smart defaults for system fields
  -- This prevents drag-and-drop reordering from overriding smart defaults with table defaults
  INSERT INTO metadata.properties (
    table_name,
    column_name,
    sort_order,
    filterable,
    show_on_list,
    show_on_create,
    show_on_edit,
    show_on_detail
  )
  VALUES (
    p_table_name,
    p_column_name,
    p_sort_order,
    -- Filterable defaults to false (opt-in)
    false,
    -- Smart defaults: same logic as schema_properties view
    CASE WHEN p_column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END,
    CASE WHEN p_column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END,
    CASE WHEN p_column_name IN ('id', 'civic_os_text_search', 'created_at', 'updated_at') THEN false ELSE true END,
    CASE WHEN p_column_name IN ('id', 'civic_os_text_search') THEN false
         WHEN p_column_name IN ('created_at', 'updated_at') THEN true
         ELSE true END
  )
  ON CONFLICT (table_name, column_name) DO UPDATE
    SET sort_order = EXCLUDED.sort_order;
    -- Note: Don't update show_on_* or filterable flags to preserve user customizations
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.update_property_sort_order(NAME, NAME, INT) TO authenticated;

-- =====================================================
-- Grant schema permissions
-- =====================================================

GRANT USAGE ON SCHEMA public TO web_anon, authenticated;

-- Grant access to metadata user tables
-- web_anon needs SELECT for the public view to work (security_invoker = true)
GRANT SELECT ON metadata.civic_os_users TO web_anon, authenticated;
GRANT SELECT ON metadata.civic_os_users_private TO web_anon, authenticated;
-- Only authenticated users can modify user data
GRANT INSERT, UPDATE ON metadata.civic_os_users TO authenticated;
GRANT INSERT, UPDATE ON metadata.civic_os_users_private TO authenticated;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- RBAC Sample Data (from 4_rbac_sample_data.sql)
-- =====================================================

-- =====================================================
-- Core RBAC Configuration
-- =====================================================
-- This script sets up the core RBAC system with default roles
-- and permissions for Civic OS system tables.
--
-- Application-specific permissions should be defined in your
-- application's init scripts (e.g., example/init-scripts/03_pot_hole_permissions.sql)

-- Insert default roles
INSERT INTO metadata.roles (display_name, description) VALUES
  ('anonymous', 'Unauthenticated users'),
  ('user', 'Standard authenticated user'),
  ('editor', 'Can create and edit content'),
  ('admin', 'Full administrative access')
ON CONFLICT DO NOTHING;

-- =====================================================
-- System Table Permissions
-- =====================================================

-- Create permissions for system tables
-- civic_os_users_private: read permission for viewing user contact info
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('civic_os_users_private', 'read')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant civic_os_users_private read to editor and admin roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission = 'read'
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;

-- =====================================================
-- Metadata Management Permissions (Admin Only)
-- =====================================================

-- Create permissions for metadata management tables
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('roles', 'read'),
  ('roles', 'create'),
  ('roles', 'update'),
  ('roles', 'delete'),
  ('permissions', 'read'),
  ('permissions', 'create'),
  ('permissions', 'update'),
  ('permissions', 'delete'),
  ('permission_roles', 'read'),
  ('permission_roles', 'create'),
  ('permission_roles', 'update'),
  ('permission_roles', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant all metadata permissions to admin role only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('roles', 'permissions', 'permission_roles')
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

-- =====================================================
-- Schema Cache Versioning (from 5_schema_cache_versioning.sql)
-- =====================================================

-- =====================================================
-- Schema Cache Versioning System
-- =====================================================
--
-- Purpose: Track metadata changes to enable selective cache invalidation
-- in the frontend. Supports two-cache architecture: entities and properties.
--
-- This script:
-- 1. Adds updated_at columns to all metadata tables
-- 2. Adds triggers to auto-update timestamps
-- 3. Creates schema_cache_versions view for version checking
--

-- =====================================================
-- Add updated_at Columns
-- =====================================================

-- metadata.entities
ALTER TABLE metadata.entities
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- metadata.properties
ALTER TABLE metadata.properties
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- metadata.validations
ALTER TABLE metadata.validations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- metadata.permissions
ALTER TABLE metadata.permissions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- metadata.roles
ALTER TABLE metadata.roles
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- metadata.permission_roles
ALTER TABLE metadata.permission_roles
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- metadata.constraint_messages (for completeness, though not used in cache versioning)
ALTER TABLE metadata.constraint_messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- =====================================================
-- Add Triggers for Auto-Updating updated_at
-- =====================================================

-- metadata.entities
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.entities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- metadata.properties
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- metadata.validations
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.validations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- metadata.permissions
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- metadata.roles
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.roles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- metadata.permission_roles
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.permission_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- metadata.constraint_messages
CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.constraint_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =====================================================
-- Schema Cache Versions View
-- =====================================================

CREATE OR REPLACE VIEW public.schema_cache_versions AS
SELECT
  'entities' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
  ) as version
UNION ALL
SELECT
  'properties' as cache_name,
  GREATEST(
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
    (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
  ) as version;

-- Set security_invoker to run with caller's permissions (respects RLS)
ALTER VIEW public.schema_cache_versions SET (security_invoker = true);

-- Grant access to all users (version info is not sensitive)
GRANT SELECT ON public.schema_cache_versions TO web_anon, authenticated;

-- =====================================================
-- Usage Example
-- =====================================================
--
-- Frontend queries this view on navigation:
--   SELECT * FROM schema_cache_versions;
--
-- Returns:
--   cache_name | version
--   -----------|------------------------
--   entities   | 2025-10-13 14:32:15+00
--   properties | 2025-10-13 15:10:42+00
--
-- If version changed since last check:
--   - entities changed → refresh SchemaService.tables
--   - properties changed → refresh SchemaService.properties
--

-- =====================================================
-- Dashboard Schema (from 6_dashboards.sql)
-- =====================================================

-- =====================================================
-- Custom Dashboards Schema
-- =====================================================
-- This file creates the database schema for customizable dashboards
-- with configurable widgets.
-- Phase 1: Core Infrastructure (Static dashboards with markdown)

-- =====================================================
-- Widget Types Registry (Extensible)
-- =====================================================
CREATE TABLE metadata.widget_types (
  widget_type VARCHAR(50) PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  config_schema JSONB,  -- JSON Schema for validation (future Phase 3)
  icon_name VARCHAR(50),  -- Material icon name for UI
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Populate with initial widget types (Phase 1: markdown only)
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name) VALUES
  ('markdown', 'Markdown Content', 'Display formatted text, images, and links', 'article'),
  ('filtered_list', 'Filtered Entity List', 'Show filtered records from any entity (Phase 2)', 'list'),
  ('stat_card', 'Statistic Card', 'Display a single metric or KPI (Phase 5)', 'analytics'),
  ('query_result', 'Query Result', 'Show results from a database view (Phase 5)', 'table_view');

GRANT SELECT ON metadata.widget_types TO web_anon, authenticated;

-- =====================================================
-- Dashboards
-- =====================================================
CREATE TABLE metadata.dashboards (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,  -- System default dashboard
  is_public BOOLEAN DEFAULT TRUE,    -- Visible to all users
  sort_order INT DEFAULT 0,
  created_by UUID REFERENCES metadata.civic_os_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one dashboard can be the system default
CREATE UNIQUE INDEX idx_dashboards_single_default
  ON metadata.dashboards (is_default)
  WHERE is_default = TRUE;

-- Triggers for timestamp management
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON metadata.dashboards
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.dashboards
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE metadata.dashboards ENABLE ROW LEVEL SECURITY;

-- Everyone can read public dashboards
CREATE POLICY "Everyone can read public dashboards"
  ON metadata.dashboards
  FOR SELECT
  TO PUBLIC
  USING (is_public = TRUE);

-- Users can read their own private dashboards
CREATE POLICY "Users can read own private dashboards"
  ON metadata.dashboards
  FOR SELECT
  TO authenticated
  USING (created_by = public.current_user_id());

-- Admins can create dashboards
CREATE POLICY "Admins can insert dashboards"
  ON metadata.dashboards
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- Admins can update dashboards
CREATE POLICY "Admins can update dashboards"
  ON metadata.dashboards
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Admins can delete dashboards
CREATE POLICY "Admins can delete dashboards"
  ON metadata.dashboards
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

GRANT SELECT ON metadata.dashboards TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.dashboards TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.dashboards_id_seq TO authenticated;

-- =====================================================
-- Dashboard Widgets (Hybrid: Columns + JSONB)
-- =====================================================
CREATE TABLE metadata.dashboard_widgets (
  id SERIAL PRIMARY KEY,
  dashboard_id INT NOT NULL REFERENCES metadata.dashboards(id) ON DELETE CASCADE,
  widget_type VARCHAR(50) NOT NULL REFERENCES metadata.widget_types(widget_type),

  -- Common fields (typed, indexed, queryable)
  title TEXT,
  entity_key NAME,  -- Denormalized for queries (NULL for non-entity widgets like markdown)
  refresh_interval_seconds INT DEFAULT NULL,  -- NULL = no auto-refresh (Phase 1), 60 = default (Phase 2)

  -- Layout
  sort_order INT DEFAULT 0,
  width INT DEFAULT 1,  -- Grid columns (1-2)
  height INT DEFAULT 1, -- Grid rows (1-3)

  -- Widget-specific configuration (flexible)
  config JSONB NOT NULL DEFAULT '{}',

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Validation
  CONSTRAINT valid_refresh_interval CHECK (refresh_interval_seconds IS NULL OR refresh_interval_seconds >= 0),
  CONSTRAINT valid_width CHECK (width BETWEEN 1 AND 2),
  CONSTRAINT valid_height CHECK (height BETWEEN 1 AND 3)
);

-- Index for "find widgets using entity X"
CREATE INDEX idx_widgets_entity_key ON metadata.dashboard_widgets(entity_key)
  WHERE entity_key IS NOT NULL;

-- Index for dashboard rendering (fetch all widgets)
CREATE INDEX idx_widgets_dashboard_id ON metadata.dashboard_widgets(dashboard_id, sort_order);

-- GIN index for JSONB queries (if needed later)
CREATE INDEX idx_widgets_config ON metadata.dashboard_widgets USING GIN (config);

-- Triggers
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON metadata.dashboard_widgets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.dashboard_widgets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE metadata.dashboard_widgets ENABLE ROW LEVEL SECURITY;

-- Everyone can read widgets of public dashboards
CREATE POLICY "Everyone can read public dashboard widgets"
  ON metadata.dashboard_widgets
  FOR SELECT
  TO PUBLIC
  USING (
    dashboard_id IN (
      SELECT id FROM metadata.dashboards WHERE is_public = TRUE
    )
  );

-- Users can read widgets of their private dashboards
CREATE POLICY "Users can read own dashboard widgets"
  ON metadata.dashboard_widgets
  FOR SELECT
  TO authenticated
  USING (
    dashboard_id IN (
      SELECT id FROM metadata.dashboards
      WHERE created_by = public.current_user_id()
    )
  );

-- Admins can manage widgets
CREATE POLICY "Admins can manage widgets"
  ON metadata.dashboard_widgets
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT ON metadata.dashboard_widgets TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.dashboard_widgets TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.dashboard_widgets_id_seq TO authenticated;

-- =====================================================
-- User Dashboard Preferences (Schema - Phase 3 functionality)
-- =====================================================
CREATE TABLE metadata.user_dashboard_preferences (
  user_id UUID PRIMARY KEY REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  default_dashboard_id INT REFERENCES metadata.dashboards(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON metadata.user_dashboard_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE metadata.user_dashboard_preferences ENABLE ROW LEVEL SECURITY;

-- Users can only manage their own preferences
CREATE POLICY "Users can manage own preferences"
  ON metadata.user_dashboard_preferences
  FOR ALL
  TO authenticated
  USING (user_id = public.current_user_id())
  WITH CHECK (user_id = public.current_user_id());

GRANT SELECT, INSERT, UPDATE ON metadata.user_dashboard_preferences TO authenticated;

-- =====================================================
-- Helper Functions
-- =====================================================

-- Get user's default dashboard (user preference > system default)
CREATE OR REPLACE FUNCTION public.get_user_default_dashboard()
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_dashboard_id INT;
BEGIN
  v_user_id := public.current_user_id();

  -- Try user preference first (Phase 3 feature)
  IF v_user_id IS NOT NULL THEN
    SELECT default_dashboard_id INTO v_dashboard_id
    FROM metadata.user_dashboard_preferences
    WHERE user_id = v_user_id;

    IF v_dashboard_id IS NOT NULL THEN
      RETURN v_dashboard_id;
    END IF;
  END IF;

  -- Fall back to system default
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE is_default = TRUE AND is_public = TRUE
  LIMIT 1;

  RETURN v_dashboard_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_user_default_dashboard() TO web_anon, authenticated;

-- =====================================================
-- RPC Functions for Dashboard Access
-- =====================================================

/**
 * Get all visible dashboards (public + user's private)
 * Returns dashboards ordered by sort_order
 */
CREATE OR REPLACE FUNCTION public.get_dashboards()
RETURNS TABLE (
  id INT,
  display_name VARCHAR(100),
  description TEXT,
  is_default BOOLEAN,
  is_public BOOLEAN,
  sort_order INT,
  created_by UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.display_name,
    d.description,
    d.is_default,
    d.is_public,
    d.sort_order,
    d.created_by,
    d.created_at,
    d.updated_at
  FROM metadata.dashboards d
  WHERE d.is_public = TRUE
     OR d.created_by = public.current_user_id()
  ORDER BY d.sort_order ASC, d.display_name ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.get_dashboards() TO web_anon, authenticated;

COMMENT ON FUNCTION public.get_dashboards() IS
  'Returns all dashboards visible to the current user (public dashboards + user''s private dashboards)';

/**
 * Get a specific dashboard with embedded widgets
 * Returns JSON with dashboard + widgets array
 */
CREATE OR REPLACE FUNCTION public.get_dashboard(p_dashboard_id INT)
RETURNS JSON AS $$
DECLARE
  v_dashboard JSON;
  v_widgets JSON;
  v_result JSON;
BEGIN
  -- Check if user can access this dashboard
  IF NOT EXISTS (
    SELECT 1 FROM metadata.dashboards
    WHERE id = p_dashboard_id
      AND (is_public = TRUE OR created_by = public.current_user_id())
  ) THEN
    RETURN NULL;
  END IF;

  -- Get dashboard data
  SELECT row_to_json(d.*) INTO v_dashboard
  FROM metadata.dashboards d
  WHERE d.id = p_dashboard_id;

  -- Get widgets data (sorted by sort_order)
  SELECT json_agg(w.* ORDER BY w.sort_order) INTO v_widgets
  FROM metadata.dashboard_widgets w
  WHERE w.dashboard_id = p_dashboard_id;

  -- Combine into single JSON object with widgets array
  v_result := jsonb_build_object(
    'id', (v_dashboard->>'id')::INT,
    'display_name', v_dashboard->>'display_name',
    'description', v_dashboard->>'description',
    'is_default', (v_dashboard->>'is_default')::BOOLEAN,
    'is_public', (v_dashboard->>'is_public')::BOOLEAN,
    'sort_order', (v_dashboard->>'sort_order')::INT,
    'created_by', (v_dashboard->>'created_by')::UUID,
    'created_at', v_dashboard->>'created_at',
    'updated_at', v_dashboard->>'updated_at',
    'widgets', COALESCE(v_widgets, '[]'::json)
  );

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.get_dashboard(INT) TO web_anon, authenticated;

COMMENT ON FUNCTION public.get_dashboard(INT) IS
  'Returns a dashboard with embedded widgets as JSON. Returns NULL if dashboard not found or not accessible.';

-- =====================================================
-- Default "Welcome" Dashboard
-- =====================================================

-- Insert default dashboard
INSERT INTO metadata.dashboards (display_name, description, is_default, is_public, sort_order)
VALUES (
  'Welcome',
  'Welcome to Civic OS - Your customizable dashboard',
  TRUE,  -- This is the default dashboard
  TRUE,  -- Public (visible to everyone)
  0      -- First in sort order
);

-- Insert welcome markdown widget
INSERT INTO metadata.dashboard_widgets (
  dashboard_id,
  widget_type,
  title,
  entity_key,
  refresh_interval_seconds,
  sort_order,
  width,
  height,
  config
)
VALUES (
  (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome'),
  'markdown',
  NULL,  -- No title (markdown content has its own heading)
  NULL,  -- Not entity-related
  NULL,  -- No auto-refresh (static content)
  0,     -- First widget
  2,     -- Full width
  1,     -- Standard height
  jsonb_build_object(
    'content', E'# Welcome to Civic OS\n\nPoint Civic OS at your PostgreSQL database, and it instantly creates a working web application — complete with forms, tables, search, and user permissions. No front-end code to write, no forms to build. Just focus on your data.\n\n## Getting Started\n\n- **Browse Entities**: Use the menu to explore your database tables\n- **Create Records**: Click the "Create" button on any entity list page\n- **Search**: Use full-text search on list pages\n- **Customize**: Admins can configure dashboards, entities, and permissions\n\n## Next Steps\n\n1. Explore the **Database Schema** (ERD) to understand your data model\n2. Check the **Entity Management** page to customize display names\n3. Review **Permissions** to configure role-based access control\n\n---\n\n*Sign in to get started, or create an account if you are new.*\n\n@[login-button](Sign In)',
    'enableHtml', false
  )
);

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
