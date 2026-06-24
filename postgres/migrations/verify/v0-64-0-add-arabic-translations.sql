-- Verify v0-64-0-add-arabic-translations

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'ar' AND source_type = 'ui') = 0 THEN
    RAISE EXCEPTION 'No Arabic UI translations found';
  END IF;
END $$;
