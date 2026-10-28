-- Verify civic_os:v0-77-2-about-core-version-label

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'about.framework_version'
      AND (locale, translated_text) IN (
        ('en', 'Framework version:'), ('es', 'Versión del framework:'), ('ar', 'إصدار الإطار:'),
        ('fr', 'Version du framework :'), ('de', 'Framework-Version:'), ('ps', 'د چوکاټ نسخه:'))
  ) THEN
    RAISE EXCEPTION 'about.framework_version still holds a v0.77.0 seeded label';
  END IF;
END $$;
