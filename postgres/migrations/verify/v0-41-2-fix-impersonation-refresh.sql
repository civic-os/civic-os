-- Verify civic_os:v0-41-2-fix-impersonation-refresh on pg

BEGIN;

-- Verify get_real_user_roles() exists in both schemas
SELECT has_function_privilege('metadata.get_real_user_roles()', 'execute');
SELECT has_function_privilege('public.get_real_user_roles()', 'execute');

-- Verify protect_builtin_roles trigger exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_protect_builtin_roles'
      AND tgrelid = 'metadata.roles'::regclass
  ) THEN
    RAISE EXCEPTION 'Missing trigger: trg_protect_builtin_roles';
  END IF;
END $$;

-- Verify refresh_current_user() uses get_real_user_roles (check function source)
DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE proname = 'refresh_current_user'
    AND pronamespace = 'public'::regnamespace;

  IF v_source NOT LIKE '%get_real_user_roles%' THEN
    RAISE EXCEPTION 'refresh_current_user() does not use get_real_user_roles()';
  END IF;

  IF v_source LIKE '%get_user_roles()%' THEN
    RAISE EXCEPTION 'refresh_current_user() still uses get_user_roles() (should use get_real_user_roles)';
  END IF;
END $$;

-- Verify myclient removed from get_user_roles and is_real_admin
DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE proname = 'get_user_roles'
    AND pronamespace = 'metadata'::regnamespace;

  IF v_source LIKE '%myclient%' THEN
    RAISE EXCEPTION 'get_user_roles() still contains myclient reference';
  END IF;

  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE proname = 'is_real_admin'
    AND pronamespace = 'metadata'::regnamespace;

  IF v_source LIKE '%myclient%' THEN
    RAISE EXCEPTION 'is_real_admin() still contains myclient reference';
  END IF;
END $$;

ROLLBACK;
