-- Verify civic_os:v0-43-1-resolve-role-key on pg

BEGIN;

-- Verify resolve_role_key() exists
SELECT has_function_privilege('public.resolve_role_key(text)', 'execute');

ROLLBACK;
