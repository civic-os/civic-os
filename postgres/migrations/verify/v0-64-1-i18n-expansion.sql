-- Verify v0-64-1-i18n-expansion

DO $$
BEGIN
  -- Verify UI translations exist for new locales
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'ps' AND source_type = 'ui') = 0 THEN
    RAISE EXCEPTION 'No Pashto UI translations found';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'fr' AND source_type = 'ui') = 0 THEN
    RAISE EXCEPTION 'No French UI translations found';
  END IF;
  IF (SELECT count(*) FROM metadata.translations WHERE locale = 'de' AND source_type = 'ui') = 0 THEN
    RAISE EXCEPTION 'No German UI translations found';
  END IF;

  -- Verify translation permission rows exist
  IF (SELECT count(*) FROM metadata.permissions WHERE table_name = 'metadata.translations') < 4 THEN
    RAISE EXCEPTION 'Expected at least 4 metadata.translations permission rows';
  END IF;

  -- Verify new RLS policies exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'metadata' AND tablename = 'translations' AND policyname = 'translations_insert'
  ) THEN
    RAISE EXCEPTION 'translations_insert policy not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'metadata' AND tablename = 'translations' AND policyname = 'translations_update'
  ) THEN
    RAISE EXCEPTION 'translations_update policy not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'metadata' AND tablename = 'translations' AND policyname = 'translations_delete'
  ) THEN
    RAISE EXCEPTION 'translations_delete policy not found';
  END IF;
END $$;
