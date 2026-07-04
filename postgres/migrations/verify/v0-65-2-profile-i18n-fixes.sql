-- Verify civic_os:v0-65-2-profile-i18n-fixes on pg

BEGIN;

DO $$
DECLARE
  v_count INT;
  v_view_def TEXT;
BEGIN
  -- Verify RPCs no longer exist
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'get_user_profile_extensions'
    AND pronamespace = 'public'::regnamespace;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'get_user_profile_extensions() should not exist, found % versions', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'get_user_profile_extensions_admin'
    AND pronamespace = 'public'::regnamespace;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'get_user_profile_extensions_admin() should not exist, found % versions', v_count;
  END IF;

  -- Verify schema_cache_versions includes profile_extensions
  SELECT count(*) INTO v_count
  FROM public.schema_cache_versions
  WHERE cache_name = 'profile_extensions';

  IF v_count < 1 THEN
    RAISE EXCEPTION 'schema_cache_versions missing profile_extensions row';
  END IF;

  -- Verify user_profile_extensions VIEW uses the translation function
  -- pg_get_viewdef may resolve metadata.t() as just t() depending on search_path
  SELECT pg_get_viewdef('public.user_profile_extensions'::regclass) INTO v_view_def;

  IF v_view_def NOT LIKE '%t(%entity%display_name%' THEN
    RAISE EXCEPTION 'user_profile_extensions VIEW does not use metadata.t() — got: %', left(v_view_def, 200);
  END IF;

  -- Verify user_fk_constraint column exists in VIEW
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'user_profile_extensions'
    AND column_name = 'user_fk_constraint';

  IF v_count < 1 THEN
    RAISE EXCEPTION 'user_profile_extensions VIEW missing user_fk_constraint column';
  END IF;

  -- Verify translation keys exist
  SELECT count(*) INTO v_count
  FROM metadata.translations
  WHERE source_type = 'ui'
    AND source_key IN ('profile.language', 'profile.user_profile', 'profile.user_not_found');

  IF v_count < 3 THEN
    RAISE EXCEPTION 'Expected at least 3 profile translation rows, found %', v_count;
  END IF;

  -- Verify first_name and last_name columns exist in civic_os_users VIEW
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'civic_os_users'
    AND column_name IN ('first_name', 'last_name');

  IF v_count < 2 THEN
    RAISE EXCEPTION 'civic_os_users VIEW missing first_name/last_name columns, found %', v_count;
  END IF;
END $$;

ROLLBACK;
