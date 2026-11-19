-- Verify civic_os:v0-82-0-dashboard-show-in-selector

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'metadata' AND table_name = 'dashboards' AND column_name = 'show_in_selector'
      AND data_type = 'boolean' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'metadata.dashboards.show_in_selector is missing or nullable';
  END IF;

  -- get_dashboards() returns the flag (an OUT column of the set-returning function)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_dashboards'
      AND 'show_in_selector' = ANY(p.proargnames)
  ) THEN
    RAISE EXCEPTION 'get_dashboards() does not return show_in_selector';
  END IF;

  IF NOT has_function_privilege('web_anon', 'public.get_dashboards()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_dashboards()', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_dashboards() is not executable by web_anon and authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_dashboard'
      AND p.prosecdef AND p.prosrc LIKE '%show_in_selector%'
  ) THEN
    RAISE EXCEPTION 'get_dashboard() does not return show_in_selector';
  END IF;
END $$;
