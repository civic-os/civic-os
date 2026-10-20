-- Deploy civic_os:v0-76-9-occurrence-date-local
-- Requires: v0-76-8-payment-checkout-translations
--
-- v0.76.9 -- Recurring occurrence dates are LOCAL dates; restore the split re-link.
--
-- 1. metadata.time_slot_instances.occurrence_date was written by the expansion worker
--    as the occurrence's UTC date. An evening occurrence west of UTC (or a morning one
--    east of it) carried the neighbouring day, and where two occurrences shared a UTC
--    date around a DST change the second one's booking was inserted without an
--    instance row (orphaned). occurrence_date is compared with split dates, UNTIL and
--    "today" as a calendar date in the series timezone, so it must be the local date.
--    The worker now writes local dates (consolidated-worker-go occurrenceDate()); this
--    migration rewrites existing rows (see pg_temp.occ_resolve() below for the rule:
--    the booking's own start where it is still on the stored UTC day, otherwise the
--    schedule of the row's version or of earlier versions of its group, with ties
--    broken by the RRULE's days and then by the earliest date), re-links orphaned
--    bookings that match exactly one unlinked record, and aborts instead of guessing
--    when two rows would collide. A column comment marks the rows as converted, so a
--    second run is a no-op.
--
--    UPGRADE NOTE: stop the consolidated worker (or enable MAINTENANCE_MODE, which
--    pauses workers) while this migration runs, and start the v0.76.9 worker after
--    it. An old worker expanding during or after the repair writes UTC-keyed rows
--    next to the converted ones and books occurrences twice.
--
--    Split boundaries are moved with the dates: a version split before this release
--    ended on (UTC split date - 1), which can now include the local split day, and
--    its UNTIL would let it expand the split occurrence again; it now ends the day
--    before its successor's first occurrence (effective_until, UNTIL, and the
--    successor's effective_from).
--
-- 2. split_series_from_date(): restore the re-link of the original version's
--    instances on/after the split date (present since v0.38.5, dropped by the v0.76.5
--    security rewrite). Authorization guards from v0.76.5 are unchanged.
--
-- 3. metadata.series_groups_summary.current_version gains "timezone", so the series
--    page compares occurrence dates with today's date in the series timezone.
--
-- Framework-managed rows only (time_slot_instances is written by the worker, never
-- customized by integrators); no instance content is touched.

BEGIN;

-- ============================================================================
-- 1. Rewrite occurrence_date from UTC date to series-local date
-- ============================================================================
-- Helpers live in pg_temp: they exist only for this migration session.

-- Same fallback as the worker: unset or unknown timezone means UTC
CREATE FUNCTION pg_temp.occ_tz(p_tz text) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN p_tz IN (SELECT name FROM pg_timezone_names) THEN p_tz ELSE 'UTC' END
$$;

-- UTC date of the wall-clock time (d + t) in tz, resolved like the worker (AT TIME ZONE)
CREATE FUNCTION pg_temp.occ_utc_date(d date, t time, tz text) RETURNS date LANGUAGE sql IMMUTABLE AS $$
    SELECT (((d + t) AT TIME ZONE tz) AT TIME ZONE 'UTC')::date
$$;

-- Could the RRULE produce an occurrence on day d? Checks the day-level parts only
-- (BYDAY weekdays, BYMONTHDAY, or the dtstart anchor of WEEKLY/MONTHLY/YEARLY rules
-- without them); used to break ties between neighbouring candidate dates.
CREATE FUNCTION pg_temp.occ_rrule_allows(p_rrule text, p_dtstart timestamp, d date) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_byday text := substring(p_rrule FROM '(?i)(?:^|;)BYDAY=([^;]+)');
    v_bymonthday text := substring(p_rrule FROM '(?i)(?:^|;)BYMONTHDAY=([^;]+)');
    v_freq text := upper(substring(p_rrule FROM '(?i)(?:^|;)FREQ=([A-Z]+)'));
    v_codes text[] := ARRAY['MO','TU','WE','TH','FR','SA','SU'];
BEGIN
    IF v_byday IS NOT NULL THEN
        RETURN v_codes[extract(isodow FROM d)::int] = ANY (
            SELECT upper(right(trim(x), 2)) FROM unnest(string_to_array(v_byday, ',')) x);
    END IF;
    IF v_bymonthday IS NOT NULL THEN
        RETURN extract(day FROM d)::int = ANY (
            SELECT trim(x)::int FROM unnest(string_to_array(v_bymonthday, ',')) x WHERE trim(x) ~ '^\d+$')
            OR v_bymonthday ~ '-';  -- negative month days: cannot tell, do not exclude
    END IF;
    RETURN CASE v_freq
        WHEN 'WEEKLY'  THEN extract(isodow FROM d) = extract(isodow FROM p_dtstart)
        WHEN 'MONTHLY' THEN extract(day FROM d) = extract(day FROM p_dtstart)
        WHEN 'YEARLY'  THEN to_char(d, 'MMDD') = to_char(p_dtstart, 'MMDD')
        ELSE TRUE
    END;
END;
$$;

-- Local date for a row stored under UTC date p_u in series p_series_id.
-- 1. Evidence: the booking's start (non-exception rows) or original_time_slot
--    (rescheduled exceptions), if it still falls on UTC date p_u, IS the occurrence.
-- 2. Otherwise the schedule: candidates L in {U-1, U, U+1} whose scheduled start
--    (L + dtstart time of day) falls on U in UTC, trying the row's version first
--    and then the group's other versions (rows re-linked by pre-v0.76.5 splits were
--    expanded under an earlier version's time). Candidates the RRULE cannot produce
--    are dropped; of several, the earliest wins, since the UTC-keyed worker inserted
--    chronologically and ON CONFLICT kept the first.
-- other_date: a second producible candidate, i.e. a date whose own booking may
-- have been orphaned by that conflict.
CREATE FUNCTION pg_temp.occ_resolve(p_u date, p_evidence timestamptz, p_series_id bigint,
                                    OUT local_date date, OUT method text, OUT other_date date)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_series RECORD;
    v_version RECORD;
    v_tz text;
    v_all date[];
    v_ok date[];
    v_producible date[];
BEGIN
    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    v_tz := pg_temp.occ_tz(v_series.timezone);

    FOR v_version IN
        SELECT * FROM metadata.time_slot_series
        WHERE id = p_series_id OR (group_id IS NOT NULL AND group_id = v_series.group_id)
        ORDER BY (id = p_series_id) DESC, version_number DESC, id DESC
    LOOP
        SELECT array_agg(c ORDER BY c) INTO v_all
        FROM unnest(ARRAY[p_u - 1, p_u, p_u + 1]) c
        WHERE pg_temp.occ_utc_date(c, v_version.dtstart::time, v_tz) = p_u;
        CONTINUE WHEN v_all IS NULL;

        SELECT array_agg(c ORDER BY c) INTO v_ok
        FROM unnest(v_all) c
        WHERE pg_temp.occ_rrule_allows(v_version.rrule, v_version.dtstart, c);

        IF v_ok IS NOT NULL THEN
            local_date := v_ok[1];
            method := CASE WHEN array_length(v_all, 1) > 1 THEN 'schedule_tie' ELSE 'schedule' END;
            v_producible := v_ok;
            EXIT;
        ELSIF local_date IS NULL THEN
            -- No producible candidate for this version: remember the best guess, keep looking
            local_date := v_all[1];
            method := 'schedule_unmatched';
        END IF;
    END LOOP;

    IF p_evidence IS NOT NULL AND (p_evidence AT TIME ZONE 'UTC')::date = p_u THEN
        local_date := (p_evidence AT TIME ZONE v_tz)::date;
        method := 'booking';
    END IF;

    IF local_date IS NULL THEN
        local_date := p_u;
        method := 'unchanged';
    END IF;
    SELECT min(c) INTO other_date FROM unnest(v_producible) c WHERE c <> local_date;
END;
$$;

DO $repair$
DECLARE
    v_marker CONSTANT text := 'Local calendar date of the scheduled occurrence in the series timezone';
    v_pair RECORD;
    v_fix RECORD;
    v_template jsonb;
    v_orphans bigint[];
    v_linked int := 0;
    v_boundaries int := 0;
    v_unresolved int;
BEGIN
    -- Idempotent: rows already converted must not be shifted again
    IF col_description('metadata.time_slot_instances'::regclass,
           (SELECT attnum FROM pg_attribute
            WHERE attrelid = 'metadata.time_slot_instances'::regclass AND attname = 'occurrence_date')) = v_marker THEN
        RAISE NOTICE 'occurrence_date already holds local dates; repair skipped';
        RETURN;
    END IF;

    -- Evidence: start of each non-exception row's booking (per entity table and
    -- time slot column), and original_time_slot of rescheduled exceptions
    CREATE TEMP TABLE _occ_evidence (instance_id bigint PRIMARY KEY, start_at timestamptz) ON COMMIT DROP;
    FOR v_pair IN
        SELECT DISTINCT entity_table, time_slot_property FROM metadata.time_slot_series
    LOOP
        CONTINUE WHEN to_regclass(format('public.%I', v_pair.entity_table)) IS NULL;
        EXECUTE format(
            'INSERT INTO _occ_evidence
             SELECT i.id, lower(e.%I)
             FROM metadata.time_slot_instances i
             JOIN metadata.time_slot_series s ON s.id = i.series_id
             JOIN public.%I e ON e.id = i.entity_id
             WHERE s.entity_table = $1 AND s.time_slot_property = $2 AND NOT i.is_exception
             ON CONFLICT DO NOTHING',
            v_pair.time_slot_property, v_pair.entity_table)
        USING v_pair.entity_table, v_pair.time_slot_property;
    END LOOP;
    INSERT INTO _occ_evidence
    SELECT id, lower(original_time_slot) FROM metadata.time_slot_instances
    WHERE is_exception AND original_time_slot IS NOT NULL
    ON CONFLICT DO NOTHING;

    CREATE TEMP TABLE _occ_fix ON COMMIT DROP AS
    SELECT i.id, i.series_id, i.occurrence_date AS utc_date, r.local_date, r.method, r.other_date
    FROM metadata.time_slot_instances i
    LEFT JOIN _occ_evidence e ON e.instance_id = i.id
    CROSS JOIN LATERAL pg_temp.occ_resolve(i.occurrence_date, e.start_at, i.series_id) r;

    -- Two rows of one series may not land on the same local date. If evidence put a
    -- row (edited without being marked an exception) onto a neighbour's date, fall
    -- back to the schedule for the colliding rows; abort if that still collides.
    UPDATE _occ_fix f SET local_date = r.local_date, method = r.method || '_after_collision'
    FROM (SELECT f2.id, (pg_temp.occ_resolve(f2.utc_date, NULL, f2.series_id)).*
          FROM _occ_fix f2
          WHERE (f2.series_id, f2.local_date) IN (
              SELECT series_id, local_date FROM _occ_fix GROUP BY 1, 2 HAVING count(*) > 1)) r
    WHERE r.id = f.id;
    IF EXISTS (SELECT 1 FROM _occ_fix GROUP BY series_id, local_date HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'occurrence_date repair would put two occurrences of one series on the same date: %',
            (SELECT string_agg(format('series %s %s (instances %s)', series_id, local_date, ids), '; ')
             FROM (SELECT series_id, local_date, string_agg(id::text, ',') AS ids
                   FROM _occ_fix GROUP BY 1, 2 HAVING count(*) > 1) d)
            USING HINT = 'Resolve these instances by hand (they were edited without being marked exceptions), then re-run the deployment.';
    END IF;

    -- Keep each rewritten row's original UTC date so the revert can restore it
    -- exactly (the forward rule may have used an earlier version's schedule)
    CREATE TABLE metadata.time_slot_instances_utc_dates (
        instance_id BIGINT PRIMARY KEY REFERENCES metadata.time_slot_instances(id) ON DELETE CASCADE,
        utc_date DATE NOT NULL
    );
    COMMENT ON TABLE metadata.time_slot_instances_utc_dates IS
        'Pre-v0.76.9 (UTC) occurrence_date of rows rewritten by migration v0-76-9-occurrence-date-local; used only by its revert.';
    REVOKE ALL ON metadata.time_slot_instances_utc_dates FROM PUBLIC;
    INSERT INTO metadata.time_slot_instances_utc_dates (instance_id, utc_date)
    SELECT id, utc_date FROM _occ_fix WHERE local_date <> utc_date;

    ALTER TABLE metadata.time_slot_instances DROP CONSTRAINT unique_series_occurrence;

    UPDATE metadata.time_slot_instances i
    SET occurrence_date = f.local_date
    FROM _occ_fix f
    WHERE f.id = i.id AND f.local_date <> i.occurrence_date;

    ALTER TABLE metadata.time_slot_instances
        ADD CONSTRAINT unique_series_occurrence UNIQUE (series_id, occurrence_date);

    -- Re-link bookings the UTC-keyed worker orphaned: when two producible dates
    -- shared one UTC date, the second occurrence's booking was inserted but its
    -- instance row hit ON CONFLICT DO NOTHING. Link it only if exactly one unlinked
    -- booking matches the scheduled slot and the series template (status columns
    -- excluded, they change per booking); otherwise report it.
    FOR v_fix IN
        SELECT f.series_id, f.other_date, s.entity_table, s.time_slot_property, s.duration,
               s.dtstart, s.entity_template, pg_temp.occ_tz(s.timezone) AS tz
        FROM _occ_fix f JOIN metadata.time_slot_series s ON s.id = f.series_id
        WHERE f.other_date IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances x
                          WHERE x.series_id = f.series_id AND x.occurrence_date = f.other_date)
    LOOP
        CONTINUE WHEN to_regclass(format('public.%I', v_fix.entity_table)) IS NULL;
        v_template := v_fix.entity_template - 'time_slot' - v_fix.time_slot_property::text;
        v_template := v_template - COALESCE((
            SELECT array_agg(a.attname::text)
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.contype = 'f' AND c.conrelid = format('public.%I', v_fix.entity_table)::regclass
              AND c.confrelid = 'metadata.statuses'::regclass), ARRAY[]::text[]);

        EXECUTE format(
            'SELECT array_agg(e.id) FROM public.%I e
             WHERE lower(e.%I) = $1 AND upper(e.%I) = $1 + $2
               AND to_jsonb(e) @> $3
               AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances x
                               WHERE x.entity_table = $4 AND x.entity_id = e.id)',
            v_fix.entity_table, v_fix.time_slot_property, v_fix.time_slot_property)
        INTO v_orphans
        USING (v_fix.other_date + v_fix.dtstart::time) AT TIME ZONE v_fix.tz, v_fix.duration,
              v_template, v_fix.entity_table;

        IF array_length(v_orphans, 1) = 1 THEN
            INSERT INTO metadata.time_slot_instances (series_id, occurrence_date, entity_table, entity_id, is_exception)
            VALUES (v_fix.series_id, v_fix.other_date, v_fix.entity_table, v_orphans[1], FALSE);
            v_linked := v_linked + 1;
        ELSIF array_length(v_orphans, 1) > 1 THEN
            RAISE NOTICE 'Series % %: % unlinked bookings match the occurrence (%); none linked',
                v_fix.series_id, v_fix.other_date, array_length(v_orphans, 1), v_orphans;
        END IF;
    END LOOP;

    -- Split boundaries: a split ended the old version on (UTC split date - 1) and
    -- started the new one on the UTC split date. With local dates the split
    -- occurrence can now sit on the old version's last day, and its UNTIL would let
    -- the old version expand that occurrence again. End each old version the day
    -- before its successor's first occurrence.
    FOR v_fix IN
        SELECT old.id AS old_id, old.rrule, old.effective_until, nxt.id AS new_id,
               (SELECT min(occurrence_date) FROM metadata.time_slot_instances WHERE series_id = nxt.id) AS first_date
        FROM metadata.time_slot_series old
        JOIN metadata.time_slot_series nxt
          ON nxt.group_id = old.group_id AND nxt.version_number = old.version_number + 1
        WHERE old.effective_until IS NOT NULL
    LOOP
        CONTINUE WHEN v_fix.first_date IS NULL OR v_fix.first_date > v_fix.effective_until;
        UPDATE metadata.time_slot_series
        SET effective_until = v_fix.first_date - 1,
            rrule = metadata.modify_rrule_until(v_fix.rrule, v_fix.first_date - 1)
        WHERE id = v_fix.old_id;
        UPDATE metadata.time_slot_series SET effective_from = v_fix.first_date WHERE id = v_fix.new_id;
        v_boundaries := v_boundaries + 1;
    END LOOP;

    SELECT count(*) INTO v_unresolved FROM _occ_fix WHERE method IN ('unchanged', 'schedule_unmatched');
    RAISE NOTICE 'occurrence_date repair: % rows rewritten (% by booking, % by schedule), % orphaned bookings re-linked, % split boundaries moved, % rows without a producible date left as stored',
        (SELECT count(*) FROM _occ_fix WHERE local_date <> utc_date),
        (SELECT count(*) FROM _occ_fix WHERE local_date <> utc_date AND method LIKE 'booking%'),
        (SELECT count(*) FROM _occ_fix WHERE local_date <> utc_date AND method LIKE 'schedule%'),
        v_linked, v_boundaries, v_unresolved;

    EXECUTE format('COMMENT ON COLUMN metadata.time_slot_instances.occurrence_date IS %L', v_marker);
