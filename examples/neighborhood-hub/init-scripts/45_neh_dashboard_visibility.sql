-- Neighborhood Engagement Hub - dashboard role visibility (v0.80.3)
-- The staff and admin dashboards were public: every visitor, including anonymous ones, saw them in the
-- dashboard selector. Make them non-public. Rows in dashboard_roles only grant, so each stays visible to
-- the roles that use it:
--   NEH Staff : neh_staff through its default row (script 10), plus a show row for neh_admin
--   NEH Admin : neh_admin through its default row (script 10)
-- NEH Borrower stays public (it is the default of the `user` role). Admins see every dashboard. The
-- Keycloak test users hold user, editor, manager and admin only, so each still sees NEH Borrower and
-- testadmin sees everything.
--
-- Default rows are left alone (they were written through dashboard_role_defaults in script 10 and are
-- synced into dashboard_roles). The show row is inserted directly: init scripts run without a JWT, so
-- set_dashboard_roles() (admin only) would refuse. Idempotent.
BEGIN;

UPDATE metadata.dashboards SET is_public = FALSE WHERE display_name IN ('NEH Staff', 'NEH Admin');

INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode, priority)
SELECT d.id, r.id, 'show', 0
FROM metadata.dashboards d
JOIN metadata.roles r ON r.role_key = 'neh_admin'
WHERE d.display_name = 'NEH Staff'
ON CONFLICT (dashboard_id, role_id) DO NOTHING;

COMMIT;
