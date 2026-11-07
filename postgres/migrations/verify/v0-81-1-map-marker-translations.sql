-- Verify civic_os:v0-81-1-map-marker-translations

DO $$
BEGIN
  -- Existence only: an integrator may have customized the text
  IF (SELECT COUNT(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN ('a11y.map_location_marker', 'a11y.map_drag_marker')
        AND locale IN ('en', 'es', 'fr', 'de', 'ar', 'ps')) <> 12 THEN
    RAISE EXCEPTION 'Expected 2 keys x 6 locales (12 rows)';
  END IF;
END $$;
