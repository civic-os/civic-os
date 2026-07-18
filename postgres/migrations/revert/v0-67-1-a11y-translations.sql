-- Revert civic_os:v0-67-1-a11y-translations

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key LIKE 'a11y.%'
  AND locale IN ('es', 'ar', 'fr', 'de', 'ps');

COMMIT;
