-- ============================================================================
-- iCAL FEED EXAMPLE FOR COMMUNITY CENTER
-- ============================================================================
-- Demonstrates how to create a public iCal subscription feed for reservations.
-- This allows users to subscribe in Google Calendar, Apple Calendar, Outlook, etc.
--
-- URL: https://api.example.com/rpc/public_events_ical_feed
-- Optional params: ?p_resource_id=5 (filter by resource)
--                  ?p_start_date=2024-01-01&p_end_date=2024-12-31 (date range)
--
-- Requires: Civic OS v0.27.0+ (iCal helper functions)
-- ============================================================================

-- Public events iCal feed for community center reservations
-- SECURITY INVOKER ensures RLS policies are respected
-- Returns "*/*" (any media type handler) for universal calendar client compatibility
-- Content-Type header is set by wrap_ical_feed() via PostgREST response.headers GUC
CREATE OR REPLACE FUNCTION public.public_events_ical_feed(
  p_resource_id BIGINT DEFAULT NULL,  -- Optional filter by resource
  p_start_date DATE DEFAULT (CURRENT_DATE - interval '30 days')::date,
  p_end_date DATE DEFAULT (CURRENT_DATE + interval '1 year')::date
) RETURNS "*/*"
LANGUAGE plpgsql
SECURITY INVOKER  -- Respects RLS, runs as caller's role
AS $$
DECLARE
  v_events TEXT := '';
  v_event RECORD;
BEGIN
  -- Loop through approved reservations within the date range
  FOR v_event IN
    SELECT
      r.id,
      r.purpose,                           -- Use purpose as event title
      lower(r.time_slot) as start_time,    -- Extract start from range
      upper(r.time_slot) as end_time,      -- Extract end from range
      r.notes as description,
      res.display_name as location         -- Resource name as location
    FROM reservations r
    LEFT JOIN resources res ON r.resource_id = res.id
    WHERE r.time_slot && tstzrange(
      p_start_date::timestamptz,
      p_end_date::timestamptz
    )
      AND (p_resource_id IS NULL OR r.resource_id = p_resource_id)
    ORDER BY lower(r.time_slot)
  LOOP
    -- Build VEVENT for each reservation using core helper
    v_events := v_events || metadata.format_ical_event(
      p_uid := 'reservation-' || v_event.id || '@civic-os.org',
      p_summary := v_event.purpose,
      p_dtstart := v_event.start_time,
      p_dtend := v_event.end_time,
      p_description := v_event.description,
      p_location := v_event.location
    ) || chr(13) || chr(10);
  END LOOP;

  -- Wrap events in VCALENDAR container
  RETURN metadata.wrap_ical_feed(v_events, 'Community Center Events');
END;
$$;

COMMENT ON FUNCTION public.public_events_ical_feed(BIGINT, DATE, DATE) IS
  'Generate iCal feed for community center reservations. Subscribable via calendar apps (Google, Apple, Outlook).';

-- Grant to web_anon for anonymous subscription access
-- Users can subscribe without authentication
GRANT EXECUTE ON FUNCTION public.public_events_ical_feed(BIGINT, DATE, DATE) TO web_anon;
GRANT EXECUTE ON FUNCTION public.public_events_ical_feed(BIGINT, DATE, DATE) TO authenticated;

-- Register for introspection
SELECT metadata.auto_register_function(
  'public_events_ical_feed',
  'public',
  'Generate iCal subscription feed for community center reservations',
  'Calendar Feeds'
);

-- ============================================================================
-- OPTIONAL: Per-resource iCal feeds
-- ============================================================================
-- If you want each resource (room) to have its own dedicated feed URL,
-- you can create resource-specific wrapper functions:

/*
-- Example: Dedicated feed for Club House only
CREATE OR REPLACE FUNCTION public.clubhouse_ical_feed()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT public.public_events_ical_feed(
    p_resource_id := (SELECT id FROM resources WHERE display_name = 'Club House'),
    p_start_date := (CURRENT_DATE - interval '30 days')::date,
    p_end_date := (CURRENT_DATE + interval '1 year')::date
  )
$$;

GRANT EXECUTE ON FUNCTION public.clubhouse_ical_feed() TO web_anon, authenticated;
*/

-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================

/*
-- Test the feed via psql:
SELECT public.public_events_ical_feed();

-- Test with resource filter:
SELECT public.public_events_ical_feed(p_resource_id := 1);

-- Test via curl (PostgREST) - no Accept header needed, works with any client:
curl "http://localhost:3000/rpc/public_events_ical_feed"

-- With resource filter:
curl "http://localhost:3000/rpc/public_events_ical_feed?p_resource_id=1"

-- With date range:
curl "http://localhost:3000/rpc/public_events_ical_feed?p_start_date=2024-01-01&p_end_date=2024-12-31"

-- Subscribe in calendar app:
-- Add calendar → From URL → paste:
-- https://api.yourdomain.com/rpc/public_events_ical_feed
--
-- Note: The any media type handler domain responds to ALL Accept headers (or none).
-- Content-Type is set to "text/calendar; charset=utf-8" via response.headers GUC.
-- This ensures universal compatibility with all calendar applications.
*/
