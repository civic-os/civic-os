-- Revert civic_os:v0-76-6-markdown-editor-a11y-translation

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key IN ('a11y.markdown_editor', 'error.series_split_failed')
  AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps');

COMMIT;
