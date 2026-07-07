-- Verify civic_os:v0-66-0-ical-change-detection on pg

BEGIN;

-- Verify format_ical_event has 8 parameters (uid, summary, dtstart, dtend, description, location, last_modified, sequence)
SELECT 1/(CASE WHEN pronargs = 8 THEN 1 ELSE 0 END)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'format_ical_event'
  AND pronargs = 8;

-- Verify wrap_ical_feed has 3 parameters (events, calendar_name, feed_updated_at)
SELECT 1/(CASE WHEN pronargs = 3 THEN 1 ELSE 0 END)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata' AND p.proname = 'wrap_ical_feed'
  AND pronargs = 3;

-- Verify backward compat: calling with original 4 required args still works
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-1@civic-os.org',
  'Test Event',
  '2024-01-15 10:00:00+00'::timestamptz,
  '2024-01-15 11:00:00+00'::timestamptz
) LIKE '%BEGIN:VEVENT%SEQUENCE:0%END:VEVENT' THEN 1 ELSE 0 END);

-- Verify LAST-MODIFIED is emitted when p_last_modified is provided
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-2@civic-os.org',
  'Modified Event',
  '2024-01-15 10:00:00+00'::timestamptz,
  '2024-01-15 11:00:00+00'::timestamptz,
  p_last_modified := '2024-06-01 12:00:00+00'::timestamptz
) LIKE '%LAST-MODIFIED:20240601T120000Z%' THEN 1 ELSE 0 END);

-- Verify LAST-MODIFIED is omitted when p_last_modified is NULL
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-3@civic-os.org',
  'No Modified',
  '2024-01-15 10:00:00+00'::timestamptz,
  '2024-01-15 11:00:00+00'::timestamptz
) NOT LIKE '%LAST-MODIFIED%' THEN 1 ELSE 0 END);

-- Verify SEQUENCE is present with custom value
SELECT 1/(CASE WHEN metadata.format_ical_event(
  'test-4@civic-os.org',
  'Rescheduled',
  '2024-01-15 10:00:00+00'::timestamptz,
  '2024-01-15 11:00:00+00'::timestamptz,
  p_sequence := 3
) LIKE '%SEQUENCE:3%' THEN 1 ELSE 0 END);

-- Verify wrap_ical_feed still works with 2 args (backward compat)
SELECT 1/(CASE WHEN length(metadata.wrap_ical_feed('', 'Test Calendar')) > 0 THEN 1 ELSE 0 END);

ROLLBACK;
