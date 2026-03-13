-- Verify v0-36-0-notification-role-helpers

BEGIN;

-- 1. get_users_by_role() exists in metadata schema
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
      AND p.proname = 'get_users_by_role'
  ) THEN
    RAISE EXCEPTION 'metadata.get_users_by_role() does not exist';
  END IF;
END $$;

-- 2. send_notification_to_role() exists in metadata schema
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
      AND p.proname = 'send_notification_to_role'
  ) THEN
    RAISE EXCEPTION 'metadata.send_notification_to_role() does not exist';
  END IF;
END $$;

-- 3. Both are SECURITY DEFINER
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
      AND p.proname = 'get_users_by_role'
      AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION 'get_users_by_role must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
      AND p.proname = 'send_notification_to_role'
      AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION 'send_notification_to_role must be SECURITY DEFINER';
  END IF;
END $$;

-- 4. Functions are NOT in public schema (not exposed via PostgREST)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_users_by_role', 'send_notification_to_role')
  ) THEN
    RAISE EXCEPTION 'Helper functions must NOT be in public schema';
  END IF;
END $$;

-- 5. get_users_by_role returns expected columns
DO $$
DECLARE
  v_rec RECORD;
BEGIN
  FOR v_rec IN SELECT user_id FROM metadata.get_users_by_role(ARRAY['admin']) LIMIT 1 LOOP
    NULL;
  END LOOP;
END $$;

ROLLBACK;
