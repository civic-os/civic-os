-- =============================================================================
-- Script 23: Staff Permissions — User Management + Reports
-- =============================================================================
-- Grants staff the permissions needed for day-to-day operations:
--   A. User Management access (CUP create + update)
--   B. Role delegation (staff can assign staff and user roles)
--   C. Report VIEW access (database GRANTs + metadata permissions)
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. USER MANAGEMENT ACCESS
-- =============================================================================
-- CUP update gates the User Management page via hasUserManagementAccess().
-- CUP create allows staff to provision new user accounts.

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission IN ('create', 'update')
  AND r.role_key = 'staff'
ON CONFLICT DO NOTHING;


-- =============================================================================
-- B. ROLE DELEGATION
-- =============================================================================
-- staff can already delegate 'user'. Add staff so senior staff
-- can onboard new staff members without needing an admin.

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT
  (SELECT id FROM metadata.roles WHERE role_key = 'staff'),
  (SELECT id FROM metadata.roles WHERE role_key = 'staff')
ON CONFLICT DO NOTHING;


-- =============================================================================
-- C. REPORT VIEW ACCESS
-- =============================================================================
-- These are definer VIEWs (not security_invoker), so GRANT SELECT is
-- sufficient at the database level. Metadata read permission controls
-- UI visibility.

GRANT SELECT ON monthly_referral_summary TO authenticated;
GRANT SELECT ON client_contact_summary TO authenticated;
GRANT SELECT ON top_needs_report TO authenticated;
GRANT SELECT ON partner_utilization_report TO authenticated;
GRANT SELECT ON time_lag_report TO authenticated;
GRANT SELECT ON referrals_per_week TO authenticated;

-- Create read permissions for report VIEWs (not auto-created because
-- these VIEWs were registered with show_in_sidebar = false)
INSERT INTO metadata.permissions (table_name, permission)
VALUES
  ('monthly_referral_summary', 'read'),
  ('client_contact_summary', 'read'),
  ('top_needs_report', 'read'),
  ('partner_utilization_report', 'read'),
  ('time_lag_report', 'read'),
  ('referrals_per_week', 'read')
ON CONFLICT DO NOTHING;

-- Grant read permission to staff and admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN (
    'monthly_referral_summary', 'client_contact_summary',
    'top_needs_report', 'partner_utilization_report',
    'time_lag_report', 'referrals_per_week'
  )
  AND p.permission = 'read'
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;


NOTIFY pgrst, 'reload schema';

COMMIT;
