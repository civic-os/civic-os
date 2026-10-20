-- Verify civic_os:v0-76-6-markdown-editor-a11y-translation

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key = 'a11y.markdown_editor'
        AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps')) <> 6 THEN
    RAISE EXCEPTION 'Expected a11y.markdown_editor translations for en/es/ar/fr/de/ps';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'a11y.markdown_editor' AND locale = 'es'
      AND translated_text = 'Editor de Markdown'
  ) THEN
    RAISE EXCEPTION 'Sentinel translation a11y.markdown_editor/es not found or mismatched';
  END IF;
END $$;
