-- Deploy civic_os:v0-77-2-about-core-version-label
-- Requires: v0-77-0-about-version-translations
--
-- v0.77.2 -- Relabel the about modal's about.framework_version line as "Database core version".
-- metadata.framework_version() is the highest migration in the Sqitch registry, so it moves only with
-- releases that ship a migration; "Framework version" read as the release number and disagreed with
-- the app version after a frontend-only patch. Rewrites only rows still holding the v0.77.0 seed, so a
-- translation an integrator customized is left alone. Instance-agnostic UI strings only.

BEGIN;

UPDATE metadata.translations t
SET translated_text = relabel.new_text
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
  AND t.translated_text = relabel.old_text;

COMMIT;
