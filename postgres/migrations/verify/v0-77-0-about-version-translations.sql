-- Verify civic_os:v0-77-0-about-version-translations

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN ('about.version', 'about.domain_version', 'about.framework_version')
        AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps')) <> 18 THEN
    RAISE EXCEPTION 'Expected 3 about.* version keys x 6 locales (18 rows)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'about.domain_version' AND locale = 'es'
  ) THEN
    -- Existence only: an integrator may have customized the text
    RAISE EXCEPTION 'Sentinel translation about.domain_version/es not found';
  END IF;
END $$;
