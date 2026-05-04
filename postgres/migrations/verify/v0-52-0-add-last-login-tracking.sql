-- Verify civic_os:v0-52-0-add-last-login-tracking on pg

BEGIN;

-- 1. Verify last_login_at column exists on civic_os_users_private
SELECT last_login_at FROM metadata.civic_os_users_private WHERE FALSE;

-- 2. Verify last_login_at column exists on managed_users VIEW
SELECT last_login_at FROM public.managed_users WHERE FALSE;

-- 3. Verify refresh_current_user() references last_login_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'refresh_current_user'
      AND prosrc LIKE '%last_login_at%'
  ) THEN
    RAISE EXCEPTION 'refresh_current_user() does not reference last_login_at';
  END IF;
END;
$$;

-- 4. Verify current_user_first_name() exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'current_user_first_name'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    RAISE EXCEPTION 'current_user_first_name() function does not exist';
  END IF;
END;
$$;

-- 5. Verify current_user_last_name() exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'current_user_last_name'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    RAISE EXCEPTION 'current_user_last_name() function does not exist';
  END IF;
END;
$$;

-- 6. Verify refresh_current_user() references OIDC claims
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'refresh_current_user'
      AND prosrc LIKE '%current_user_first_name%'
  ) THEN
    RAISE EXCEPTION 'refresh_current_user() does not reference current_user_first_name()';
  END IF;
END;
$$;

-- 7. Verify backfill: no completed provisioned users with NULL first_name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM metadata.civic_os_users_private cup
    JOIN metadata.user_provisioning up
      ON up.keycloak_user_id = cup.id
    WHERE up.status = 'completed'
      AND cup.first_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Backfill incomplete: provisioned users still have NULL first_name';
  END IF;
END;
$$;

ROLLBACK;
