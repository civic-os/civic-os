-- Verify v0-67-1-a11y-translations

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'es' AND source_type = 'ui' AND source_key LIKE 'a11y.%') < 137 THEN
    RAISE EXCEPTION 'Expected at least 137 a11y.* UI translations for locale es';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'ar' AND source_type = 'ui' AND source_key LIKE 'a11y.%') < 137 THEN
    RAISE EXCEPTION 'Expected at least 137 a11y.* UI translations for locale ar';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'fr' AND source_type = 'ui' AND source_key LIKE 'a11y.%') < 137 THEN
    RAISE EXCEPTION 'Expected at least 137 a11y.* UI translations for locale fr';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'de' AND source_type = 'ui' AND source_key LIKE 'a11y.%') < 137 THEN
    RAISE EXCEPTION 'Expected at least 137 a11y.* UI translations for locale de';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'ps' AND source_type = 'ui' AND source_key LIKE 'a11y.%') < 137 THEN
    RAISE EXCEPTION 'Expected at least 137 a11y.* UI translations for locale ps';
  END IF;

  -- Spot-check a sentinel key/locale pair actually has translated (non-English) text
  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'a11y.close_dialog' AND locale = 'es'
      AND translated_text = 'Cerrar diálogo'
  ) THEN
    RAISE EXCEPTION 'Sentinel translation a11y.close_dialog/es not found or mismatched';
  END IF;
END $$;
