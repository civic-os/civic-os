-- Verify civic-os:v0-13-0-fix-dashboards-cascade on pg

BEGIN;

-- Verify the constraint exists with ON DELETE SET NULL
SELECT 1/COUNT(*)
FROM information_schema.referential_constraints
WHERE constraint_schema = 'metadata'
  AND constraint_name = 'dashboards_created_by_fkey'
  AND delete_rule = 'SET NULL';

ROLLBACK;
