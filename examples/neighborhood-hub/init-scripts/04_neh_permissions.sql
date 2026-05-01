-- Neighborhood Engagement Hub - Permissions

-- Define NEH roles
INSERT INTO metadata.roles (role_key, display_name, description)
VALUES 
  ('neh_borrower', 'NEH Borrower', 'Default role for community members borrowing tools'),
  ('neh_staff', 'NEH Staff', 'Staff member who approves requests and manages inventory'),
  ('neh_admin', 'NEH Admin', 'Administrator with full access to all NEH features')
ON CONFLICT (role_key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description;

-- Grant to web_anon (read-only public access)
GRANT SELECT ON tool_categories TO web_anon;
GRANT SELECT ON tool_types TO web_anon;
GRANT SELECT ON tool_instances TO web_anon;
GRANT SELECT ON borrowers TO web_anon;
GRANT SELECT ON parcels TO web_anon;
GRANT SELECT ON tool_reservations TO web_anon;
GRANT SELECT ON projects TO web_anon;
GRANT SELECT ON project_parcels TO web_anon;
GRANT SELECT ON tool_reservation_tools TO web_anon;
GRANT SELECT ON tool_reservation_tool_items TO web_anon;
GRANT SELECT ON tool_reservation_work_site TO web_anon;
GRANT SELECT ON work_site_parcels TO web_anon;
-- Note: building_use_* table grants are in 07_neh_building_use_workflow.sql

-- Grant to authenticated (full CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_instances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON borrowers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON parcels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_parcels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_reservation_tools TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_reservation_tool_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_reservation_work_site TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_site_parcels TO authenticated;
-- Note: building_use_* table grants are in 07_neh_building_use_workflow.sql

-- Sequences
GRANT USAGE, SELECT ON SEQUENCE tool_categories_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_types_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_instances_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE parcels_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_reservations_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE projects_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_reservation_tools_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tool_reservation_work_site_id_seq TO authenticated;
-- Note: building_use_* sequence grants are in 07_neh_building_use_workflow.sql

-- RPC Functions
-- Note: Building-use related functions are granted in 07_neh_building_use_workflow.sql
-- Core NEH function grants are in 05_neh_options_rpcs.sql

-- RBAC permissions (metadata.permissions + metadata.permission_roles)
DO $$
DECLARE
  tables TEXT[] := ARRAY[
    'tool_categories', 'tool_types', 'tool_instances', 'borrowers',
    'tool_reservations', 'projects', 'parcels', 'project_parcels',
    'tool_reservation_tools', 'tool_reservation_tool_items',
    'tool_reservation_work_site', 'work_site_parcels',
    'building_use_requests',
    'building_use_event_details', 'building_use_room_preferences'
  ];
  perms TEXT[] := ARRAY['read', 'create', 'update', 'delete'];
  t TEXT;
  p TEXT;
  v_admin_id INT;
  v_editor_id INT;
  v_user_id INT;
  v_anon_id INT;
  v_borrower_id INT;
  v_staff_id INT;
  v_neh_admin_id INT;
  v_perm_id INT;
BEGIN
  SELECT id INTO v_admin_id FROM metadata.roles WHERE role_key = 'admin';
  SELECT id INTO v_editor_id FROM metadata.roles WHERE role_key = 'editor';
  SELECT id INTO v_user_id FROM metadata.roles WHERE role_key = 'user';
  SELECT id INTO v_anon_id FROM metadata.roles WHERE role_key = 'anonymous';
  SELECT id INTO v_borrower_id FROM metadata.roles WHERE role_key = 'neh_borrower';
  SELECT id INTO v_staff_id FROM metadata.roles WHERE role_key = 'neh_staff';
  SELECT id INTO v_neh_admin_id FROM metadata.roles WHERE role_key = 'neh_admin';

  FOREACH t IN ARRAY tables LOOP
    FOREACH p IN ARRAY perms LOOP
      INSERT INTO metadata.permissions (table_name, permission)
      VALUES (t, p::metadata.permission)
      ON CONFLICT (table_name, permission) DO NOTHING
      RETURNING id INTO v_perm_id;
      IF v_perm_id IS NULL THEN
        SELECT id INTO v_perm_id FROM metadata.permissions WHERE table_name = t AND permission = p::metadata.permission;
      END IF;

      -- Admin always gets all permissions
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_admin_id) ON CONFLICT (permission_id, role_id) DO NOTHING;
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_editor_id) ON CONFLICT DO NOTHING;
      
      -- NEH Admin gets all permissions
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_neh_admin_id) ON CONFLICT DO NOTHING;
      
      -- NEH Staff gets all permissions except delete on some tables
      IF t IN ('tool_categories', 'tool_types', 'tool_instances', 'parcels', 'projects') AND p = 'delete' THEN
        -- Skip delete permissions for staff on master data tables
      ELSE
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_staff_id) ON CONFLICT DO NOTHING;
      END IF;
      
      -- NEH Borrower gets limited permissions
      IF t = 'borrowers' AND p IN ('read', 'update') THEN
        -- Borrowers can read and update their own record
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT DO NOTHING;
      ELSIF t IN ('tool_reservations', 'building_use_requests') AND p IN ('read', 'create', 'update') THEN
        -- Borrowers can create/read/update their own reservations
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT DO NOTHING;
      ELSIF t IN ('tool_reservation_tools', 'tool_reservation_tool_items',
                  'tool_reservation_work_site', 'work_site_parcels') AND p IN ('read', 'create', 'update', 'delete') THEN
        -- Borrowers can manage guided form step data (full CRUD for M:M editing)
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT DO NOTHING;
      ELSIF t IN ('building_use_event_details', 'building_use_room_preferences') AND p IN ('read', 'create', 'update') THEN
        -- Borrowers can create/read/update their own building use details
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT DO NOTHING;
      ELSIF p = 'read' THEN
        -- Borrowers can read reference data
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT DO NOTHING;
      END IF;
      
      -- Anonymous users get read access to some tables
      IF p = 'read' AND t IN ('tool_categories', 'tool_types', 'parcels') THEN
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_anon_id) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END $$;