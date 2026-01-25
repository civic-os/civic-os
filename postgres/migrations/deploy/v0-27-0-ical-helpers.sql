-- Deploy civic_os:v0-27-0-ical-helpers to pg
-- requires: v0-26-0-impersonation

BEGIN;

-- ============================================================================
-- iCAL EXPORT HELPERS
-- ============================================================================
-- RFC 5545 compliant iCalendar feed generation helpers.
-- Enables integrators to expose calendar subscription URLs for any entity
-- with time-based data (appointments, reservations, events, etc.)
--
-- Design Decision: Instance-only export (not RRULE + exceptions)
-- Since Civic OS materializes recurring schedules into entity records,
-- we export each instance as a separate VEVENT rather than using RRULE.
-- This provides maximum compatibility with all calendar applications.
--
-- Usage Pattern:
-- 1. Use format_ical_event() to create VEVENT blocks for each record
-- 2. Concatenate all VEVENT blocks
-- 3. Wrap with wrap_ical_feed() to create complete VCALENDAR
-- 4. Return the result as "text/calendar" type from your RPC
--
-- PostgREST Integration:
-- The "text/calendar" domain enables PostgREST's Media Type Handler feature.
-- When clients send Accept: text/calendar, PostgREST returns raw content
-- with Content-Type: text/calendar (no JSON encoding).
-- ============================================================================

-- Create "any" media type handler domain for PostgREST
-- The "*/*" domain acts as a catch-all handler that responds to ALL Accept headers
-- (including requests without Accept header). This ensures calendar apps work
-- regardless of what headers they send.
CREATE DOMAIN "*/*" AS bytea;

COMMENT ON DOMAIN "*/*" IS
  'Any media type handler for PostgREST. Functions returning this type respond to all Accept headers. Content-Type is set via response.headers GUC.';

-- Helper for RFC 5545 text escaping
-- Escapes special characters that have meaning in iCal format
CREATE OR REPLACE FUNCTION metadata.escape_ical_text(p_text TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT replace(replace(replace(replace(
    COALESCE(p_text, ''),
    '\', '\\'),   -- Escape backslashes first
    ';', '\;'),   -- Escape semicolons
    ',', '\,'),   -- Escape commas
    E'\n', '\n')  -- Escape literal newlines (converted to iCal format)
$$;

COMMENT ON FUNCTION metadata.escape_ical_text(TEXT) IS
  'Escape special characters for iCal text values per RFC 5545. Handles backslashes, semicolons, commas, and newlines.';

-- Format a single VEVENT block
-- All timestamps are converted to UTC with Z suffix for maximum compatibility
CREATE OR REPLACE FUNCTION metadata.format_ical_event(
  p_uid TEXT,                    -- Unique ID (e.g., 'reservation-123@civic-os.org')
  p_summary TEXT,                -- Event title
  p_dtstart TIMESTAMPTZ,         -- Start time
  p_dtend TIMESTAMPTZ,           -- End time
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

-- Wrap VEVENT blocks in a VCALENDAR container
-- Returns "*/*" domain for PostgREST "any" media type handling
-- Works with ALL calendar clients regardless of Accept header
CREATE OR REPLACE FUNCTION metadata.wrap_ical_feed(
  p_events TEXT,                 -- Concatenated VEVENT blocks (each ending with CRLF)
  p_calendar_name TEXT DEFAULT 'Civic OS Calendar'
) RETURNS "*/*"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_result TEXT;
BEGIN
  -- Set Content-Type header (required since "*/*" defaults to application/octet-stream)
  PERFORM set_config('response.headers', '[{"Content-Type": "text/calendar; charset=utf-8"}]', true);

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

COMMENT ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT) IS
  'Wrap VEVENT blocks in a VCALENDAR container. Returns raw iCal with Content-Type: text/calendar for all clients.';

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION metadata.escape_ical_text(TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.format_ical_event(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.wrap_ical_feed(TEXT, TEXT) TO web_anon, authenticated;

-- Register functions for introspection
SELECT metadata.auto_register_function(
  'escape_ical_text',
  'metadata',
  'Escape special characters for iCal text values per RFC 5545',
  'iCal Export'
);

SELECT metadata.auto_register_function(
  'format_ical_event',
  'metadata',
  'Format a single VEVENT block for iCal export with RFC 5545 compliance',
  'iCal Export'
);

SELECT metadata.auto_register_function(
  'wrap_ical_feed',
  'metadata',
  'Wrap VEVENT blocks in a VCALENDAR container for complete iCal feed',
  'iCal Export'
);

COMMIT;
