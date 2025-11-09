-- Verify civic_os:v0-11-0-add-user-roles on pg

BEGIN;

-- Verify metadata.user_roles table exists
SELECT user_id, role_id, synced_at
FROM metadata.user_roles
WHERE FALSE;

-- Verify has_role() function exists
SELECT has_value FROM (
  SELECT public.has_role(NULL::UUID, 'admin'::TEXT) AS has_value
  WHERE FALSE
) AS t;

-- Verify RLS is enabled on user_roles
DO $$
BEGIN
  IF NOT (
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'metadata.user_roles'::regclass
  ) THEN
    RAISE EXCEPTION 'Row Level Security not enabled on metadata.user_roles';
  END IF;
END $$;

ROLLBACK;
