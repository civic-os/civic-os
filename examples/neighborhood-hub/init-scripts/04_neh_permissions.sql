-- Neighborhood Engagement Hub - Permissions

-- Grant to web_anon (read-only public access)
GRANT SELECT ON tool_categories TO web_anon;
GRANT SELECT ON tool_types TO web_anon;
GRANT SELECT ON tool_instances TO web_anon;
GRANT SELECT ON borrowers TO web_anon;
GRANT SELECT ON parcels TO web_anon;
GRANT SELECT ON tool_reservations TO web_anon;
GRANT SELECT ON projects TO web_anon;
GRANT SELECT ON project_parcels TO web_anon;

-- Grant to authenticated (full CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_instances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON borrowers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON parcels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_parcels TO authenticated;

-- Sequences
GRANT USAGE, SELECT ON SEQUENCE tool_categories_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_types_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_instances_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE borrowers_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE parcels_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_reservations_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE projects_id_seq TO authenticated;

-- RBAC permissions (metadata.permissions + metadata.permission_roles)
DO $$
DECLARE
  tables TEXT[] := ARRAY['tool_categories', 'tool_types', 'tool_instances', 'borrowers', 'tool_reservations', 'projects', 'parcels', 'project_parcels'];
  perms TEXT[] := ARRAY['read', 'create', 'update', 'delete'];
  t TEXT;
  p TEXT;
  v_admin_id INT;
  v_editor_id INT;
  v_user_id INT;
  v_anon_id INT;
  v_perm_id INT;
BEGIN
  SELECT id INTO v_admin_id FROM metadata.roles WHERE role_key = 'admin';
  SELECT id INTO v_editor_id FROM metadata.roles WHERE role_key = 'editor';
  SELECT id INTO v_user_id FROM metadata.roles WHERE role_key = 'user';
  SELECT id INTO v_anon_id FROM metadata.roles WHERE role_key = 'anonymous';

  FOREACH t IN ARRAY tables LOOP
    FOREACH p IN ARRAY perms LOOP
      INSERT INTO metadata.permissions (table_name, permission)
      VALUES (t, p::metadata.permission)
      ON CONFLICT (table_name, permission) DO NOTHING
      RETURNING id INTO v_perm_id;
      IF v_perm_id IS NULL THEN
        SELECT id INTO v_perm_id FROM metadata.permissions WHERE table_name = t AND permission = p::metadata.permission;
      END IF;

      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_admin_id) ON CONFLICT DO NOTHING;
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_editor_id) ON CONFLICT DO NOTHING;
      IF p IN ('read', 'create', 'update') THEN
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_user_id) ON CONFLICT DO NOTHING;
      END IF;
      IF p = 'read' THEN
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_anon_id) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END $$;
