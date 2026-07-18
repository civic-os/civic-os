-- =====================================================
-- Client Intake & Referral - Permissions
-- =====================================================
-- Permission Model:
--   - user: Self-service client — create own intake, view own data (RLS ownership)
--   - staff: ECS staff — full CRUD on all entities, notes, reports, translations
--   - admin: Full access + permissions UI, user management
--
-- RLS ownership model:
--   The 'user' role has minimal RBAC permissions. RLS policies on clients,
--   referrals, and surveys use user_id ownership chains so clients can
--   see/edit only their own data without needing broad read/update grants.

BEGIN;

-- =====================================================
-- CUSTOM ROLE: staff
-- =====================================================

INSERT INTO metadata.roles (role_key, display_name, description)
VALUES ('staff', 'Staff', 'Staff with full operational access')
ON CONFLICT (role_key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description;

-- =====================================================
-- CREATE PERMISSIONS
-- =====================================================

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('service_categories', 'read'),
  ('service_categories', 'create'),
  ('service_categories', 'update'),
  ('service_categories', 'delete'),
  ('clients', 'read'),
  ('clients', 'create'),
  ('clients', 'update'),
  ('clients', 'delete'),
  ('partners', 'read'),
  ('partners', 'create'),
  ('partners', 'update'),
  ('partners', 'delete'),
  ('referrals', 'read'),
  ('referrals', 'create'),
  ('referrals', 'update'),
  ('referrals', 'delete'),
  ('follow_up_surveys', 'read'),
  ('follow_up_surveys', 'create'),
  ('follow_up_surveys', 'update'),
  ('follow_up_surveys', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- =====================================================
-- MAP PERMISSIONS TO ROLES
-- =====================================================

-- -----------------------------------------------
-- service_categories: anonymous=read, user=read, staff=all, admin=all
-- -----------------------------------------------

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'service_categories'
  AND p.permission = 'read'
  AND r.role_key IN ('anonymous', 'user', 'staff', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'service_categories'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- clients: user=create (self-service intake only, RLS handles reads),
--          staff=all, admin=all
-- -----------------------------------------------

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'clients'
  AND p.permission = 'create'
  AND r.role_key IN ('user', 'staff', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'clients'
  AND p.permission IN ('read', 'update', 'delete')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- partners: anonymous=read, user=read, staff=all, admin=all
-- -----------------------------------------------

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'partners'
  AND p.permission = 'read'
  AND r.role_key IN ('anonymous', 'user', 'staff', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'partners'
  AND p.permission IN ('create', 'update', 'delete')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- referrals: staff=all, admin=all
-- (user has NO permission — RLS ownership chain via clients.user_id)
-- -----------------------------------------------

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'referrals'
  AND p.permission IN ('read', 'create', 'update', 'delete')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- follow_up_surveys: staff=all, admin=all
-- (user has NO permission — RLS ownership chain handles read + update)
-- -----------------------------------------------

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'follow_up_surveys'
  AND p.permission IN ('read', 'create', 'update', 'delete')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------
-- metadata.translations: staff=create+update, admin=all (via core migration)
-- Allows staff to manage translations without full admin access
-- -----------------------------------------------

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'metadata.translations'
  AND p.permission IN ('create', 'update')
  AND r.role_key = 'staff'
ON CONFLICT DO NOTHING;

-- =====================================================
-- ROLE DELEGATION
-- Admin can assign/revoke staff role via User Management
-- =====================================================

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
VALUES (get_role_id('admin'), get_role_id('staff'))
ON CONFLICT DO NOTHING;

-- =====================================================
-- ENTITY NOTES PERMISSIONS (staff-only)
-- enable_entity_notes('clients') in 01_schema grants default access
-- to user + editor roles. Override: remove user access, add staff.
-- =====================================================

-- Remove default user role notes access (notes are staff-only)
DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT p.id FROM metadata.permissions p
  WHERE p.table_name = 'clients:notes'
)
AND role_id IN (
  SELECT r.id FROM metadata.roles r
  WHERE r.role_key IN ('user', 'editor')
);

-- Grant notes access to staff and admin only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'clients:notes'
  AND p.permission IN ('read', 'create')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
