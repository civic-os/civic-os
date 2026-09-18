-- Verify civic_os:v0-76-0-maintenance-mode
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- AGPL-3.0-or-later

DO $$
DECLARE
  v_source TEXT;
BEGIN
  -- 1. Verify function exists in metadata schema
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'check_jwt' AND n.nspname = 'metadata'
  ) THEN
    RAISE EXCEPTION 'metadata.check_jwt() function does not exist';
  END IF;

  -- 2. Verify function body contains maintenance_mode logic
  SELECT prosrc INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'check_jwt' AND n.nspname = 'metadata';

  IF v_source NOT LIKE '%maintenance_mode%' THEN
    RAISE EXCEPTION 'metadata.check_jwt() does not contain maintenance_mode logic';
  END IF;

  -- 3. Verify English translations exist
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%' AND locale = 'en') < 5 THEN
    RAISE EXCEPTION 'Expected at least 5 maintenance.* UI translations for locale en';
  END IF;

  -- 4. Verify all demo locale translations exist
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%' AND locale = 'es') < 5 THEN
    RAISE EXCEPTION 'Expected at least 5 maintenance.* UI translations for locale es';
  END IF;
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%' AND locale = 'ar') < 5 THEN
    RAISE EXCEPTION 'Expected at least 5 maintenance.* UI translations for locale ar';
  END IF;
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%' AND locale = 'fr') < 5 THEN
    RAISE EXCEPTION 'Expected at least 5 maintenance.* UI translations for locale fr';
  END IF;
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%' AND locale = 'de') < 5 THEN
    RAISE EXCEPTION 'Expected at least 5 maintenance.* UI translations for locale de';
  END IF;
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui' AND source_key LIKE 'maintenance.%' AND locale = 'ps') < 5 THEN
    RAISE EXCEPTION 'Expected at least 5 maintenance.* UI translations for locale ps';
  END IF;

  -- 5. Spot-check sentinel key
  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'maintenance.full_title' AND locale = 'en'
      AND translated_text = 'System Maintenance'
  ) THEN
    RAISE EXCEPTION 'Sentinel translation maintenance.full_title/en not found or mismatched';
  END IF;
END $$;
