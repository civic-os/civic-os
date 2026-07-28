-- Revert civic_os:v0-69-0-pwa-translations

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND (source_key LIKE 'pwa.%' OR source_key = 'a11y.dismiss_install')
  AND locale IN ('es', 'ar', 'fr', 'de', 'ps');

COMMIT;
