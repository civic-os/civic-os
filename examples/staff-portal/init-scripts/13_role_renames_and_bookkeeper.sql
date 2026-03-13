-- =============================================================================
-- FFSC: Role renames + new Bookkeeper role
-- Requires: Civic OS v0.36.0 (role_key column), patch 12 applied first
--
-- With role_key in place, display_name is now a freely-editable human label.
-- Renaming display_name does NOT affect JWT matching, RBAC lookups, or
-- notification routing — those all use role_key.
--
-- Changes:
--   1. Rename display_name: 'editor' -> 'Site Coordinator'  (role_key stays 'editor')
--   2. Rename display_name: 'user'   -> 'Seasonal Staff'    (role_key stays 'user')
--   3. Create new role: 'Bookkeeper'                        (role_key = 'bookkeeper')
--      Keycloak sync is automatic via trg_roles_sync_keycloak trigger (v0.36.0+)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Rename display names (role_key is immutable, no other changes needed)
-- -----------------------------------------------------------------------------

UPDATE metadata.roles SET display_name = 'Site Coordinator' WHERE role_key = 'editor';
UPDATE metadata.roles SET display_name = 'Seasonal Staff'   WHERE role_key = 'user';

-- -----------------------------------------------------------------------------
-- 2. Create Bookkeeper role
--    INSERT triggers auto-generates role_key = 'bookkeeper' from display_name.
-- -----------------------------------------------------------------------------

INSERT INTO metadata.roles (display_name, description)
VALUES ('Bookkeeper', 'Financial oversight: reimbursements, payment approvals');

-- NOTE: Keycloak sync is handled automatically by trg_roles_sync_keycloak
-- trigger on metadata.roles (v0.36.0+). No manual river_job INSERT needed.

-- -----------------------------------------------------------------------------
-- 4. Grant permissions to Bookkeeper
--    Copy from editor baseline, then add reimbursement-specific grants.
--    TODO: Fill in actual permission grants once reimbursement entity exists.
-- -----------------------------------------------------------------------------

-- Example (uncomment and adjust when ready):
-- SELECT set_role_permission(get_role_id('bookkeeper'), 'reimbursements', 'read', true);
-- SELECT set_role_permission(get_role_id('bookkeeper'), 'reimbursements', 'create', true);
-- SELECT set_role_permission(get_role_id('bookkeeper'), 'reimbursements', 'update', true);

-- -----------------------------------------------------------------------------
-- 5. Configure role delegation (who can assign Bookkeeper)
--    Allow admin and manager to assign/revoke the bookkeeper role.
--    TODO: Uncomment when ready to deploy.
-- -----------------------------------------------------------------------------

-- INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
-- VALUES
--   (get_role_id('admin'), get_role_id('bookkeeper')),
--   (get_role_id('manager'), get_role_id('bookkeeper'));

COMMIT;
