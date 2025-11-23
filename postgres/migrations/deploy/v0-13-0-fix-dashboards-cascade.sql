-- Deploy civic-os:v0-13-0-fix-dashboards-cascade to pg
-- requires: v0-13-0-add-payments-poc

BEGIN;

-- ============================================================================
-- Fix dashboards.created_by foreign key to allow user deletion
-- ============================================================================
--
-- Problem: Mock data cleanup tries to DELETE FROM civic_os_users, but
-- dashboards.created_by REFERENCES civic_os_users(id) with default RESTRICT
-- behavior prevents deletion when dashboards exist.
--
-- Solution: Add ON DELETE SET NULL to allow dashboards to outlive their creator.
-- When a user is deleted, their dashboards remain but created_by is set to NULL.
-- ============================================================================

\echo 'Fixing dashboards.created_by foreign key constraint...'

-- Drop existing constraint
ALTER TABLE metadata.dashboards
  DROP CONSTRAINT IF EXISTS dashboards_created_by_fkey;

-- Re-add constraint with ON DELETE SET NULL
ALTER TABLE metadata.dashboards
  ADD CONSTRAINT dashboards_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES metadata.civic_os_users(id)
    ON DELETE SET NULL;

\echo 'Fixed dashboards.created_by foreign key constraint'

COMMIT;
