-- Revert civic_os:v0-77-0-about-version-translations
--
-- Deletes only rows still holding the text this change seeded. A row an integrator customized
-- (deploy uses ON CONFLICT DO NOTHING, so it may predate this change or have been edited since)
-- is left in place.

BEGIN;

DELETE FROM metadata.translations t
USING (VALUES
  ('about.version', 'en', 'Version:'),
  ('about.version', 'es', 'Versión:'),
  ('about.version', 'ar', 'الإصدار:'),
  ('about.version', 'fr', 'Version :'),
  ('about.version', 'de', 'Version:'),
  ('about.version', 'ps', 'نسخه:'),
  ('about.domain_version', 'en', 'Domain version:'),
  ('about.domain_version', 'es', 'Versión del dominio:'),
  ('about.domain_version', 'ar', 'إصدار النطاق:'),
  ('about.domain_version', 'fr', 'Version du domaine :'),
  ('about.domain_version', 'de', 'Domänenversion:'),
  ('about.domain_version', 'ps', 'د ډومین نسخه:'),
  ('about.framework_version', 'en', 'Framework version:'),
  ('about.framework_version', 'es', 'Versión del framework:'),
  ('about.framework_version', 'ar', 'إصدار الإطار:'),
  ('about.framework_version', 'fr', 'Version du framework :'),
  ('about.framework_version', 'de', 'Framework-Version:'),
  ('about.framework_version', 'ps', 'د چوکاټ نسخه:')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
