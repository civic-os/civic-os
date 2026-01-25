-- ============================================================================
-- MOTT PARK - iCAL FEED FOR PUBLIC EVENTS
-- ============================================================================
-- Provides a subscribable iCal feed for the public calendar.
-- Users can subscribe in Google Calendar, Apple Calendar, Outlook, etc.
--
-- URL: https://api.mottpark.org/rpc/public_events_ical_feed
-- Optional params: ?p_start_date=2024-01-01&p_end_date=2024-12-31 (date range)
--
-- Privacy: Private events show "Private Event" with no details.
--          Public events show organization name and event type.
--
-- Requires: Civic OS v0.27.0+ (iCal helper functions)
-- ============================================================================

BEGIN;

-- ============================================================================
-- PUBLIC EVENTS iCAL FEED
-- ============================================================================
-- Generates an iCal subscription feed from public_calendar_events.
-- Returns the "*/*" (any media type handler) domain for universal compatibility.
-- Content-Type is set to text/calendar via response.headers GUC.

CREATE OR REPLACE FUNCTION public.public_events_ical_feed(
  p_start_date DATE DEFAULT (CURRENT_DATE - interval '30 days')::date,
  p_end_date DATE DEFAULT (CURRENT_DATE + interval '1 year')::date
) RETURNS "*/*"
LANGUAGE plpgsql
SECURITY INVOKER  -- Respects RLS policies
AS $$
DECLARE
  v_events TEXT := '';
  v_event RECORD;
BEGIN
  -- Loop through public calendar events within the date range
  FOR v_event IN
    SELECT
      e.id,
      e.display_name,                           -- Already privacy-aware from sync trigger
      lower(e.time_slot) as start_time,         -- Extract start from range
      upper(e.time_slot) as end_time,           -- Extract end from range
      e.event_type,                             -- "Private Event" for private events
      e.organization_name,                      -- NULL for private events
      e.is_public_event
    FROM public_calendar_events e
    WHERE e.time_slot && tstzrange(
      p_start_date::timestamptz,
      p_end_date::timestamptz
    )
    ORDER BY lower(e.time_slot)
  LOOP
    -- Build VEVENT for each calendar event using core helper
    -- Description shows organization and type for public events, nothing for private
    v_events := v_events || metadata.format_ical_event(
      p_uid := 'mpra-event-' || v_event.id || '@mottpark.org',
      p_summary := v_event.display_name,
      p_dtstart := v_event.start_time,
      p_dtend := v_event.end_time,
      p_description := CASE
        WHEN v_event.is_public_event AND v_event.organization_name IS NOT NULL
        THEN 'Hosted by: ' || v_event.organization_name || E'\nType: ' || v_event.event_type
        WHEN v_event.is_public_event
        THEN 'Type: ' || v_event.event_type
        ELSE NULL  -- No description for private events
      END,
      p_location := 'Mott Park Recreation Area Pavilion'
    ) || chr(13) || chr(10);
  END LOOP;

  -- Wrap events in VCALENDAR container
  RETURN metadata.wrap_ical_feed(v_events, 'Mott Park Public Events');
END;
$$;

COMMENT ON FUNCTION public.public_events_ical_feed(DATE, DATE) IS
  'Generate iCal subscription feed for Mott Park public calendar events.
   Subscribe via Google Calendar, Apple Calendar, Outlook, etc.
   Private events show "Private Event" with no details.';

-- Grant to web_anon for anonymous subscription access
-- Users can subscribe without authentication
GRANT EXECUTE ON FUNCTION public.public_events_ical_feed(DATE, DATE) TO web_anon;
GRANT EXECUTE ON FUNCTION public.public_events_ical_feed(DATE, DATE) TO authenticated;

-- Register for introspection
SELECT metadata.auto_register_function(
  'public_events_ical_feed',
  'public',
  'Generate iCal subscription feed for Mott Park public calendar events',
  'Calendar Feeds'
);

COMMIT;

-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================

/*
-- Test the feed via psql:
SELECT public.public_events_ical_feed();

-- Test with date range:
SELECT public.public_events_ical_feed(
  p_start_date := '2024-01-01'::date,
  p_end_date := '2024-12-31'::date
);

-- Test via curl (PostgREST) - no Accept header needed:
curl "http://localhost:3000/rpc/public_events_ical_feed"

-- With date range:
curl "http://localhost:3000/rpc/public_events_ical_feed?p_start_date=2024-01-01&p_end_date=2024-12-31"

-- Subscribe in calendar app:
-- Add calendar -> From URL -> paste:
-- https://api.mottpark.org/rpc/public_events_ical_feed
--
-- Note: The any media type handler domain responds to ALL Accept headers.
-- Content-Type is set to "text/calendar; charset=utf-8" via response.headers GUC.
-- This ensures universal compatibility with all calendar applications.
*/
