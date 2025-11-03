-- =====================================================
-- Community Center Reservations - Permissions
-- =====================================================
-- This script creates RBAC permissions for the community center tables
-- Permission Model:
--   - anonymous: Read-only access to resources and reservations
--   - user: Can view resources/reservations, create own reservation requests
--   - editor: Can approve/deny reservation requests (update)
--   - admin: Full CRUD access to all tables

-- =====================================================
-- CREATE PERMISSIONS
-- =====================================================

-- Create permissions for all community center tables
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('request_statuses', 'read'),
  ('request_statuses', 'create'),
  ('request_statuses', 'update'),
  ('request_statuses', 'delete'),
  ('resources', 'read'),
  ('resources', 'create'),
  ('resources', 'update'),
  ('resources', 'delete'),
  ('reservation_requests', 'read'),
  ('reservation_requests', 'create'),
  ('reservation_requests', 'update'),
  ('reservation_requests', 'delete'),
  ('reservations', 'read'),
  ('reservations', 'create'),
  ('reservations', 'update'),
  ('reservations', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- =====================================================
-- MAP PERMISSIONS TO ROLES
-- =====================================================

-- Grant read permission to all roles for request_statuses, resources, and reservations
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('request_statuses', 'resources', 'reservations')
  AND p.permission = 'read'
  AND r.display_name IN ('anonymous', 'user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant CUD on request_statuses to admins only (lookup table)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'request_statuses'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Grant read permission to reservation_requests for authenticated users (they see own via RLS)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create permission to authenticated users for reservation_requests
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant update permission to editors and admins for reservation_requests (approve/deny)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'update'
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create/update/delete to editors and admins for resources
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'resources'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.display_name IN ('editor', 'admin')
ON CONFLICT DO NOTHING;

-- Grant delete to admins only for reservation_requests and reservations
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('reservation_requests', 'reservations')
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
