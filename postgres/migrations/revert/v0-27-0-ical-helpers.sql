-- Revert civic_os:v0-27-0-ical-helpers from pg

BEGIN;

-- Remove function registrations from introspection (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'metadata' AND table_name = 'functions') THEN
    DELETE FROM metadata.functions
    WHERE function_name IN ('escape_ical_text', 'format_ical_event', 'wrap_ical_feed')
      AND schema_name = 'metadata';
  END IF;
END;
$$;

-- Drop functions in reverse dependency order
DROP FUNCTION IF EXISTS metadata.wrap_ical_feed(TEXT, TEXT);
DROP FUNCTION IF EXISTS metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT);
DROP FUNCTION IF EXISTS metadata.escape_ical_text(TEXT);

-- Drop media type domain
DROP DOMAIN IF EXISTS "*/*";

COMMIT;
