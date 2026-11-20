-- =============================================================================
-- MOTT PARK - RESTORE MANAGER ACCESS TO "Reservation Management" (v0.80.3+)
-- =============================================================================
-- Civic OS v0.80.3 changed dashboard visibility: a dashboard with
-- is_public = FALSE is visible only to admins, its creator, or roles listed in
-- metadata.dashboard_roles. "Reservation Management" was created by an init
-- script (created_by NULL) and has no dashboard_roles rows, so managers lost it
-- from the selector after the upgrade. This grants the manager role a 'show'
-- row, which restores the pre-v0.80.3 behavior without making it public.
--
-- Finds the dashboard by title and the role by role_key; does nothing if
-- either is missing. Idempotent.
--
-- Requires: Civic OS v0.80.3+ (metadata.dashboard_roles)
-- =============================================================================

BEGIN;

INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode)
SELECT d.id, r.id, 'show'
FROM metadata.dashboards d
CROSS JOIN metadata.roles r
WHERE d.display_name = 'Reservation Management'
  AND r.role_key = 'manager'
ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- Schema decision (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['reservation_requests', 'reservation_payments']::NAME[], NULL,
    '33_mpra_management_dashboard_roles',
    'Grant managers the Reservation Management dashboard through dashboard_roles',
    'accepted',
    'Civic OS v0.80.3 made is_public = FALSE the only dashboard restriction and metadata.dashboard_roles the only grant. Reservation Management is non-public, was created by a script (no creator), and had no role rows, so after the upgrade only admins could see it. Managers, who work the reservation queue from it, lost it from the dashboard selector.',
    'Add a dashboard_roles row (mode show) for the manager role on Reservation Management, found by title. Keep the dashboard non-public.',
    'A show row restores exactly the audience the dashboard had before v0.80.3 without exposing reservation queues to applicants or anonymous visitors. A default row would also change managers'' landing dashboard, which nobody asked for.',
    'Managers see Reservation Management in the selector again. Any future staff role that needs it gets its own show row. Renaming the dashboard does not affect the grant (it is stored by id); re-running this script after a rename adds nothing.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '33_mpra_management_dashboard_roles'
      AND title = 'Grant managers the Reservation Management dashboard through dashboard_roles'
);
