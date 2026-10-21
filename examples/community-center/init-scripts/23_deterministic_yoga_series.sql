-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- 23_deterministic_yoga_series.sql
-- Community Center example: start the "Weekly Yoga Class" series at a fixed 18:00.
--
-- 14_recurring_reservations.sql creates the series with
--   p_dtstart := (NOW() + INTERVAL '1 day')::timestamp
-- that is, the database's UTC clock digits one day ahead, stored as wall-clock time in
-- the series timezone (America/New_York). So the first occurrence starts at whatever
-- time of day the stack was initialized, and after 20:00 EDT (00:00 UTC) even on the
-- day after "tomorrow" in New York. Two otherwise identical stacks then show different
-- rows in the list and calendar (the request-equivalence harness's visual self-compare,
-- tests/e2e/README.md). The series description says "evening", so this script pins it:
--
--   new dtstart = (series created_at, as a date in the series timezone) + 1 day, 18:00
--
-- The date comes from the series' own created_at read in its own timezone, not from
-- the UTC date and not from the current date. So stacks booted on either side of
-- 20:00 EDT on the same New York day agree, and running the script again (on any day)
-- computes the same target and changes nothing.
--
-- What it updates (create_recurring_series writes the group and the series and queues
-- an expand_recurring_series river job; the worker creates the instances and the
-- reservation requests later, after init):
--   metadata.time_slot_series     dtstart, and effective_from (= dtstart::DATE)
--   After expansion only (re-running on a live stack), and only for a time-of-day move:
--   reservation_requests          time_slot of each generated request, shifted by the
--                                 same delta, EXCEPT requests whose instance is a
--                                 'rescheduled' exception: those were moved to a time
--                                 someone chose, so they keep it
--   metadata.time_slot_instances  original_time_slot of 'modified' exceptions (their
--                                 time follows the series); rescheduled ones keep theirs
--   reservations                  an approved request carries a reservation, which
--                                 gets the request's new time_slot, so a request and
--                                 its reservation never disagree. The script sets it
--                                 itself: trg_sync_reservation (01_reservations_schema.sql)
--                                 is meant to do this but never does, because its
--                                 "OLD IS NOT NULL" test is false for any row with a
--                                 NULL column (a composite IS NOT NULL needs every
--                                 field non-null). Copying the request's slot stays
--                                 correct if that trigger is ever fixed.
-- A move that changes the date after expansion is refused: shifting generated requests
-- by whole days would put them on weekdays the series' RRULE does not produce.
--
-- Overlap check (before any update): the reservations table has a GIST exclusion
-- constraint (resource_id WITH =, time_slot WITH &&); reservation_requests has none.
-- The check refuses the move when the shifted slot of an approved, non-rescheduled
-- yoga request would overlap a reservation on the same resource that is not itself
-- moving (any reservation other than those of the yoga requests being shifted). That
-- is exactly the case the reservation update below would fail on with 23P01; the
-- check names it instead. Pending requests cannot conflict. At init nothing is
-- approved, so the check passes trivially.
--
-- Skips quietly when the series does not exist.

DO $$
DECLARE
  v_series RECORD;
  v_target TIMESTAMP;
  v_delta INTERVAL;
  v_shifted INT := 0;
  v_instances INT;
  v_conflicts INT;
BEGIN
  SELECT s.id, s.dtstart, s.effective_from, s.created_at, COALESCE(s.timezone, 'America/New_York') AS tz
    INTO v_series
    FROM metadata.time_slot_series s
    JOIN metadata.time_slot_series_groups g ON g.id = s.group_id
   WHERE g.display_name = 'Weekly Yoga Class'
     AND s.entity_table = 'reservation_requests'
   ORDER BY s.version_number
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE NOTICE 'Weekly Yoga Class series not found; nothing to pin';
    RETURN;
  END IF;

  v_target := ((v_series.created_at AT TIME ZONE v_series.tz)::DATE + 1) + TIME '18:00';
  v_delta := v_target - v_series.dtstart;

  IF v_delta = INTERVAL '0' AND v_series.effective_from = v_target::DATE THEN
    RAISE NOTICE 'Weekly Yoga Class series already starts at %; nothing to do', v_target;
    RETURN;
  END IF;

  SELECT count(*) INTO v_instances FROM metadata.time_slot_instances WHERE series_id = v_series.id;
  IF v_instances > 0 AND v_series.dtstart::DATE <> v_target::DATE THEN
    RAISE EXCEPTION 'Weekly Yoga Class series % is already expanded (% instances); moving it from % to % would change the date of its occurrences. Only a time-of-day move is supported after expansion.',
      v_series.id, v_instances, v_series.dtstart, v_target;
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM reservation_requests rr
    JOIN metadata.time_slot_instances i
      ON i.series_id = v_series.id AND i.entity_table = 'reservation_requests' AND i.entity_id = rr.id
    JOIN reservations r
      ON r.resource_id = rr.resource_id
     AND r.time_slot && tstzrange(lower(rr.time_slot) + v_delta, upper(rr.time_slot) + v_delta, '[)')
   WHERE rr.reservation_id IS NOT NULL
     AND i.exception_type IS DISTINCT FROM 'rescheduled'
     AND r.id NOT IN (
       SELECT rr2.reservation_id
         FROM reservation_requests rr2
         JOIN metadata.time_slot_instances i2
           ON i2.series_id = v_series.id AND i2.entity_table = 'reservation_requests' AND i2.entity_id = rr2.id
        WHERE rr2.reservation_id IS NOT NULL
          AND i2.exception_type IS DISTINCT FROM 'rescheduled');
  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Pinning Weekly Yoga Class to 18:00 would make % approved reservation(s) overlap another reservation on the same resource; choose another hour',
      v_conflicts;
  END IF;

  UPDATE metadata.time_slot_series
     SET dtstart = v_target,
         effective_from = v_target::DATE
   WHERE id = v_series.id;

  UPDATE reservation_requests rr
     SET time_slot = tstzrange(lower(rr.time_slot) + v_delta, upper(rr.time_slot) + v_delta, '[)')
    FROM metadata.time_slot_instances i
   WHERE i.series_id = v_series.id
     AND i.entity_table = 'reservation_requests'
     AND i.entity_id = rr.id
     AND i.exception_type IS DISTINCT FROM 'rescheduled';
  GET DIAGNOSTICS v_shifted = ROW_COUNT;

  UPDATE reservations r
     SET time_slot = rr.time_slot
    FROM reservation_requests rr
    JOIN metadata.time_slot_instances i
      ON i.series_id = v_series.id AND i.entity_table = 'reservation_requests' AND i.entity_id = rr.id
   WHERE r.id = rr.reservation_id
     AND i.exception_type IS DISTINCT FROM 'rescheduled'
     AND r.time_slot IS DISTINCT FROM rr.time_slot;

  UPDATE metadata.time_slot_instances
     SET original_time_slot = tstzrange(lower(original_time_slot) + v_delta, upper(original_time_slot) + v_delta, '[)')
   WHERE series_id = v_series.id
     AND original_time_slot IS NOT NULL
     AND exception_type IS DISTINCT FROM 'rescheduled';

  RAISE NOTICE 'Pinned Weekly Yoga Class series % from % to % (% %), shifted % generated request(s)',
    v_series.id, v_series.dtstart, v_target, v_delta, v_series.tz, v_shifted;
END $$;
