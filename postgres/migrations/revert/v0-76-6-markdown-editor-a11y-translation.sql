-- Revert civic_os:v0-76-6-markdown-editor-a11y-translation

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key = 'a11y.markdown_editor'
  AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps');

COMMIT;
