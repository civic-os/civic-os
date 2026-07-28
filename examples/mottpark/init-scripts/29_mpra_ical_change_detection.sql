-- ============================================================================
-- MOTT PARK - iCAL CHANGE-DETECTION FIELDS
-- ============================================================================
-- Updates public_events_ical_feed to pass LAST-MODIFIED and SEQUENCE fields
-- to the v0.66.0 framework helpers, giving Google Calendar and other clients
-- change-detection signals for efficient refresh scheduling.
--
-- Requires: Civic OS v0.66.0+ (iCal change-detection migration)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.public_events_ical_feed(
  p_start_date DATE DEFAULT (CURRENT_DATE - interval '30 days')::date,
  p_end_date DATE DEFAULT (CURRENT_DATE + interval '1 year')::date
) RETURNS "*/*"
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_events TEXT := '';
  v_event RECORD;
  v_max_updated_at TIMESTAMPTZ := NULL;
BEGIN
  FOR v_event IN
    SELECT
      e.id,
      e.display_name,
      lower(e.time_slot) as start_time,
      upper(e.time_slot) as end_time,
      e.event_type,
      e.organization_name,
      e.is_public_event,
      e.synced_at
    FROM public_calendar_events e
    WHERE e.time_slot && tstzrange(
      p_start_date::timestamptz,
      p_end_date::timestamptz
    )
    ORDER BY lower(e.time_slot)
  LOOP
    IF v_max_updated_at IS NULL OR v_event.synced_at > v_max_updated_at THEN
      v_max_updated_at := v_event.synced_at;
    END IF;

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
        ELSE NULL
      END,
      p_location := 'Mott Park Recreation Area Pavilion',
      p_last_modified := v_event.synced_at
    ) || chr(13) || chr(10);
  END LOOP;

  RETURN metadata.wrap_ical_feed(v_events, 'Mott Park Public Events', v_max_updated_at);
END;
$$;
