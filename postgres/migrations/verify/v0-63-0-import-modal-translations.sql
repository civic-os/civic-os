-- Verify civic_os:v0-63-0-import-modal-translations on pg

BEGIN;

-- Verify import_modal translations exist for both locales
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM metadata.translations
  WHERE source_type = 'ui'
    AND source_key LIKE 'import_modal.%';

  IF v_count < 2 THEN
    RAISE EXCEPTION 'Expected import_modal translations, found %', v_count;
  END IF;
END $$;

ROLLBACK;
