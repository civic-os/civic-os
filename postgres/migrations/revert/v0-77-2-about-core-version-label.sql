-- Revert civic_os:v0-77-2-about-core-version-label
--
-- Restores the v0.77.0 text only on rows still holding the text this change wrote.

BEGIN;

UPDATE metadata.translations t
SET translated_text = relabel.old_text
FROM (VALUES
  ('en', 'Framework version:', 'Database core version:'),
  ('es', 'Versión del framework:', 'Versión del núcleo de la base de datos:'),
  ('ar', 'إصدار الإطار:', 'إصدار نواة قاعدة البيانات:'),
  ('fr', 'Version du framework :', 'Version du noyau de la base de données :'),
  ('de', 'Framework-Version:', 'Version des Datenbankkerns:'),
  ('ps', 'د چوکاټ نسخه:', 'د ډیټابیس د هستې نسخه:')
) AS relabel(locale, old_text, new_text)
WHERE t.source_type = 'ui'
  AND t.source_key = 'about.framework_version'
  AND t.locale = relabel.locale
  AND t.translated_text = relabel.new_text;

COMMIT;
