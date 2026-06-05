-- Verify v0-59-0-send-email-rpc

BEGIN;

-- 1. send_email() exists in metadata schema
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
      AND p.proname = 'send_email'
  ) THEN
    RAISE EXCEPTION 'metadata.send_email() does not exist';
  END IF;
END $$;

-- 2. send_email() is SECURITY DEFINER
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'metadata'
      AND p.proname = 'send_email'
      AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION 'send_email must be SECURITY DEFINER';
  END IF;
END $$;

-- 3. send_email() is NOT in public schema (not exposed via PostgREST)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'send_email'
  ) THEN
    RAISE EXCEPTION 'send_email must NOT be in public schema';
  END IF;
END $$;

ROLLBACK;
