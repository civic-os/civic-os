-- Verify civic_os:v0-80-2-instance-config-label-i18n

DO $$
BEGIN
  -- Check the rewrite rule's dependency on metadata.t(), not the deparsed text: pg_get_viewdef drops the
  -- schema prefix when metadata is on the session's search_path, as it is during migrations.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_rewrite r
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
    JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
    WHERE r.ev_class = 'public.instance_config'::regclass
      AND p.proname = 't'
      AND p.pronamespace = 'metadata'::regnamespace
  ) THEN
    RAISE EXCEPTION 'public.instance_config does not route labels through metadata.t()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.instance_config'::regclass
      AND 'security_invoker=true' = ANY (reloptions)
  ) THEN
    RAISE EXCEPTION 'public.instance_config lost security_invoker';
  END IF;

  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type IN ('instance_config', 'instance_config_group')
        AND locale IN ('es', 'ar', 'fr', 'de', 'ps')
        AND source_key IN ('appearance.display_name', 'appearance.description', 'language.display_name', 'language.description', 'integrations.display_name', 'integrations.description', 'map.display_name', 'map.description', 'app_title.display_name', 'app_title.description', 'default_theme.display_name', 'default_theme.description', 'default_locale.display_name', 'default_locale.description', 'supported_locales.display_name', 'supported_locales.description', 'sms_configured.display_name', 'sms_configured.description', 'matomo_enabled.display_name', 'matomo_enabled.description', 'stripe_publishable_key.display_name', 'stripe_publishable_key.description', 'map_default_lat.display_name', 'map_default_lat.description', 'map_default_lng.display_name', 'map_default_lng.description', 'map_default_zoom.display_name', 'map_default_zoom.description')) < 140 THEN
    RAISE EXCEPTION 'Expected 140 framework label translations (28 sources x 5 locales)';
  END IF;
END $$;
