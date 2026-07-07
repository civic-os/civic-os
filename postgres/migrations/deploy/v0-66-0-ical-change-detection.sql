-- Deploy civic_os:v0-66-0-ical-change-detection to pg
-- requires: v0-65-6-fix-entity-action-role-key

BEGIN;

-- ============================================================================
-- iCAL CHANGE-DETECTION FIELDS (LAST-MODIFIED, SEQUENCE)
-- ============================================================================
-- Adds RFC 5545 LAST-MODIFIED and SEQUENCE properties to VEVENT output,
-- plus an HTTP Last-Modified response header on the feed wrapper.
--
-- These give calendar clients (especially Google Calendar) change-detection
-- signals so they can efficiently refresh and re-render updated events.
--
-- Both new parameters are optional with backward-compatible defaults:
--   p_last_modified defaults to NULL (omitted from output)
--   p_sequence defaults to 0 (always emitted per RFC 5545 recommendation)
-- ============================================================================

-- Drop old 6-param overload before creating 8-param version.
-- CREATE OR REPLACE alone would create a second overload (different arg count),
-- causing ambiguity when callers use fewer than 6 positional args.
DROP FUNCTION IF EXISTS metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT);

-- Recreate format_ical_event with two new optional params
CREATE OR REPLACE FUNCTION metadata.format_ical_event(
  p_uid TEXT,                    -- Unique ID (e.g., 'reservation-123@civic-os.org')
  p_summary TEXT,                -- Event title
  p_dtstart TIMESTAMPTZ,         -- Start time
  p_dtend TIMESTAMPTZ,           -- End time
  p_description TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_last_modified TIMESTAMPTZ DEFAULT NULL,  -- When the source record was last changed
  p_sequence INTEGER DEFAULT 0               -- Change counter (bump on reschedule)
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

-- Drop old 2-param overload before creating 3-param version
DROP FUNCTION IF EXISTS metadata.wrap_ical_feed(TEXT, TEXT);

-- Recreate wrap_ical_feed with new optional param
CREATE OR REPLACE FUNCTION metadata.wrap_ical_feed(
  p_events TEXT,                 -- Concatenated VEVENT blocks (each ending with CRLF)
  p_calendar_name TEXT DEFAULT 'Civic OS Calendar',
  p_feed_updated_at TIMESTAMPTZ DEFAULT NULL  -- Most recent event modification time
) RETURNS "*/*"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_result TEXT;
  v_headers TEXT;
BEGIN
  -- Build response headers: always Content-Type, optionally Last-Modified
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
  -- Convert to bytea and cast to any handler domain for PostgREST
  RETURN convert_to(v_result, 'UTF8')::"*/*";
END;
$$;

COMMENT ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ) IS
  'Wrap VEVENT blocks in a VCALENDAR container. Optionally sets HTTP Last-Modified header for cache validation. Returns raw iCal with Content-Type: text/calendar for all clients.';

-- Re-grant with new signatures (CREATE OR REPLACE preserves existing grants for
-- overloads with the same arg count, but the new signatures have more args)
GRANT EXECUTE ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TIMESTAMPTZ, INTEGER) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT, TIMESTAMPTZ) TO web_anon, authenticated;

COMMIT;
