-- Verify v0-65-0-user-profile-extensions

DO $$
BEGIN
  -- Verify config table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'metadata' AND table_name = 'user_profile_extensions'
  ) THEN
    RAISE EXCEPTION 'metadata.user_profile_extensions table not found';
  END IF;

  -- Verify RPCs exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'update_own_profile'
  ) THEN
    RAISE EXCEPTION 'update_own_profile() RPC not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'get_own_profile'
  ) THEN
    RAISE EXCEPTION 'get_own_profile() RPC not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'get_user_profile_extensions'
  ) THEN
    RAISE EXCEPTION 'get_user_profile_extensions() RPC not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'get_user_profile_extensions_admin'
  ) THEN
    RAISE EXCEPTION 'get_user_profile_extensions_admin() RPC not found';
  END IF;

  -- Verify PostgREST VIEW exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'user_profile_extensions'
  ) THEN
    RAISE EXCEPTION 'public.user_profile_extensions VIEW not found';
  END IF;

  -- Verify RLS is enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'metadata' AND tablename = 'user_profile_extensions' AND rowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on metadata.user_profile_extensions';
  END IF;

  -- Verify English translations exist
  IF (SELECT count(*) FROM metadata.translations WHERE source_key LIKE 'profile.%' AND locale = 'en') = 0 THEN
    RAISE EXCEPTION 'No English profile translations found';
  END IF;
END $$;
