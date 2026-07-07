-- Revert civic_os:v0-66-0-ical-change-detection from pg

BEGIN;

-- Drop 8-param overload before restoring 6-param original
DROP FUNCTION IF EXISTS metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ, INTEGER);

-- Restore format_ical_event to original 6-param signature
CREATE OR REPLACE FUNCTION metadata.format_ical_event(
  p_uid TEXT,
  p_summary TEXT,
  p_dtstart TIMESTAMPTZ,
  p_dtend TIMESTAMPTZ,
  p_description TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL
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
    'END:VEVENT';
END;
$$;

COMMENT ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) IS
  'Format a single VEVENT block for iCal export. Timestamps are converted to UTC. All text values are properly escaped per RFC 5545.';

-- Drop 3-param overload before restoring 2-param original
DROP FUNCTION IF EXISTS metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ);

-- Restore wrap_ical_feed to original 2-param signature
CREATE OR REPLACE FUNCTION metadata.wrap_ical_feed(
  p_events TEXT,
  p_calendar_name TEXT DEFAULT 'Civic OS Calendar'
) RETURNS "*/*"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_result TEXT;
BEGIN
  PERFORM set_config('response.headers', '[{"Content-Type": "text/calendar; charset=utf-8"}]', true);

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

COMMENT ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT) IS
  'Wrap VEVENT blocks in a VCALENDAR container. Returns raw iCal with Content-Type: text/calendar for all clients.';

-- Re-grant original signatures
GRANT EXECUTE ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT) TO web_anon, authenticated;

COMMIT;
