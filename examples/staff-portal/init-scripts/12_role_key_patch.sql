-- =============================================================================
-- FFSC: role_key patch
-- Requires: Civic OS v0.36.0 (role_key + notification role helpers)
--
-- Updates get_users_with_role() to look up by role_key instead of display_name.
-- This is necessary before renaming display_name values (e.g., 'editor' -> 'Site Coordinator').
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. get_users_with_role()
--    Originally: 05_staff_portal_notifications.sql
--    Change: WHERE r.display_name -> WHERE r.role_key
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_users_with_role(p_role_name TEXT)
RETURNS TABLE (
  user_id UUID,
  user_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT
    u.id,
    up.email::TEXT
  FROM metadata.civic_os_users u
  INNER JOIN metadata.civic_os_users_private up ON up.id = u.id
  INNER JOIN metadata.user_roles ur ON ur.user_id = u.id
  INNER JOIN metadata.roles r ON r.id = ur.role_id
  WHERE r.role_key = p_role_name
    AND up.email IS NOT NULL;
END;
$$;

COMMIT;
