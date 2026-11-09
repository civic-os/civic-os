-- Verify civic_os:v0-81-4-map-center-translations

DO $$
BEGIN
  -- Existence only: an integrator may have customized the text
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN ('a11y.use_map_center', 'a11y.map_location_set', 'a11y.map_keyboard_instructions')
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 18 THEN
    RAISE EXCEPTION 'Expected 3 keys x 6 locales (18 rows)';
  END IF;
END $$;
