-- Revert civic_os:v0-26-0-impersonation from pg

BEGIN;

-- Drop the new functions in reverse order
DROP FUNCTION IF EXISTS public.get_admin_audit_log(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.log_impersonation(TEXT[], TEXT);
DROP FUNCTION IF EXISTS public.is_real_admin();
DROP FUNCTION IF EXISTS metadata.is_real_admin();

-- Drop the audit table
DROP TABLE IF EXISTS metadata.admin_audit_log;

-- Restore original get_user_roles() without impersonation support
CREATE OR REPLACE FUNCTION metadata.get_user_roles()
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

COMMIT;
