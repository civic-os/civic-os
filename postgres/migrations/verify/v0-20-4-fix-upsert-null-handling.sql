-- Verify v0-20-4-fix-upsert-null-handling
-- Verify the function exists

BEGIN;

-- Match by name and a minimum arity: this change introduced the 13-argument overload (the baseline's
-- older 12-argument overload must not satisfy the check) and later migrations only add parameters.
SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'upsert_property_metadata'
  AND pronamespace = 'public'::regnamespace
  AND pronargs >= 13;

ROLLBACK;
