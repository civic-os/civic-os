-- 42_neh_admin_notes_read.sql
-- Neighborhood Hub example: the admin role reads notes on borrowers and tool instances again.
--
-- Run after 38_neh_access_hardening.sql, which removed notes read from the "user" role.
--
-- enable_entity_notes() grants notes read to "user" and every notes permission to "editor";
-- scripts 22 and 28 add neh_staff and neh_admin. has_permission() has no admin bypass, so an
-- account holding only the framework admin role read these notes through "user" alone, and lost
-- them with script 38: the notes panel on a borrower showed nothing, including the system note
-- update_borrower_address writes.
--
-- Safe to re-run.

BEGIN;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('borrowers:notes', 'tool_instances:notes')
  AND p.permission = 'read'
  AND r.role_key = 'admin'
ON CONFLICT DO NOTHING;

-- Schema decision (ADR)
-- Direct INSERT because init scripts run without JWT context.

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['borrowers', 'tool_instances']::NAME[],
    'neh-42-admin-notes-read',
    'Admin reads borrower and tool instance notes',
    'accepted',
    'The admin role holds read on borrowers:notes and tool_instances:notes.',
    'Script 38 removed notes read from the user role so borrowers cannot read notes on their own '
    'record. has_permission has no admin bypass, and admin had read these notes only through the '
    'user role, so admins lost them too.',
    'Admins read notes but do not create them unless they also hold editor, neh_staff or neh_admin. '
    'Borrowers still cannot read notes.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions WHERE migration_id = 'neh-42-admin-notes-read'
);

COMMIT;
