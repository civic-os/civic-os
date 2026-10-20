-- Verify civic_os:v0-76-6-markdown-editor-a11y-translation
--
-- Row existence only: integrators may edit the text in /admin/translations.

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN ('a11y.markdown_editor', 'error.series_split_failed')
        AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps')) <> 12 THEN
    RAISE EXCEPTION 'Expected a11y.markdown_editor and error.series_split_failed for en/es/ar/fr/de/ps';
  END IF;
END $$;
