-- Verify civic_os:v0-27-0-ical-helpers on pg

BEGIN;

-- Verify */* domain exists (any media type handler)
SELECT 1/COUNT(*) FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
WHERE n.nspname = 'public' AND t.typname = '*/*';

-- Verify escape_ical_text function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'escape_ical_text';

-- Verify format_ical_event function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'format_ical_event';

-- Verify wrap_ical_feed function exists
SELECT 1/COUNT(*) FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'wrap_ical_feed';

-- Verify escape_ical_text works correctly
SELECT 1/(CASE WHEN metadata.escape_ical_text('test,with;special\chars') = 'test\,with\;special\\chars' THEN 1 ELSE 0 END);

-- Verify format_ical_event returns VEVENT structure
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-1@civic-os.org',
  'Test Event',
  '2024-01-15 10:00:00+00'::timestamptz,
  '2024-01-15 11:00:00+00'::timestamptz
) LIKE 'BEGIN:VEVENT%END:VEVENT' THEN 1 ELSE 0 END);

-- Verify wrap_ical_feed function's declared return type is the */* domain
-- (checks function signature in pg_proc rather than pg_typeof which returns base type)
SELECT 1/COUNT(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
JOIN pg_type t ON p.prorettype = t.oid
WHERE n.nspname = 'metadata'
  AND p.proname = 'wrap_ical_feed'
  AND t.typname = '*/*';

-- Verify wrap_ical_feed is callable and returns data
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'Test Calendar')) > 0 THEN 1 ELSE 0 END);

ROLLBACK;