END
$repair$;

-- ============================================================================
-- 2. split_series_from_date: restore re-link of future instances
-- ============================================================================

CREATE OR REPLACE FUNCTION split_series_from_date(
  p_series_id bigint,
  p_split_date date,
  p_new_dtstart timestamp without time zone,
  p_new_duration interval DEFAULT NULL,
  p_new_template jsonb DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_original RECORD;
    v_group_id BIGINT;
    v_new_version INT;
    v_new_series_id BIGINT;
    v_user_id UUID;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_original FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Check series ownership or admin (use group or fallback to series created_by)
    IF v_original.group_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.time_slot_series_groups
            WHERE id = v_original.group_id
              AND (created_by = v_user_id OR is_admin() OR metadata._is_db_admin())
        ) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    ELSE
        IF NOT (v_original.created_by = v_user_id OR is_admin() OR metadata._is_db_admin()) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    END IF;

    IF v_original.group_id IS NULL THEN
        INSERT INTO metadata.time_slot_series_groups (display_name, created_by)
        VALUES (COALESCE(v_original.entity_template->>'purpose', 'Recurring Schedule'), v_user_id)
        RETURNING id INTO v_group_id;

        UPDATE metadata.time_slot_series
        SET group_id = v_group_id, version_number = 1
        WHERE id = p_series_id;
    ELSE
        v_group_id := v_original.group_id;
    END IF;

    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_new_version
    FROM metadata.time_slot_series WHERE group_id = v_group_id;

    UPDATE metadata.time_slot_series
    SET effective_until = (p_split_date - INTERVAL '1 day')::DATE,
        rrule = metadata.modify_rrule_until(v_original.rrule, (p_split_date - INTERVAL '1 day')::DATE)
    WHERE id = p_series_id;

    IF p_new_template IS NOT NULL THEN
        p_new_template := v_original.entity_template || p_new_template;
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_new_template);
    END IF;

    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, entity_table,
        entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id, v_new_version, p_split_date, v_original.entity_table,
        COALESCE(p_new_template, v_original.entity_template),
        v_original.rrule, p_new_dtstart,
        COALESCE(p_new_duration, v_original.duration),
        v_original.timezone, v_original.time_slot_property,
        'active', v_user_id
    ) RETURNING id INTO v_new_series_id;

    -- Re-link the original version's instances on/after the split date to the new
    -- version (v0.38.5 behavior, dropped by the v0.76.5 rewrite). Without this, the
    -- old version keeps its already-expanded future occurrences and the worker expands
    -- the new version on the same dates: every following occurrence is doubled.
    UPDATE metadata.time_slot_instances
    SET series_id = v_new_series_id
    WHERE series_id = p_series_id
      AND occurrence_date >= p_split_date;

    RETURN jsonb_build_object(
        'success', TRUE, 'original_series_id', p_series_id,
        'new_series_id', v_new_series_id, 'group_id', v_group_id,
        'split_date', p_split_date
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb) TO authenticated;

