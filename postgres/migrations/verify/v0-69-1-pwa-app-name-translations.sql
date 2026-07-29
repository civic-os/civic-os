-- Verify v0-69-1-pwa-app-name-translations

DO $$
BEGIN
  -- Verify {{appName}} is present in all install_prompt translations
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key = 'pwa.install_prompt'
        AND locale IN ('es', 'ar', 'fr', 'de', 'ps')
        AND translated_text LIKE '%{{appName}}%') < 5 THEN
    RAISE EXCEPTION 'Expected {{appName}} in pwa.install_prompt for all 5 locales';
  END IF;

  -- Verify {{appName}} is present in all install_description translations
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key = 'pwa.install_description'
        AND locale IN ('es', 'ar', 'fr', 'de', 'ps')
        AND translated_text LIKE '%{{appName}}%') < 5 THEN
    RAISE EXCEPTION 'Expected {{appName}} in pwa.install_description for all 5 locales';
  END IF;
END $$;
