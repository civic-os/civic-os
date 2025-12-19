-- Revert v0-20-3-fix-permission-type-cast
-- Restore the v0.20.2 version of the functions (with the incorrect type cast)
--
-- Note: This reverts to the BROKEN version. This is intentional for migration
-- rollback purposes - if you need working functions, deploy v0.20.3 or later.

BEGIN;

-- Restore v0.20.2 set_role_permission (with incorrect type cast)
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
  v_valid_permissions TEXT[] := ARRAY['create', 'read', 'update', 'delete'];
BEGIN
  -- Enforce admin-only access
  IF NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin access required'
    );
  END IF;

  -- Validate permission type
  IF NOT (p_permission = ANY(v_valid_permissions)) THEN
    RETURN json_build_object(
      'success', false,
      'error', format('Invalid permission type: %s. Must be one of: %s',
                      p_permission, array_to_string(v_valid_permissions, ', '))
    );
  END IF;

  -- Get the permission ID, or create it if it doesn't exist
  SELECT id INTO v_permission_id
  FROM metadata.permissions
  WHERE table_name = p_table_name
    AND permission::TEXT = p_permission;

  -- Auto-create permission entry if missing
  IF v_permission_id IS NULL THEN
    INSERT INTO metadata.permissions (table_name, permission)
    VALUES (p_table_name, p_permission::metadata.permission_type)
    RETURNING id INTO v_permission_id;
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

-- Restore v0.20.2 ensure_table_permissions (with incorrect type cast)
CREATE OR REPLACE FUNCTION public.ensure_table_permissions(p_table_name TEXT)
RETURNS JSON AS $$
DECLARE
  v_permission TEXT;
  v_created INT := 0;
BEGIN
  -- Enforce admin-only access
  IF NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin access required'
    );
  END IF;

  -- Insert all 4 CRUD permissions if they don't exist
  FOR v_permission IN SELECT unnest(ARRAY['create', 'read', 'update', 'delete'])
  LOOP
    INSERT INTO metadata.permissions (table_name, permission)
    VALUES (p_table_name, v_permission::metadata.permission_type)
    ON CONFLICT (table_name, permission) DO NOTHING;

    IF FOUND THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'created', v_created,
    'message', format('Ensured permissions exist for table %s', p_table_name)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
