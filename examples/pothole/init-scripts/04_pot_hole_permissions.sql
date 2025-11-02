-- =====================================================
-- Pot Hole Observation System - Permissions
-- =====================================================
-- This script creates RBAC permissions for the example application tables
-- Customize this for your own application tables

-- Create permissions for all pot hole tables
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('Bid', 'read'),
  ('Bid', 'create'),
  ('Bid', 'update'),
  ('Bid', 'delete'),
  ('Issue', 'read'),
  ('Issue', 'create'),
  ('Issue', 'update'),
  ('Issue', 'delete'),
  ('IssueStatus', 'read'),
  ('IssueStatus', 'create'),
  ('IssueStatus', 'update'),
  ('IssueStatus', 'delete'),
  ('WorkDetail', 'read'),
  ('WorkDetail', 'create'),
  ('WorkDetail', 'update'),
  ('WorkDetail', 'delete'),
  ('WorkPackage', 'read'),
  ('WorkPackage', 'create'),
  ('WorkPackage', 'update'),
  ('WorkPackage', 'delete'),
  ('WorkPackageStatus', 'read'),
  ('WorkPackageStatus', 'create'),
  ('WorkPackageStatus', 'update'),
  ('WorkPackageStatus', 'delete'),
  ('Tag', 'read'),
  ('Tag', 'create'),
  ('Tag', 'update'),
  ('Tag', 'delete'),
  ('issue_tags', 'read'),
  ('issue_tags', 'create'),
  ('issue_tags', 'update'),
  ('issue_tags', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant read permission to all roles for all tables
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('Bid', 'Issue', 'IssueStatus', 'WorkDetail', 'WorkPackage', 'WorkPackageStatus', 'Tag', 'issue_tags')
  AND p.permission = 'read'
  AND r.display_name IN ('anonymous', 'user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create/update to authenticated users (user, editor, admin)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('Bid', 'Issue', 'IssueStatus', 'WorkDetail', 'WorkPackage', 'WorkPackageStatus', 'Tag', 'issue_tags')
  AND p.permission IN ('create', 'update')
  AND r.display_name IN ('user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant delete to editors and admins only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('Bid', 'Issue', 'IssueStatus', 'WorkDetail', 'WorkPackage', 'WorkPackageStatus', 'Tag', 'issue_tags')
  AND p.permission = 'delete'
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