-- ============================================================================
-- 3. Expose the series timezone in current_version (for "today" in that zone)
-- ============================================================================
-- Same columns and types (current_version stays jsonb), so dependent views stay.

CREATE OR REPLACE VIEW metadata.series_groups_summary AS
SELECT
    g.id,
    g.display_name,
    g.description,
    g.color,
    g.created_by,
    g.created_at,
    g.updated_at,
    COUNT(DISTINCT s.id) AS version_count,
    MIN(s.effective_from) AS started_on,
    (SELECT s2.entity_table FROM metadata.time_slot_series s2 WHERE s2.group_id = g.id LIMIT 1) AS entity_table,
    (
        SELECT jsonb_build_object(
            'series_id', cs.id,
            'rrule', cs.rrule,
            'dtstart', cs.dtstart,
            'duration', cs.duration,
            'timezone', cs.timezone,
            'status', cs.status,
            'entity_template', cs.entity_template
        )
        FROM metadata.time_slot_series cs
        WHERE cs.group_id = g.id AND cs.effective_until IS NULL
        ORDER BY cs.version_number DESC
        LIMIT 1
    ) AS current_version,
    (
        SELECT COUNT(*)
        FROM metadata.time_slot_instances tsi
        JOIN metadata.time_slot_series s2 ON s2.id = tsi.series_id
        WHERE s2.group_id = g.id AND tsi.entity_id IS NOT NULL
    ) AS active_instance_count,
    (
        SELECT COUNT(*)
        FROM metadata.time_slot_instances tsi
        JOIN metadata.time_slot_series s2 ON s2.id = tsi.series_id
        WHERE s2.group_id = g.id AND tsi.is_exception = TRUE
    ) AS exception_count,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM metadata.time_slot_series s3
            WHERE s3.group_id = g.id AND s3.effective_until IS NULL AND s3.status = 'active'
        ) THEN 'active'
        WHEN EXISTS (
            SELECT 1 FROM metadata.time_slot_series s3
            WHERE s3.group_id = g.id AND s3.status = 'needs_attention'
        ) THEN 'needs_attention'
        ELSE 'ended'
    END AS status,
    (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', tsi.id,
                'series_id', tsi.series_id,
                'occurrence_date', tsi.occurrence_date,
                'entity_table', tsi.entity_table,
                'entity_id', tsi.entity_id,
                'is_exception', tsi.is_exception,
                'exception_type', tsi.exception_type,
                'exception_reason', tsi.exception_reason
            ) ORDER BY tsi.occurrence_date ASC
        ), '[]'::jsonb)
        FROM (
            SELECT tsi2.*
            FROM metadata.time_slot_instances tsi2
            JOIN metadata.time_slot_series s4 ON s4.id = tsi2.series_id
            WHERE s4.group_id = g.id
            ORDER BY tsi2.occurrence_date ASC
            LIMIT 100
        ) tsi
    ) AS instances
FROM metadata.time_slot_series_groups g
LEFT JOIN metadata.time_slot_series s ON s.group_id = g.id
GROUP BY g.id;


COMMIT;
