-- Verify civic_os:v0-80-3-dashboard-role-visibility

DO $$
DECLARE
  v_sig TEXT;
  v_missing INT;
  v_found INT;
BEGIN
  IF to_regclass('metadata.dashboard_roles') IS NULL THEN
    RAISE EXCEPTION 'metadata.dashboard_roles is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'metadata' AND indexname = 'idx_dashboard_roles_role_id') THEN
    RAISE EXCEPTION 'idx_dashboard_roles_role_id is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'metadata' AND indexname = 'idx_dashboard_roles_one_default_per_role'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%mode%default%'
  ) THEN
    RAISE EXCEPTION 'the partial unique default index is missing';
  END IF;

  -- Policies: the two read policies per table are replaced by one that uses the shared rule
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'metadata' AND tablename = 'dashboards'
      AND policyname = 'Dashboards visible by role' AND qual LIKE '%dashboard_visible%'
  ) THEN
    RAISE EXCEPTION 'dashboards read policy does not use dashboard_visible()';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'metadata' AND tablename = 'dashboards'
      AND policyname IN ('Everyone can read public dashboards', 'Users can read own private dashboards')
  ) THEN
    RAISE EXCEPTION 'an old dashboards read policy is still present';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'metadata' AND tablename = 'dashboard_widgets'
      AND policyname = 'Widgets visible with their dashboard'
  ) OR EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'metadata' AND tablename = 'dashboard_widgets'
      AND policyname IN ('Everyone can read public dashboard widgets', 'Users can read own dashboard widgets')
  ) THEN
    RAISE EXCEPTION 'dashboard_widgets read policies are not the shared-rule policy';
  END IF;

  -- No PUBLIC execute on the new functions
  FOREACH v_sig IN ARRAY ARRAY[
    'metadata.dashboard_visible(int, boolean, uuid)',
    'metadata.can_see_dashboard(int)',
    'metadata.sync_dashboard_role_default()',
    'public.set_dashboard_roles(int, text[], text, int)'
  ] LOOP
    IF has_function_privilege('public', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by PUBLIC', v_sig;
    END IF;
  END LOOP;

  IF has_function_privilege('web_anon', 'public.set_dashboard_roles(int, text[], text, int)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'set_dashboard_roles is executable by web_anon';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY['public.get_dashboards()', 'public.get_dashboard(int)', 'public.get_user_default_dashboard()'] LOOP
    IF pg_get_functiondef(v_sig::regprocedure) NOT LIKE '%dashboard_roles%'
       AND pg_get_functiondef(v_sig::regprocedure) NOT LIKE '%can_see_dashboard%'
       AND pg_get_functiondef(v_sig::regprocedure) NOT LIKE '%dashboard_visible%' THEN
      RAISE EXCEPTION '% does not use the dashboard visibility rule', v_sig;
    END IF;
    IF NOT has_function_privilege('web_anon', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost its web_anon grant', v_sig;
    END IF;
  END LOOP;

  -- Every legacy default has its default row
  SELECT COUNT(*) INTO v_missing
  FROM metadata.dashboard_role_defaults drd
  WHERE NOT EXISTS (
    SELECT 1 FROM metadata.dashboard_roles dr
    WHERE dr.dashboard_id = drd.dashboard_id AND dr.role_id = drd.role_id
      AND dr.mode = 'default' AND dr.priority = drd.priority
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% dashboard_role_defaults rows were not copied into dashboard_roles', v_missing;
  END IF;

  SELECT COUNT(*) INTO v_found
  FROM metadata.translations
  WHERE source_type = 'ui'
    AND source_key IN ('dashboard.error.not_found', 'dashboard.error.load_failed', 'dashboard.error.load_default_failed', 'dashboard.error.no_default', 'dashboard.error.title')
    AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps');
  IF v_found < 30 THEN
    RAISE EXCEPTION 'Expected at least 30 dashboard error translations, found %', v_found;
  END IF;
END $$;
