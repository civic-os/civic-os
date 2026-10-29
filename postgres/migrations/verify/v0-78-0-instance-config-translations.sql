-- Verify civic_os:v0-78-0-instance-config-translations

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN (
          'sidebar.config',
          'a11y.admin_config.reset',
          'admin_config.title',
          'admin_config.intro',
          'admin_config.load_error',
          'admin_config.read_only_notice',
          'admin_config.other_group',
          'admin_config.saving',
          'admin_config.saved',
          'admin_config.reset',
          'admin_config.done',
          'admin_config.not_set',
          'admin_config.inherited_from',
          'admin_config.locale_hint',
          'admin_config.locale_list_hint',
          'admin_config.enabled',
          'admin_config.disabled',
          'admin_config.deployment_title',
          'admin_config.deployment_redeploy',
          'admin_config.deployment_favicon',
          'admin_config.deployment_default',
          'admin_config.deployment_pwa_enabled',
          'admin_config.deployment_pwa_app_name',
          'admin_config.deployment_uses_app_title',
          'admin_config.deployment_map_tiles',
          'payment.error.stripe_not_configured'
        )
        AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps')) <> 156 THEN
    RAISE EXCEPTION 'Expected 26 keys x 6 locales (156 rows)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'sidebar.config' AND locale = 'es'
  ) THEN
    -- Existence only: an integrator may have customized the text
    RAISE EXCEPTION 'Sentinel translation sidebar.config/es not found';
  END IF;
END $$;
