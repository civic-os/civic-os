-- Verify v0-20-3-fix-permission-type-cast
-- Verify the functions exist and can be called without the type cast error

BEGIN;

-- Verify set_role_permission function exists
SELECT pg_catalog.has_function_privilege(
  'public.set_role_permission(smallint, text, text, boolean)',
  'execute'
);

-- Verify ensure_table_permissions function exists
SELECT pg_catalog.has_function_privilege(
  'public.ensure_table_permissions(text)',
  'execute'
);

ROLLBACK;
