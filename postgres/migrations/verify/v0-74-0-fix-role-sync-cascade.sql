-- Verify civic_os:v0-74-0-fix-role-sync-cascade on pg

BEGIN;

-- Verify refresh_current_user() uses DO NOTHING for civic_os_users (public table)
DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE proname = 'refresh_current_user'
    AND pronamespace = 'public'::regnamespace;

  IF v_source NOT LIKE '%DO NOTHING%' THEN
    RAISE EXCEPTION 'refresh_current_user() does not contain DO NOTHING — migration not applied';
  END IF;
END $$;

-- Verify get_real_user_roles() is still used (v0.41.2 impersonation fix preserved)
DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE proname = 'refresh_current_user'
    AND pronamespace = 'public'::regnamespace;

  IF v_source NOT LIKE '%get_real_user_roles%' THEN
    RAISE EXCEPTION 'refresh_current_user() does not use get_real_user_roles() — impersonation fix lost';
  END IF;
END $$;

-- Verify Phase 2 DELETE is removed
DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE proname = 'refresh_current_user'
    AND pronamespace = 'public'::regnamespace;

  IF v_source LIKE '%DELETE FROM metadata.user_roles%' THEN
    RAISE EXCEPTION 'refresh_current_user() still contains DELETE FROM metadata.user_roles — cascade bug not fixed';
  END IF;
END $$;

-- Verify schema decision was recorded
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = 'v0-74-0-fix-role-sync-cascade'
  ) THEN
    RAISE EXCEPTION 'Schema decision for v0-74-0-fix-role-sync-cascade not found';
  END IF;
END $$;

ROLLBACK;
