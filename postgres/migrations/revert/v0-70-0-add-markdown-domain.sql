-- Revert civic_os:v0-70-0-add-markdown-domain from pg

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key IN (
    'a11y.markdown_toolbar', 'a11y.bold', 'a11y.italic', 'a11y.strikethrough',
    'a11y.heading_1', 'a11y.heading_2', 'a11y.heading_3',
    'a11y.bullet_list', 'a11y.ordered_list', 'a11y.blockquote',
    'a11y.code', 'a11y.horizontal_rule'
  )
  AND locale IN ('es', 'ar', 'fr', 'de', 'ps');

DROP DOMAIN IF EXISTS markdown CASCADE;

COMMIT;
