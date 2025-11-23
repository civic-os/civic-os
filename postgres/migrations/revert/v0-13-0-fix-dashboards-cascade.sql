-- Revert civic-os:v0-13-0-fix-dashboards-cascade from pg

BEGIN;

\echo 'Reverting dashboards.created_by foreign key constraint...'

-- Drop constraint with ON DELETE SET NULL
ALTER TABLE metadata.dashboards
  DROP CONSTRAINT IF EXISTS dashboards_created_by_fkey;

-- Re-add original constraint (RESTRICT by default)
ALTER TABLE metadata.dashboards
  ADD CONSTRAINT dashboards_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES metadata.civic_os_users(id);

\echo 'Reverted dashboards.created_by foreign key constraint'

COMMIT;
