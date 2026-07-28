-- Verify v0-69-0-pwa-translations

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'es' AND source_type = 'ui' AND source_key LIKE 'pwa.%') < 7 THEN
    RAISE EXCEPTION 'Expected at least 7 pwa.* UI translations for locale es';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'ar' AND source_type = 'ui' AND source_key LIKE 'pwa.%') < 7 THEN
    RAISE EXCEPTION 'Expected at least 7 pwa.* UI translations for locale ar';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'fr' AND source_type = 'ui' AND source_key LIKE 'pwa.%') < 7 THEN
    RAISE EXCEPTION 'Expected at least 7 pwa.* UI translations for locale fr';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'de' AND source_type = 'ui' AND source_key LIKE 'pwa.%') < 7 THEN
    RAISE EXCEPTION 'Expected at least 7 pwa.* UI translations for locale de';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'ps' AND source_type = 'ui' AND source_key LIKE 'pwa.%') < 7 THEN
    RAISE EXCEPTION 'Expected at least 7 pwa.* UI translations for locale ps';
  END IF;

  -- Spot-check a sentinel key/locale pair
  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'pwa.install_action' AND locale = 'es'
      AND translated_text = 'Instalar'
  ) THEN
    RAISE EXCEPTION 'Sentinel translation pwa.install_action/es not found or mismatched';
  END IF;
END $$;
