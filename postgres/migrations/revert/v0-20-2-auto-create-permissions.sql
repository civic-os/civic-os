-- Revert v0-20-2-auto-create-permissions

BEGIN;

-- Drop the new helper function
DROP FUNCTION IF EXISTS public.ensure_table_permissions(TEXT);

-- Restore original set_role_permission (without auto-create)
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

COMMIT;
