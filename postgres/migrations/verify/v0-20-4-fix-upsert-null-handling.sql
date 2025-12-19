-- Verify v0-20-4-fix-upsert-null-handling
-- Verify the function exists

BEGIN;

SELECT pg_catalog.has_function_privilege(
  'public.upsert_property_metadata(name, name, text, text, int, int, boolean, boolean, boolean, boolean, boolean, boolean, boolean)',
  'execute'
);

ROLLBACK;
