-- Verify civic_os:v0-65-1-auth-route-translations on pg

BEGIN;

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM metadata.translations
  WHERE source_type = 'ui'
    AND source_key = 'nav.redirecting';

  IF v_count < 1 THEN
    RAISE EXCEPTION 'Expected nav.redirecting translations, found %', v_count;
  END IF;
END $$;

ROLLBACK;
