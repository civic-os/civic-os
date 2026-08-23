-- Revert civic_os:v0-71-0-ical-http-caching from pg

BEGIN;

-- Remove introspection registrations for the new helpers
DELETE FROM metadata.rpc_functions WHERE function_name IN ('fold_ical_line', 'ical_property');

-- Drop 4-param wrap_ical_feed before restoring the 3-param v0-66-0 version
DROP FUNCTION IF EXISTS metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ, INTERVAL);

-- Restore format_ical_event to the v0-66-0 body (same signature, NOW() DTSTAMP, no folding)
CREATE OR REPLACE FUNCTION metadata.format_ical_event(
  p_uid TEXT,
  p_summary TEXT,
  p_dtstart TIMESTAMPTZ,
  p_dtend TIMESTAMPTZ,
  p_description TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_last_modified TIMESTAMPTZ DEFAULT NULL,
  p_sequence INTEGER DEFAULT 0
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  RETURN
    'BEGIN:VEVENT' || chr(13) || chr(10) ||
    'UID:' || p_uid || chr(13) || chr(10) ||
    'DTSTAMP:' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || chr(13) || chr(10) ||
    'DTSTART:' || to_char(p_dtstart AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || chr(13) || chr(10) ||
    'DTEND:' || to_char(p_dtend AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || chr(13) || chr(10) ||
    'SUMMARY:' || metadata.escape_ical_text(p_summary) || chr(13) || chr(10) ||
    CASE WHEN p_description IS NOT NULL AND p_description != ''
      THEN 'DESCRIPTION:' || metadata.escape_ical_text(p_description) || chr(13) || chr(10)
      ELSE '' END ||
    CASE WHEN p_location IS NOT NULL AND p_location != ''
      THEN 'LOCATION:' || metadata.escape_ical_text(p_location) || chr(13) || chr(10)
      ELSE '' END ||
    CASE WHEN p_last_modified IS NOT NULL
      THEN 'LAST-MODIFIED:' || to_char(p_last_modified AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') || chr(13) || chr(10)
      ELSE '' END ||
    'SEQUENCE:' || p_sequence || chr(13) || chr(10) ||
    'END:VEVENT';
END;
$$;

COMMENT ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ, INTEGER) IS
  'Format a single VEVENT block for iCal export. Timestamps are converted to UTC. Supports LAST-MODIFIED and SEQUENCE for change detection. All text values are properly escaped per RFC 5545.';

-- Restore wrap_ical_feed to the v0-66-0 3-param version
CREATE OR REPLACE FUNCTION metadata.wrap_ical_feed(
  p_events TEXT,
  p_calendar_name TEXT DEFAULT 'Civic OS Calendar',
  p_feed_updated_at TIMESTAMPTZ DEFAULT NULL
) RETURNS "*/*"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_result TEXT;
  v_headers TEXT;
BEGIN
  IF p_feed_updated_at IS NOT NULL THEN
    v_headers := '[{"Content-Type": "text/calendar; charset=utf-8"}, {"Last-Modified": "' ||
      to_char(p_feed_updated_at AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS') || ' GMT"}]';
  ELSE
    v_headers := '[{"Content-Type": "text/calendar; charset=utf-8"}]';
  END IF;

  PERFORM set_config('response.headers', v_headers, true);

  v_result :=
    'BEGIN:VCALENDAR' || chr(13) || chr(10) ||
    'VERSION:2.0' || chr(13) || chr(10) ||
    'PRODID:-//Civic OS//Calendar Feed//EN' || chr(13) || chr(10) ||
    'X-WR-CALNAME:' || metadata.escape_ical_text(p_calendar_name) || chr(13) || chr(10) ||
    'METHOD:PUBLISH' || chr(13) || chr(10) ||
    COALESCE(p_events, '') ||
    'END:VCALENDAR';
  RETURN convert_to(v_result, 'UTF8')::"*/*";
END;
$$;

COMMENT ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ) IS
  'Wrap VEVENT blocks in a VCALENDAR container. Optionally sets HTTP Last-Modified header for cache validation. Returns raw iCal with Content-Type: text/calendar for all clients.';

GRANT EXECUTE ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ, INTEGER) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ) TO web_anon, authenticated;

-- Drop the new helpers last (format_ical_event no longer references them)
DROP FUNCTION IF EXISTS metadata.ical_property(TEXT, TEXT);
DROP FUNCTION IF EXISTS metadata.fold_ical_line(TEXT);

COMMIT;
