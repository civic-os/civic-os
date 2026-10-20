-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- 21_deterministic_yoga_series.sql
-- Community Center example: start the "Weekly Yoga Class" series at a fixed 18:00.
--
-- 14_recurring_reservations.sql creates the series with
--   p_dtstart := (NOW() + INTERVAL '1 day')::timestamp
-- so its first occurrence starts at whatever time of day the stack was initialized
-- (the UTC clock digits, read as America/New_York wall time). Every occurrence then
-- shows a different time on each fresh stack, which makes the list and calendar of
-- two otherwise identical stacks differ (the request-equivalence harness's visual
-- self-compare, tests/e2e/README.md). The series description says "evening", so this
-- script pins the start to 18:00 on the same day: (CURRENT_DATE + 1) at 18:00 local
-- time at init, since script 14 ran moments earlier on the same UTC date.
--
-- What it touches (everything create_recurring_series and the expansion worker write
-- for the series):
--   metadata.time_slot_series     dtstart (wall-clock TIMESTAMP in the series timezone);
--                                 effective_from (= dtstart::DATE) is unchanged because
--                                 only the time of day moves
--   reservation_requests          time_slot of every generated request, shifted by the
--                                 same delta (none exist at init: expansion is a queued
--                                 river job that the worker runs after init)
--   metadata.time_slot_instances  original_time_slot of exception rows, same delta;
--                                 occurrence_date is unchanged (same day)
-- The queued expand_recurring_series job reads dtstart when it runs, so it expands the
-- pinned schedule.
--
-- Conflicts: reservation_requests has no exclusion constraint (only reservations does),
-- and at init no yoga request has been approved into a reservation, so the move cannot
-- conflict. Checked anyway: the script raises if an approved reservation would overlap.
--
-- Idempotent: the target keeps the series' own date and only sets the time of day, so a
-- second run (on any day) computes a zero delta and changes nothing. Skips quietly when
-- the series does not exist.

DO $$
DECLARE
  v_series RECORD;
  v_target TIMESTAMP;
  v_delta INTERVAL;
  v_requests INT := 0;
  v_conflicts INT;
BEGIN
  SELECT s.id, s.dtstart, s.timezone
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

  v_target := v_series.dtstart::DATE + TIME '18:00';
  v_delta := v_target - v_series.dtstart;

  IF v_delta = INTERVAL '0' THEN
    RAISE NOTICE 'Weekly Yoga Class series already starts at %; nothing to do', v_target;
    RETURN;
  END IF;

  -- Approved reservations are the only rows with an exclusion constraint.
  SELECT count(*) INTO v_conflicts
    FROM reservations r
    JOIN reservation_requests rr ON rr.resource_id = r.resource_id
    JOIN metadata.time_slot_instances i
      ON i.series_id = v_series.id AND i.entity_table = 'reservation_requests' AND i.entity_id = rr.id
   WHERE r.time_slot && tstzrange(lower(rr.time_slot) + v_delta, upper(rr.time_slot) + v_delta, '[)')
     AND r.id IS DISTINCT FROM rr.reservation_id;
  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Pinning Weekly Yoga Class to 18:00 would overlap % approved reservation(s); choose another hour', v_conflicts;
  END IF;

  UPDATE metadata.time_slot_series
     SET dtstart = v_target
   WHERE id = v_series.id;

  UPDATE reservation_requests rr
     SET time_slot = tstzrange(lower(rr.time_slot) + v_delta, upper(rr.time_slot) + v_delta, '[)')
    FROM metadata.time_slot_instances i
   WHERE i.series_id = v_series.id
     AND i.entity_table = 'reservation_requests'
     AND i.entity_id = rr.id;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  UPDATE metadata.time_slot_instances
     SET original_time_slot = tstzrange(lower(original_time_slot) + v_delta, upper(original_time_slot) + v_delta, '[)')
   WHERE series_id = v_series.id
     AND original_time_slot IS NOT NULL;

  RAISE NOTICE 'Pinned Weekly Yoga Class series % from % to % (% %), shifted % generated request(s)',
    v_series.id, v_series.dtstart, v_target, v_delta, v_series.timezone, v_requests;
END $$;
