-- Verify v0-20-4-fix-upsert-null-handling
-- Verify the function exists

BEGIN;

-- Match by name only: later migrations added parameters to this function.
SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'upsert_property_metadata'
  AND pronamespace = 'public'::regnamespace;

ROLLBACK;
