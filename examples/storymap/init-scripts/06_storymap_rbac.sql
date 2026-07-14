-- =====================================================
-- Youth Soccer StoryMap Example - RBAC Permissions
-- =====================================================
-- Registers metadata.permissions and role mappings so Create/Edit/Delete
-- work in the frontend. Database GRANTs and RLS (02_storymap_permissions.sql)
-- control API access; these rows control what the UI allows per role.
--
-- Permission Model:
--   - anonymous/user: Read-only access to all storymap tables
--   - editor/manager/admin: Full create/update/delete access

-- =====================================================
-- SEED ROLES
-- =====================================================
-- Baseline migrations seed anonymous/user/editor/admin; manager is not
-- seeded by default, so create it here for the testmanager Keycloak user.
INSERT INTO metadata.roles (display_name, description)
SELECT 'manager', 'Can manage all storymap records'
WHERE NOT EXISTS (SELECT 1 FROM metadata.roles WHERE role_key = 'manager');

-- =====================================================
-- CREATE PERMISSIONS
-- =====================================================
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('participants', 'read'),
  ('participants', 'create'),
  ('participants', 'update'),
  ('participants', 'delete'),
  ('teams', 'read'),
  ('teams', 'create'),
  ('teams', 'update'),
  ('teams', 'delete'),
  ('team_rosters', 'read'),
  ('team_rosters', 'create'),
  ('team_rosters', 'update'),
  ('team_rosters', 'delete'),
  ('sponsors', 'read'),
  ('sponsors', 'create'),
  ('sponsors', 'update'),
  ('sponsors', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- =====================================================
-- MAP PERMISSIONS TO ROLES
-- =====================================================

-- Read access for everyone (matches the public-read RLS policies)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('participants', 'teams', 'team_rosters', 'sponsors')
  AND p.permission = 'read'
  AND r.role_key IN ('anonymous', 'user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create/update/delete for editor, manager, and admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('participants', 'teams', 'team_rosters', 'sponsors')
  AND p.permission IN ('create', 'update', 'delete')
  AND r.role_key IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
