-- Neighborhood Engagement Hub - dashboard role visibility (v0.80.3)
-- The staff and admin dashboards were public: every visitor, including anonymous ones, saw them in the
-- dashboard selector. Restrict each to the roles that use it. NEH Borrower stays public (it is the
-- default of the `user` role). The Keycloak test users hold user, editor, manager and admin only, so
-- each still sees NEH Borrower and testadmin sees everything (admins see every dashboard).
--
-- Writes dashboard_roles directly: init scripts run without a JWT, so set_dashboard_roles() (admin only)
-- would refuse. Idempotent: replaces the show rows of these two dashboards.
BEGIN;

DELETE FROM metadata.dashboard_roles
WHERE mode = 'show'
  AND dashboard_id IN (SELECT id FROM metadata.dashboards WHERE display_name IN ('NEH Staff', 'NEH Admin'));

INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode, priority)
SELECT d.id, r.id, 'show', 0
FROM metadata.dashboards d
JOIN metadata.roles r ON (
     (d.display_name = 'NEH Staff' AND r.role_key IN ('neh_staff', 'neh_admin'))
  OR (d.display_name = 'NEH Admin' AND r.role_key = 'neh_admin')
)
WHERE d.display_name IN ('NEH Staff', 'NEH Admin')
ON CONFLICT (dashboard_id, role_id) DO NOTHING;

COMMIT;
