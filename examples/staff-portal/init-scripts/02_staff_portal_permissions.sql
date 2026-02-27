-- =====================================================
-- Staff Portal - Permissions
-- =====================================================
-- This script creates RBAC permissions for the staff portal tables
-- Permission Model:
--   - user: Basic authenticated staff (view own records, clock in/out, submit requests)
--   - editor: Site lead - manages staff at their assigned site (mapped from Keycloak editor role)
--   - manager: Full management of staff, documents, time, and incidents
--   - admin: Full CRUD access to all tables

-- =====================================================
-- CUSTOM ROLES
-- =====================================================

-- Create editor role (if it doesn't already exist)
-- Note: The Keycloak 'editor' role serves as the site lead role in this portal.
-- We use 'editor' (not 'editor') because get_user_roles() returns raw JWT role names
-- and has_permission() matches against metadata.roles.display_name. The 'editor' role
-- is pre-seeded by Civic OS core migrations, so we just update its description here.
UPDATE metadata.roles SET description = 'Site Lead - manages staff at their assigned site'
WHERE display_name = 'editor';

-- Create manager role (if it doesn't already exist)
INSERT INTO metadata.roles (display_name, description)
SELECT 'manager', 'Program manager with full staff management capabilities'
WHERE NOT EXISTS (SELECT 1 FROM metadata.roles WHERE display_name = 'manager');

-- =====================================================
-- CREATE PERMISSIONS
-- =====================================================

-- Register CRUD permissions for all staff portal tables
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('staff_roles', 'read'),
  ('staff_roles', 'create'),
  ('staff_roles', 'update'),
  ('staff_roles', 'delete'),
  ('sites', 'read'),
  ('sites', 'create'),
  ('sites', 'update'),
  ('sites', 'delete'),
  ('staff_members', 'read'),
  ('staff_members', 'create'),
  ('staff_members', 'update'),
  ('staff_members', 'delete'),
  ('document_requirements', 'read'),
  ('document_requirements', 'create'),
  ('document_requirements', 'update'),
  ('document_requirements', 'delete'),
  ('staff_documents', 'read'),
  ('staff_documents', 'create'),
  ('staff_documents', 'update'),
  ('staff_documents', 'delete'),
  ('time_entries', 'read'),
  ('time_entries', 'create'),
  ('time_entries', 'update'),
  ('time_entries', 'delete'),
  ('time_off_requests', 'read'),
  ('time_off_requests', 'create'),
  ('time_off_requests', 'update'),
  ('time_off_requests', 'delete'),
  ('incident_reports', 'read'),
  ('incident_reports', 'create'),
  ('incident_reports', 'update'),
  ('incident_reports', 'delete'),
  ('reimbursements', 'read'),
  ('reimbursements', 'create'),
  ('reimbursements', 'update'),
  ('reimbursements', 'delete'),
  ('offboarding_feedback', 'read'),
  ('offboarding_feedback', 'create'),
  ('offboarding_feedback', 'update'),
  ('offboarding_feedback', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- NOTE: clock_in/clock_out permissions are handled through entity_action_roles
-- in 04_staff_portal_actions.sql (entity actions have their own permission system)

-- =====================================================
-- MAP PERMISSIONS TO ROLES
-- =====================================================

-- -----------------------------------------------
-- staff_roles: user=read, editor=read, manager=read/create/update, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_roles'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create/update for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_roles'
  AND p.permission IN ('create', 'update')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- Delete for admin only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_roles'
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- sites: user=read, editor=read, manager=read/create/update, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'sites'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create/update for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'sites'
  AND p.permission IN ('create', 'update')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- Delete for admin only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'sites'
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- staff_members: user=read, editor=read, manager=all, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_members'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create/update/delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_members'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- document_requirements: user=read, editor=read, manager=all, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'document_requirements'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create/update/delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'document_requirements'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- staff_documents: user=read/update, editor=read/update, manager=all, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_documents'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Update for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_documents'
  AND p.permission = 'update'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create/delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_documents'
  AND p.permission IN ('create', 'delete')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- time_entries: user=read/create, editor=read/create/update, manager=all, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_entries'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_entries'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Update for editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_entries'
  AND p.permission = 'update'
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_entries'
  AND p.permission = 'delete'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- time_off_requests: user=read/create, editor=read/update, manager=all, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_off_requests'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create for user, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_off_requests'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Update for editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_off_requests'
  AND p.permission = 'update'
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'time_off_requests'
  AND p.permission = 'delete'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- incident_reports: user=read/create, editor=read/create, manager=all, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'incident_reports'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'incident_reports'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Update/delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'incident_reports'
  AND p.permission IN ('update', 'delete')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- reimbursements: user=read/create, editor=read, manager=read/update, admin=all
-- -----------------------------------------------

-- Read access for user, editor, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reimbursements'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create for user, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reimbursements'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'admin')
ON CONFLICT DO NOTHING;

-- Update for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reimbursements'
  AND p.permission = 'update'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- Delete for admin only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reimbursements'
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- offboarding_feedback: user=read/create, manager=all, admin=all
-- (editor has no access to offboarding feedback)
-- -----------------------------------------------

-- Read access for user, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'offboarding_feedback'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Create for user, manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'offboarding_feedback'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Update/delete for manager, admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'offboarding_feedback'
  AND p.permission IN ('update', 'delete')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- NOTE: clock_in/clock_out action permissions are configured in
-- 04_staff_portal_actions.sql via entity_action_roles

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
