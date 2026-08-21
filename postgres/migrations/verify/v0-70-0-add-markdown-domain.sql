-- Verify civic_os:v0-70-0-add-markdown-domain on pg

BEGIN;

SELECT 1/COUNT(*) FROM pg_type WHERE typname = 'markdown';

-- Verify at least one locale has all 12 markdown a11y translations
DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations
      WHERE locale = 'es' AND source_type = 'ui'
        AND source_key IN (
          'a11y.markdown_toolbar', 'a11y.bold', 'a11y.italic', 'a11y.strikethrough',
          'a11y.heading_1', 'a11y.heading_2', 'a11y.heading_3',
          'a11y.bullet_list', 'a11y.ordered_list', 'a11y.blockquote',
          'a11y.code', 'a11y.horizontal_rule'
        )) < 12 THEN
    RAISE EXCEPTION 'Expected 12 markdown a11y translations for locale es';
  END IF;
END $$;

ROLLBACK;
