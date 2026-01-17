-- Deploy civic_os:v0-26-0-impersonation to pg
-- requires: v0-25-1-add-status-key

BEGIN;

-- ============================================================================
-- ADMIN ROLE IMPERSONATION
-- ============================================================================
-- Allows admins to temporarily test the app as if they only have specific roles.
-- This enables debugging permission issues without impersonating real users.
--
-- How it works:
-- 1. Frontend sets X-Impersonate-Roles header with comma-separated role names
-- 2. get_user_roles() checks header (only for real admins)
-- 3. If header present, returns impersonated roles instead of real roles
-- 4. All permission checks use effective roles transparently
-- ============================================================================

-- 1. GENERIC ADMIN AUDIT TABLE
-- Track admin actions for security audit - extensible for future use cases
CREATE TABLE IF NOT EXISTS metadata.admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  user_email TEXT,
  event_type TEXT NOT NULL,  -- e.g., 'impersonation_start', 'impersonation_stop', 'permission_change'
  event_data JSONB NOT NULL DEFAULT '{}',  -- Flexible payload for any event type
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_admin_audit_log_user_id ON metadata.admin_audit_log(user_id);
CREATE INDEX idx_admin_audit_log_event_type ON metadata.admin_audit_log(event_type);
CREATE INDEX idx_admin_audit_log_created_at ON metadata.admin_audit_log(created_at DESC);

COMMENT ON TABLE metadata.admin_audit_log IS
  'Generic audit log for admin actions (impersonation, permission changes, etc.)';

-- 2. IS_REAL_ADMIN() FUNCTION
-- Check if current user is really an admin (ignores impersonation header)
-- Used by audit logging to ensure only real admins can log impersonation
CREATE OR REPLACE FUNCTION metadata.is_real_admin()
RETURNS BOOLEAN AS $$
DECLARE
  jwt_claims JSON;
  roles_array TEXT[];
BEGIN
  -- Get JWT claims
  BEGIN
    jwt_claims := current_setting('request.jwt.claims', true)::JSON;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF jwt_claims IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Get roles directly from JWT (same logic as get_user_roles but WITHOUT impersonation check)
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

COMMENT ON FUNCTION metadata.is_real_admin() IS
  'Check if current user is really an admin (ignores impersonation). Used for audit logging.';

-- Public shim for is_real_admin
CREATE OR REPLACE FUNCTION public.is_real_admin()
RETURNS BOOLEAN AS $$
  SELECT metadata.is_real_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION metadata.is_real_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_real_admin() TO authenticated;

-- 3. MODIFIED GET_USER_ROLES() FUNCTION
-- Now checks for X-Impersonate-Roles header if user is a real admin
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

  -- Get real roles from JWT
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

-- 4. LOG_IMPERSONATION RPC
-- Frontend calls this to log impersonation start/stop events
CREATE OR REPLACE FUNCTION public.log_impersonation(
  p_impersonated_roles TEXT[],
  p_action TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_event_type TEXT;
BEGIN
  -- Only real admins can log impersonation events
  IF NOT metadata.is_real_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Only admins can use role impersonation'
    );
  END IF;

  -- Validate action
  IF p_action NOT IN ('start', 'stop') THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Invalid action. Must be "start" or "stop"'
    );
  END IF;

  -- Get current user info
  v_user_id := metadata.current_user_id();
  v_user_email := metadata.current_user_email();
  v_event_type := 'impersonation_' || p_action;

  -- Insert audit record using generic table
  INSERT INTO metadata.admin_audit_log (user_id, user_email, event_type, event_data)
  VALUES (
    v_user_id,
    v_user_email,
    v_event_type,
    jsonb_build_object('impersonated_roles', p_impersonated_roles)
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Impersonation ' || p_action || ' logged'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.log_impersonation(TEXT[], TEXT) IS
  'Log impersonation start/stop events for security audit. Only callable by real admins.';

GRANT EXECUTE ON FUNCTION public.log_impersonation(TEXT[], TEXT) TO authenticated;

-- 5. GET_ADMIN_AUDIT_LOG RPC
-- Allow admins to view admin audit logs (generic, filterable by event_type)
CREATE OR REPLACE FUNCTION public.get_admin_audit_log(
  p_event_type TEXT DEFAULT NULL,  -- NULL = all events, or filter by type
  p_limit INT DEFAULT 100,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id BIGINT,
  user_id UUID,
  user_email TEXT,
  event_type TEXT,
  event_data JSONB,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  -- Only real admins can view audit logs
  IF NOT metadata.is_real_admin() THEN
    RAISE EXCEPTION 'Only admins can view audit logs';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.user_id,
    a.user_email,
    a.event_type,
    a.event_data,
    a.created_at
  FROM metadata.admin_audit_log a
  WHERE p_event_type IS NULL OR a.event_type = p_event_type
  ORDER BY a.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_admin_audit_log(TEXT, INT, INT) IS
  'View admin audit logs. Filter by event_type (e.g., "impersonation_start"). Only callable by real admins.';

GRANT EXECUTE ON FUNCTION public.get_admin_audit_log(TEXT, INT, INT) TO authenticated;

COMMIT;
