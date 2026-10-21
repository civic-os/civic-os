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
--
--    This migration converts the rows once (rules in section 1, design in
--    docs/notes/RECURRING_TIMESLOT_DESIGN.md "Converting existing rows"):
--    - The schedule decides. A row takes the local date of the occurrence of its own
--      version (else of another version of its group) that falls on its stored UTC
--      date. The booking, or original_time_slot of a rescheduled exception, only
--      breaks a tie between two such occurrences (a DST change).
--    - Nothing is guessed: a tie without evidence, a row no occurrence explains, and
--      every row of a group whose RRULE uses a part evaluated only by the worker
--      (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR, ...) keeps its stored date and is
--      recorded in metadata.time_slot_instance_date_repair as 'unresolved'. Its
--      series are paused (status 'needs_attention', which the worker skips) until an
--      admin resolves each row with metadata.resolve_occurrence_date().
--    - A second row for one occurrence (pre-v0.76.5 splits booked some twice) is
--      detached: its booking stays as a standalone record, reported.
--    - Bookings the UTC-keyed worker orphaned are re-linked only on an exact, unique
--      match (slot and template); several matches get a placeholder row that keeps
--      the worker from booking the occurrence again, reported.
--    - Split boundaries end the day before the successor's first occurrence.
--    Everything is recorded for the revert. Re-running the script is a no-op.
--
--    UPGRADE NOTE: stop the consolidated worker while this migration runs and start
--    the v0.76.9 worker after it (MAINTENANCE_MODE is read only at worker startup, so
--    restart the worker for it to take effect). Run the pre-flight script
--    postgres/migrations/scripts/v0-76-9-occurrence-date-preflight.sql first
--    (docs/deployment/PRODUCTION.md). Row locks only; measured 47 s for 100,000
--    instances in 1,000 series (about 8 ms per series plus 0.4 ms per instance).
--
-- 2. split_series_from_date(): restore the re-link of the original version's
--    instances on/after the split date (present since v0.38.5, dropped by the v0.76.5
--    security rewrite), and refuse groups whose dates need attention.
--
-- 3. metadata.series_groups_summary.current_version gains "timezone", so the series
--    page compares occurrence dates with today's date in the series timezone.
--
-- Framework-managed rows only (time_slot_instances and time_slot_series state are
-- written by the framework, never customized by integrators); no instance content
-- is touched.

BEGIN;

-- ============================================================================
-- 1. Convert occurrence dates
-- ============================================================================

-- >>> shared with scripts/v0-76-9-occurrence-date-preflight.sql (keep identical)

-- Parse an RRULE into the parts this conversion evaluates exactly. Anything else
-- returns {"unsupported": "<part>"}: those groups are never guessed.
-- UNTIL is ignored: splits added it after the rows were expanded.
CREATE FUNCTION pg_temp.occ_parse(p_rrule text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_part text;
    v_key text;
    v_val text;
    v_tok text;
    v_m text[];
    v_days constant text[] := ARRAY['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
    v_r jsonb := '{}';
    v_bymonth int[] := '{}';
    v_bymonthday int[] := '{}';
    v_plain int[] := '{}';
    v_ord_n int[] := '{}';
    v_ord_d int[] := '{}';
BEGIN
    FOREACH v_part IN ARRAY string_to_array(regexp_replace(upper(btrim(COALESCE(p_rrule, ''))), '^RRULE:', ''), ';')
    LOOP
        CONTINUE WHEN v_part = '';
        v_key := split_part(v_part, '=', 1);
        v_val := substr(v_part, length(v_key) + 2);
        CASE v_key
            WHEN 'FREQ' THEN
                IF v_val NOT IN ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') THEN
                    RETURN jsonb_build_object('unsupported', 'FREQ=' || v_val);
                END IF;
                v_r := v_r || jsonb_build_object('freq', v_val);
            WHEN 'INTERVAL', 'COUNT' THEN
                IF v_val !~ '^[1-9][0-9]{0,5}$' THEN
                    RETURN jsonb_build_object('unsupported', v_part);
                END IF;
                v_r := v_r || jsonb_build_object(lower(v_key), v_val::int);
            WHEN 'UNTIL' THEN
                NULL;
            WHEN 'WKST' THEN
                IF NOT v_val = ANY (v_days) THEN
                    RETURN jsonb_build_object('unsupported', v_part);
                END IF;
                v_r := v_r || jsonb_build_object('wkst', array_position(v_days, v_val));
            WHEN 'BYMONTH' THEN
                FOREACH v_tok IN ARRAY string_to_array(v_val, ',') LOOP
                    IF v_tok !~ '^([1-9]|1[0-2])$' THEN
                        RETURN jsonb_build_object('unsupported', v_part);
                    END IF;
                    v_bymonth := v_bymonth || v_tok::int;
                END LOOP;
            WHEN 'BYMONTHDAY' THEN
                FOREACH v_tok IN ARRAY string_to_array(v_val, ',') LOOP
                    IF v_tok !~ '^[+-]?([1-9]|[12][0-9]|3[01])$' THEN
                        RETURN jsonb_build_object('unsupported', v_part);
                    END IF;
                    v_bymonthday := v_bymonthday || v_tok::int;
                END LOOP;
            WHEN 'BYDAY' THEN
                FOREACH v_tok IN ARRAY string_to_array(v_val, ',') LOOP
                    v_m := regexp_match(v_tok, '^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$');
                    IF v_m IS NULL THEN
                        RETURN jsonb_build_object('unsupported', v_part);
                    ELSIF v_m[1] IS NULL THEN
                        v_plain := v_plain || array_position(v_days, v_m[2]);
                    ELSE
                        v_ord_n := v_ord_n || v_m[1]::int;
                        v_ord_d := v_ord_d || array_position(v_days, v_m[2]);
                    END IF;
                END LOOP;
            ELSE
                RETURN jsonb_build_object('unsupported', v_key);
        END CASE;
    END LOOP;

    IF v_r ->> 'freq' IS NULL THEN
        RETURN jsonb_build_object('unsupported', 'no FREQ');
    END IF;
    IF cardinality(v_ord_n) > 0 AND (v_r ->> 'freq' IN ('DAILY', 'WEEKLY')
                                     OR (v_r ->> 'freq' = 'YEARLY' AND cardinality(v_bymonth) = 0)) THEN
        RETURN jsonb_build_object('unsupported', 'BYDAY ordinal with FREQ=' || (v_r ->> 'freq'));
    END IF;
    IF v_r ->> 'freq' = 'WEEKLY' AND cardinality(v_bymonthday) > 0 THEN
        RETURN jsonb_build_object('unsupported', 'BYMONTHDAY with FREQ=WEEKLY');
    END IF;

    RETURN v_r || jsonb_build_object('bymonth', v_bymonth, 'bymonthday', v_bymonthday,
                                     'byday', v_plain, 'ord_n', v_ord_n, 'ord_d', v_ord_d);
END
$$;

-- Occurrences of a parsed rule up to p_until (RFC 5545 as rrule-go evaluates it:
-- DTSTART counts only if it matches, COUNT from DTSTART, invalid dates skipped).
-- start_at resolves DST-hour wall times like the v0.76.9 worker (AT TIME ZONE).
CREATE FUNCTION pg_temp.occ_expand(p_rule jsonb, p_dtstart timestamp, p_tz text, p_until date)
RETURNS TABLE (local_date date, start_at timestamptz, utc_date date) LANGUAGE sql STABLE AS $$
    WITH r AS (
        SELECT p_rule ->> 'freq' AS freq,
               COALESCE((p_rule ->> 'interval')::int, 1) AS n,
               (p_rule ->> 'count')::int AS cnt,
               COALESCE((p_rule ->> 'wkst')::int, 1) AS wkst,
               ARRAY(SELECT jsonb_array_elements_text(p_rule -> 'bymonth')::int) AS bymonth,
               ARRAY(SELECT jsonb_array_elements_text(p_rule -> 'bymonthday')::int) AS bymonthday,
               ARRAY(SELECT jsonb_array_elements_text(p_rule -> 'byday')::int) AS byday,
               ARRAY(SELECT jsonb_array_elements_text(p_rule -> 'ord_n')::int) AS ord_n,
               ARRAY(SELECT jsonb_array_elements_text(p_rule -> 'ord_d')::int) AS ord_d,
               p_dtstart::date AS d0,
               -- whole seconds, like the worker (rrule-go reads DTSTART as YYYYMMDDTHHMMSS)
               date_trunc('second', p_dtstart)::time AS t0
    ), d AS (
        SELECT r.*, g::date AS d,
               extract(isodow FROM g)::int AS dow,
               extract(day FROM g)::int AS dom,
               extract(month FROM g)::int AS mon,
               extract(year FROM g)::int AS yr,
               extract(day FROM date_trunc('month', g) + interval '1 month - 1 day')::int AS dim
        FROM r, generate_series(r.d0::timestamp, p_until::timestamp, interval '1 day') g
    ), f AS (
        SELECT d.*,
               (cardinality(bymonth) = 0 OR mon = ANY (bymonth)) AS month_ok,
               (dom = ANY (bymonthday) OR (dom - dim - 1) = ANY (bymonthday)) AS monthday_ok,
               (dow = ANY (byday) OR EXISTS (
                   SELECT 1 FROM unnest(ord_n, ord_d) o(k, w)
                   WHERE o.w = dow AND (o.k = (dom - 1) / 7 + 1 OR o.k = -((dim - dom) / 7 + 1)))) AS byday_ok,
               cardinality(bymonthday) > 0 AS has_bmd,
               cardinality(byday) + cardinality(ord_n) > 0 AS has_byday
        FROM d
    ), m AS (
        SELECT f.d, f.t0, f.cnt
        FROM f
        WHERE CASE f.freq
            WHEN 'DAILY' THEN
                (f.d - f.d0) % f.n = 0 AND f.month_ok
                AND (NOT f.has_bmd OR f.monthday_ok) AND (NOT f.has_byday OR f.byday_ok)
            WHEN 'WEEKLY' THEN
                f.month_ok
                AND f.dow = ANY (CASE WHEN f.has_byday THEN f.byday ELSE ARRAY[extract(isodow FROM f.d0)::int] END)
                AND ((f.d - (f.d0 - ((extract(isodow FROM f.d0)::int - f.wkst + 7) % 7))) / 7) % f.n = 0
            WHEN 'MONTHLY' THEN
                ((f.yr * 12 + f.mon) - (extract(year FROM f.d0)::int * 12 + extract(month FROM f.d0)::int)) % f.n = 0
                AND f.month_ok
                AND CASE WHEN f.has_bmd AND f.has_byday THEN f.monthday_ok AND f.byday_ok
                         WHEN f.has_bmd THEN f.monthday_ok
                         WHEN f.has_byday THEN f.byday_ok
                         ELSE f.dom = extract(day FROM f.d0)::int END
            WHEN 'YEARLY' THEN
                (f.yr - extract(year FROM f.d0)::int) % f.n = 0
                AND CASE WHEN cardinality(f.bymonth) > 0 THEN f.mon = ANY (f.bymonth)
                         WHEN f.has_bmd OR f.has_byday THEN TRUE
                         ELSE f.mon = extract(month FROM f.d0)::int END
                AND CASE WHEN f.has_bmd AND f.has_byday THEN f.monthday_ok AND f.byday_ok
                         WHEN f.has_bmd THEN f.monthday_ok
                         WHEN f.has_byday THEN f.byday_ok
                         ELSE f.dom = extract(day FROM f.d0)::int END
        END
    ), c AS (
        SELECT m.d, m.t0, m.cnt, row_number() OVER (ORDER BY m.d) AS k FROM m
    ), s AS (
        SELECT (c.d + c.t0) AT TIME ZONE p_tz AS start_at FROM c WHERE c.cnt IS NULL OR c.k <= c.cnt
    )
    SELECT (s.start_at AT TIME ZONE p_tz)::date, s.start_at, (s.start_at AT TIME ZONE 'UTC')::date FROM s
$$;

-- Plan the conversion into temp tables; writes nothing else.
--   _occ_ver   versions, parsed rules           _occ_occ   their occurrences
--   _occ_grp   groups, and why one is not evaluated
--   _occ_ev    tie evidence per row             _occ_cand  candidates per row
--   _occ_inst  one decision per instance row
-- Built with CREATE TABLE AS in one pass each; only the few rows the collision rules
-- change are updated (bulk UPDATEs of indexed temp tables cost several times more).
CREATE FUNCTION pg_temp.occ_plan() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_t RECORD;
    v_n int;
BEGIN
    CREATE TEMP TABLE _occ_ver ON COMMIT DROP AS
    SELECT s.id, COALESCE(s.group_id, -s.id) AS group_key, s.version_number, s.status,
           pg_temp.occ_parse(s.rrule) AS rule, s.dtstart, s.duration,
           -- as the worker resolves it: UTC when unset or not an exact name. Inline, so
           -- pg_timezone_names (it reads the zone files) is scanned once, not per row
           CASE WHEN s.timezone IN (SELECT name FROM pg_timezone_names) THEN s.timezone ELSE 'UTC' END AS tz,
           s.entity_table, s.time_slot_property, s.effective_from, s.effective_until
    FROM metadata.time_slot_series s;
    CREATE UNIQUE INDEX ON _occ_ver (id);
    CREATE INDEX ON _occ_ver (group_key);
    ANALYZE _occ_ver;

    CREATE TEMP TABLE _occ_grp ON COMMIT DROP AS
    SELECT u.group_key, u.unsupported, m.until
    FROM (SELECT v.group_key,
                 string_agg(DISTINCT 'version ' || v.version_number || ': ' || (v.rule ->> 'unsupported'), '; ') AS unsupported
          FROM _occ_ver v GROUP BY v.group_key) u
    LEFT JOIN (SELECT v.group_key, max(i.occurrence_date) + 3 AS until
               FROM _occ_ver v JOIN metadata.time_slot_instances i ON i.series_id = v.id
               GROUP BY v.group_key) m ON m.group_key = u.group_key;
    ANALYZE _occ_grp;

    CREATE TEMP TABLE _occ_occ ON COMMIT DROP AS
    SELECT v.id AS series_id, o.local_date, o.start_at, o.utc_date
    FROM _occ_ver v
    JOIN _occ_grp g ON g.group_key = v.group_key AND g.unsupported IS NULL AND g.until IS NOT NULL
    CROSS JOIN LATERAL pg_temp.occ_expand(v.rule, v.dtstart, v.tz, g.until) o;
    CREATE INDEX ON _occ_occ (series_id, utc_date);
    ANALYZE _occ_occ;

    -- The booking's start: evidence for ties only (exceptions use original_time_slot)
    CREATE TEMP TABLE _occ_ev (instance_id bigint, start_at timestamptz) ON COMMIT DROP;
    FOR v_t IN SELECT DISTINCT entity_table, time_slot_property FROM _occ_ver
    LOOP
        CONTINUE WHEN to_regclass(format('public.%I', v_t.entity_table)) IS NULL;
        EXECUTE format(
            'INSERT INTO _occ_ev
             SELECT i.id, lower(e.%I)
             FROM metadata.time_slot_instances i
             JOIN _occ_ver v ON v.id = i.series_id
             JOIN public.%I e ON e.id = i.entity_id
             WHERE v.entity_table = $1 AND v.time_slot_property = $2 AND NOT i.is_exception',
            v_t.time_slot_property, v_t.entity_table)
        USING v_t.entity_table, v_t.time_slot_property;
    END LOOP;
    INSERT INTO _occ_ev
    SELECT id, lower(original_time_slot) FROM metadata.time_slot_instances
    WHERE is_exception AND original_time_slot IS NOT NULL;
    ANALYZE _occ_ev;

    -- Candidates: occurrences on the stored UTC date, of the row's own version first,
    -- else of the nearest version (earlier ones first: pre-v0.76.5 splits re-linked rows)
    CREATE TEMP TABLE _occ_cand ON COMMIT DROP AS
    SELECT DISTINCT ON (x.id) x.id, o.series_id AS cand_series,
           array_agg(o.local_date ORDER BY o.local_date) AS candidates,
           array_agg(o.start_at ORDER BY o.local_date) AS cand_starts
    FROM metadata.time_slot_instances x
    JOIN _occ_ver xv ON xv.id = x.series_id
    JOIN _occ_ver w ON w.group_key = xv.group_key
    JOIN _occ_occ o ON o.series_id = w.id AND o.utc_date = x.occurrence_date
    GROUP BY x.id, o.series_id, w.version_number, x.series_id, xv.version_number
    ORDER BY x.id, (o.series_id = x.series_id) DESC, (w.version_number < xv.version_number) DESC,
             CASE WHEN w.version_number < xv.version_number THEN -w.version_number ELSE w.version_number END;
    ANALYZE _occ_cand;

    -- One decision per row, in one pass:
    -- - one candidate: the schedule wins; several: the evidence must name one;
    -- - groups not evaluated here, and rows no occurrence explains: the candidates are
    --   the local dates the stored UTC day can stand for (one in UTC, else two)
    CREATE TEMP TABLE _occ_inst ON COMMIT DROP AS
    SELECT d.id, d.series_id, d.group_key, d.utc_date, d.entity_id, d.cand_series, d.candidates, d.cand_starts,
           COALESCE(d.chosen, d.utc_date) AS new_date,
           CASE WHEN d.chosen IS NULL THEN 'unresolved'
                WHEN d.chosen = d.utc_date THEN 'unchanged' ELSE 'repaired' END AS status,
           CASE WHEN d.chosen IS NOT NULL THEN NULL
                WHEN d.unsupported IS NOT NULL
                    THEN 'the schedule uses a rule part this upgrade does not evaluate (' || d.unsupported || ')'
                WHEN d.cand_series IS NULL THEN 'no occurrence of the series falls on this UTC date'
                ELSE 'two occurrences share this UTC date (' || array_to_string(d.candidates, ', ')
                     || ') and the booking does not say which this is' END AS note,
           (d.cand_series = d.series_id) IS TRUE AS own,
           CASE WHEN d.chosen IS NOT NULL AND d.cand_series IS NOT NULL
                THEN d.cand_starts[array_position(d.candidates, d.chosen)] END AS scheduled_start,
           CASE WHEN d.chosen IS NOT NULL AND d.cand_series IS NOT NULL THEN d.cand_duration END AS scheduled_duration
    FROM (
        SELECT b.*,
               CASE WHEN cardinality(b.candidates) = 1 THEN b.candidates[1]
                    WHEN b.cand_series IS NOT NULL AND (b.evidence AT TIME ZONE b.tz)::date = ANY (b.candidates)
                        THEN (b.evidence AT TIME ZONE b.tz)::date
               END AS chosen
        FROM (
            SELECT i.id, i.series_id, v.group_key, v.tz, i.occurrence_date AS utc_date, i.entity_id,
                   g.unsupported, c.cand_series, cv.duration AS cand_duration, e.start_at AS evidence,
                   COALESCE(c.candidates, ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[
                       ((i.occurrence_date::timestamp AT TIME ZONE 'UTC') AT TIME ZONE v.tz)::date,
                       (((i.occurrence_date + 1)::timestamp - interval '1 microsecond') AT TIME ZONE 'UTC' AT TIME ZONE v.tz)::date
                   ]) x ORDER BY x)) AS candidates,
                   c.cand_starts
            FROM metadata.time_slot_instances i
            JOIN _occ_ver v ON v.id = i.series_id
            JOIN _occ_grp g ON g.group_key = v.group_key
            LEFT JOIN _occ_cand c ON c.id = i.id
            LEFT JOIN _occ_ver cv ON cv.id = c.cand_series
            LEFT JOIN _occ_ev e ON e.instance_id = i.id
        ) b
    ) d;
    ANALYZE _occ_inst;

    -- One row per occurrence: a second resolved row for it (an earlier split booked it
    -- twice) is detached; the row matching its own version wins, then the older row
    UPDATE _occ_inst i
    SET status = 'detached',
        note = 'instance ' || r.keeper || ' already holds the ' || i.new_date
               || ' occurrence; this booking is kept but no longer linked to the series'
    FROM (
        SELECT x.id, first_value(x.id) OVER w AS keeper, row_number() OVER w AS k
        FROM _occ_inst x WHERE x.status IN ('repaired', 'unchanged')
        WINDOW w AS (PARTITION BY x.series_id, x.new_date ORDER BY x.own DESC, x.id)
    ) r
    WHERE r.id = i.id AND r.k > 1;

    -- A row does not move onto a date a staying (unresolved) row still holds
    LOOP
        UPDATE _occ_inst i
        SET note = 'its local date ' || i.new_date || ' is still held by instance ' || h.id,
            candidates = ARRAY[i.new_date], cand_starts = ARRAY[i.cand_starts[array_position(i.candidates, i.new_date)]],
            status = 'unresolved', new_date = i.utc_date, scheduled_start = NULL, scheduled_duration = NULL
        FROM _occ_inst h
        WHERE i.status = 'repaired'
          AND h.status = 'unresolved' AND h.series_id = i.series_id AND h.new_date = i.new_date AND h.id <> i.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        EXIT WHEN v_n = 0;
    END LOOP;

    CREATE UNIQUE INDEX ON _occ_inst (id);
    CREATE INDEX ON _occ_inst (series_id, new_date);
    CREATE INDEX ON _occ_inst (group_key);
    ANALYZE _occ_inst;
END
$$;

-- <<< shared

-- Bookings a second occurrence on the same UTC date lost (exact slot and template
-- match, not linked to any series; Status columns excluded). Used by the conversion
-- and by metadata.resolve_occurrence_date().
CREATE OR REPLACE FUNCTION metadata.occurrence_date_orphans(p_series_id bigint, p_start timestamptz)
RETURNS bigint[]
LANGUAGE plpgsql STABLE
SET search_path = public, metadata, postgis
AS $$
DECLARE
    v_s RECORD;
    v_template jsonb;
    v_ids bigint[];
BEGIN
    SELECT * INTO v_s FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND OR to_regclass(format('public.%I', v_s.entity_table)) IS NULL THEN
        RETURN '{}';
    END IF;
    v_template := (v_s.entity_template - 'id' - 'time_slot' - v_s.time_slot_property::text)
        - ARRAY(SELECT a.attname::text
                FROM pg_constraint c
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.contype = 'f' AND c.conrelid = format('public.%I', v_s.entity_table)::regclass
                  AND c.confrelid = 'metadata.statuses'::regclass);
    EXECUTE format(
        'SELECT array_agg(e.id ORDER BY e.id) FROM public.%I e
         WHERE lower(e.%I) = $1 AND upper(e.%I) = $2
           AND NOT EXISTS (SELECT 1 FROM jsonb_each_text($3) kv
                           WHERE (to_jsonb(e) ->> kv.key) IS DISTINCT FROM kv.value)
           AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances x
                           WHERE x.entity_table = $4 AND x.entity_id = e.id)',
        v_s.entity_table, v_s.time_slot_property, v_s.time_slot_property)
    INTO v_ids
    USING p_start, p_start + v_s.duration, v_template, v_s.entity_table;
    RETURN COALESCE(v_ids, '{}');
END
$$;
REVOKE EXECUTE ON FUNCTION metadata.occurrence_date_orphans(bigint, timestamptz) FROM PUBLIC;

-- Link the orphaned booking of an occurrence no row holds: the unique match, or a
-- placeholder (cancelled-style row without a booking) when several match, so the
-- worker does not book the occurrence again. Returns a note, NULL if nothing to do.
CREATE OR REPLACE FUNCTION metadata.occurrence_date_relink(p_series_id bigint, p_local_date date, p_start timestamptz)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, metadata, postgis
AS $$
DECLARE
    v_table name;
    v_ids bigint[];
BEGIN
    IF EXISTS (SELECT 1 FROM metadata.time_slot_instances
               WHERE series_id = p_series_id AND occurrence_date = p_local_date) THEN
        RETURN NULL;
    END IF;
    SELECT entity_table INTO v_table FROM metadata.time_slot_series WHERE id = p_series_id;
    v_ids := metadata.occurrence_date_orphans(p_series_id, p_start);
    IF cardinality(v_ids) = 1 THEN
        INSERT INTO metadata.time_slot_instances (series_id, occurrence_date, entity_table, entity_id, is_exception)
        VALUES (p_series_id, p_local_date, v_table, v_ids[1], FALSE);
        RETURN 're-linked orphaned booking ' || v_ids[1];
    ELSIF cardinality(v_ids) > 1 THEN
        INSERT INTO metadata.time_slot_instances
            (series_id, occurrence_date, entity_table, entity_id, is_exception, exception_type, exception_reason, exception_at)
        VALUES (p_series_id, p_local_date, v_table, NULL, TRUE, 'conflict_skipped',
                'v0.76.9 upgrade: unlinked bookings ' || array_to_string(v_ids, ', ')
                || ' all match this occurrence; link one (entity_id) or leave it', NOW());
        RETURN 'several unlinked bookings match (' || array_to_string(v_ids, ', ') || '); placeholder row added, none linked';
    END IF;
    RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION metadata.occurrence_date_relink(bigint, date, timestamptz) FROM PUBLIC;

DO $repair$
DECLARE
    v_r RECORD;
    v_note text;
BEGIN
    -- Idempotent: convert once
    IF to_regclass('metadata.time_slot_date_repair') IS NOT NULL THEN
        RAISE NOTICE 'occurrence_date conversion already done; skipped';
        RETURN;
    END IF;

    CREATE TABLE metadata.time_slot_date_repair (
        series_id BIGINT PRIMARY KEY REFERENCES metadata.time_slot_series(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('repaired', 'needs_attention')),
        prior_status TEXT,
        detail JSONB NOT NULL DEFAULT '{}',
        repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    COMMENT ON TABLE metadata.time_slot_date_repair IS
        'v0.76.9 occurrence_date conversion per series. needs_attention: its group has unresolved rows (metadata.time_slot_instance_date_repair); the series is paused (prior_status kept) until metadata.resolve_occurrence_date() resolves them. detail.boundary_moved is used by the revert.';

    -- No foreign key: a row detached by the conversion keeps its record here
    CREATE TABLE metadata.time_slot_instance_date_repair (
        instance_id BIGINT PRIMARY KEY,
        series_id BIGINT NOT NULL,
        utc_date DATE NOT NULL,
        local_date DATE,
        status TEXT NOT NULL CHECK (status IN ('repaired', 'unchanged', 'unresolved', 'detached')),
        note TEXT,
        candidates DATE[],
        candidate_series_id BIGINT,
        candidate_starts TIMESTAMPTZ[],
        scheduled_start TIMESTAMPTZ,
        scheduled_duration INTERVAL,
        detached_row JSONB,
        repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    COMMENT ON TABLE metadata.time_slot_instance_date_repair IS
        'v0.76.9 occurrence_date conversion per instance: utc_date is the occurrence_date stored before v0.76.9 (the revert restores it); candidates are the local dates it can stand for; scheduled_start/scheduled_duration the matched occurrence; detached_row keeps an instance the conversion detached, for the revert.';
    CREATE INDEX idx_instance_date_repair_unresolved ON metadata.time_slot_instance_date_repair (series_id)
        WHERE status = 'unresolved';

    REVOKE ALL ON metadata.time_slot_date_repair, metadata.time_slot_instance_date_repair FROM PUBLIC;
    GRANT SELECT ON metadata.time_slot_date_repair TO authenticated;

    PERFORM pg_temp.occ_plan();

    INSERT INTO metadata.time_slot_instance_date_repair
        (instance_id, series_id, utc_date, local_date, status, note, candidates, candidate_series_id,
         candidate_starts, scheduled_start, scheduled_duration)
    SELECT id, series_id, utc_date, CASE WHEN status <> 'unresolved' THEN new_date END, status, note,
           candidates, cand_series, cand_starts, scheduled_start, scheduled_duration
    FROM _occ_inst;

    -- Detach second rows of one occurrence (keep the row for the revert)
    UPDATE metadata.time_slot_instance_date_repair r
    SET detached_row = to_jsonb(i)
    FROM metadata.time_slot_instances i
    WHERE i.id = r.instance_id AND r.status = 'detached';
    DELETE FROM metadata.time_slot_instances i
    USING _occ_inst p WHERE p.id = i.id AND p.status = 'detached';

    -- Move in two steps so rows can trade dates under unique (series_id, occurrence_date)
    UPDATE metadata.time_slot_instances i
    SET occurrence_date = DATE '1000-01-01' - p.k::int
    FROM (SELECT id, row_number() OVER (PARTITION BY series_id ORDER BY id) AS k
          FROM _occ_inst WHERE status = 'repaired') p
    WHERE p.id = i.id;
    UPDATE metadata.time_slot_instances i
    SET occurrence_date = p.new_date
    FROM _occ_inst p
    WHERE p.id = i.id AND p.status = 'repaired';

    -- Orphans: the other occurrence on a resolved row's UTC date, if no row holds it
    CREATE TEMP TABLE _occ_relinked (series_id bigint, local_date date, note text) ON COMMIT DROP;
    FOR v_r IN
        SELECT DISTINCT p.cand_series AS series_id, c.d AS local_date, c.s AS start_at
        FROM _occ_inst p
        CROSS JOIN LATERAL unnest(p.candidates, p.cand_starts) c(d, s)
        WHERE p.status IN ('repaired', 'unchanged') AND p.cand_series IS NOT NULL
          AND cardinality(p.candidates) > 1 AND c.d <> p.new_date
        ORDER BY 1, 2
    LOOP
        v_note := metadata.occurrence_date_relink(v_r.series_id, v_r.local_date, v_r.start_at);
        IF v_note IS NOT NULL THEN
            INSERT INTO _occ_relinked VALUES (v_r.series_id, v_r.local_date, v_note);
            RAISE NOTICE 'Series % %: %', v_r.series_id, v_r.local_date, v_note;
        END IF;
    END LOOP;

    -- Split boundaries: a version split before v0.76.9 ended on (UTC split date - 1),
    -- which can include the local split day; end it before its successor's first one
    CREATE TEMP TABLE _occ_boundary ON COMMIT DROP AS
    SELECT o.id, o.effective_until, s.rrule, n.id AS successor_id, n.effective_from AS successor_from, f.first
    FROM _occ_ver o
    JOIN metadata.time_slot_series s ON s.id = o.id
    JOIN _occ_ver n ON n.group_key = o.group_key AND n.version_number = o.version_number + 1 AND o.group_key > 0
    CROSS JOIN LATERAL (SELECT min(i.occurrence_date) AS first FROM metadata.time_slot_instances i
                        WHERE i.series_id = n.id) f
    WHERE o.effective_until IS NOT NULL AND f.first <= o.effective_until;
    UPDATE metadata.time_slot_series s
    SET effective_until = b.first - 1, rrule = metadata.modify_rrule_until(s.rrule, b.first - 1)
    FROM _occ_boundary b WHERE b.id = s.id;
    UPDATE metadata.time_slot_series s
    SET effective_from = b.first
    FROM _occ_boundary b WHERE b.successor_id = s.id;
    FOR v_r IN SELECT * FROM _occ_boundary LOOP
        RAISE NOTICE 'Series % now ends %, before series %''s first occurrence', v_r.id, v_r.first - 1, v_r.successor_id;
    END LOOP;

    -- Per-series outcome; pause series of groups with unresolved rows
    INSERT INTO metadata.time_slot_date_repair (series_id, status, prior_status, detail)
    SELECT v.id,
           CASE WHEN COALESCE(gu.n, 0) > 0 THEN 'needs_attention' ELSE 'repaired' END,
           CASE WHEN COALESCE(gu.n, 0) > 0 THEN v.status END,
           jsonb_strip_nulls(jsonb_build_object(
               'repaired', COALESCE(a.repaired, 0),
               'unchanged', COALESCE(a.unchanged, 0),
               'unresolved', a.unresolved,
               'detached', a.detached,
               'relinked_orphans', (SELECT jsonb_agg(jsonb_build_object('date', x.local_date, 'note', x.note) ORDER BY x.local_date)
                                    FROM _occ_relinked x WHERE x.series_id = v.id),
               'boundary_moved', (SELECT jsonb_build_object('effective_until', b.effective_until, 'rrule', b.rrule,
                                      'successor_id', b.successor_id, 'successor_effective_from', b.successor_from)
                                  FROM _occ_boundary b WHERE b.id = v.id)))
    FROM _occ_ver v
    LEFT JOIN (
        SELECT p.series_id,
               count(*) FILTER (WHERE p.status = 'repaired') AS repaired,
               count(*) FILTER (WHERE p.status = 'unchanged') AS unchanged,
               jsonb_agg(jsonb_build_object('instance_id', p.id, 'entity_id', p.entity_id, 'date', p.utc_date,
                         'candidates', p.candidates, 'note', p.note) ORDER BY p.id) FILTER (WHERE p.status = 'unresolved') AS unresolved,
               jsonb_agg(jsonb_build_object('instance_id', p.id, 'entity_id', p.entity_id, 'date', p.new_date,
                         'note', p.note) ORDER BY p.id) FILTER (WHERE p.status = 'detached') AS detached
        FROM _occ_inst p GROUP BY p.series_id
    ) a ON a.series_id = v.id
    LEFT JOIN (SELECT p.group_key, count(*) AS n FROM _occ_inst p WHERE p.status = 'unresolved' GROUP BY p.group_key) gu
        ON gu.group_key = v.group_key
    WHERE EXISTS (SELECT 1 FROM _occ_inst p WHERE p.group_key = v.group_key)
       OR EXISTS (SELECT 1 FROM _occ_relinked x WHERE x.series_id = v.id);

    UPDATE metadata.time_slot_series s SET status = 'needs_attention'
    FROM metadata.time_slot_date_repair r
    WHERE r.series_id = s.id AND r.status = 'needs_attention' AND s.status <> 'needs_attention';

    FOR v_r IN SELECT p.series_id, p.id, p.utc_date, p.note FROM _occ_inst p
               WHERE p.status IN ('unresolved', 'detached') ORDER BY p.series_id, p.id
    LOOP
        RAISE NOTICE 'Series % instance % (%): %', v_r.series_id, v_r.id, v_r.utc_date, v_r.note;
    END LOOP;

    COMMENT ON COLUMN metadata.time_slot_instances.occurrence_date IS
        'Local calendar date of the scheduled occurrence in the series timezone';

    RAISE NOTICE 'occurrence_date conversion: % instances (% repaired, % unchanged, % detached, % unresolved), % orphans re-linked, % boundaries moved; % series paused (needs_attention)',
        (SELECT count(*) FROM _occ_inst),
        (SELECT count(*) FROM _occ_inst WHERE status = 'repaired'),
        (SELECT count(*) FROM _occ_inst WHERE status = 'unchanged'),
        (SELECT count(*) FROM _occ_inst WHERE status = 'detached'),
        (SELECT count(*) FROM _occ_inst WHERE status = 'unresolved'),
        (SELECT count(*) FROM _occ_relinked WHERE note LIKE 're-linked%'),
        (SELECT count(*) FROM _occ_boundary),
        (SELECT count(*) FROM metadata.time_slot_date_repair WHERE status = 'needs_attention');
END
$repair$;

-- Remedy for an unresolved row: an admin names its local date, which must be one of
-- its candidates and free in the series. Re-links the other candidate's orphaned
-- booking, and resumes the group's series once no row of the group is unresolved.
CREATE OR REPLACE FUNCTION metadata.resolve_occurrence_date(p_instance_id bigint, p_local_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, postgis
AS $$
DECLARE
    v_r RECORD;
    v_group_key bigint;
    v_k int;
    v_note text;
    v_notes text[] := '{}';
    v_resumed int := 0;
BEGIN
    IF NOT (is_admin() OR metadata._is_db_admin()) THEN
        RAISE EXCEPTION 'Permission denied' USING HINT = 'Only an administrator can resolve occurrence dates';
    END IF;

    SELECT * INTO v_r FROM metadata.time_slot_instance_date_repair
    WHERE instance_id = p_instance_id AND status = 'unresolved'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instance % has no unresolved occurrence date', p_instance_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances WHERE id = p_instance_id) THEN
        RAISE EXCEPTION 'Instance % no longer exists', p_instance_id;
    END IF;
    v_k := array_position(v_r.candidates, p_local_date);
    IF v_k IS NULL THEN
        RAISE EXCEPTION 'Not a candidate date: % (candidates: %)', p_local_date, array_to_string(v_r.candidates, ', ');
    END IF;
    IF EXISTS (SELECT 1 FROM metadata.time_slot_instances
               WHERE series_id = v_r.series_id AND occurrence_date = p_local_date AND id <> p_instance_id) THEN
        RAISE EXCEPTION 'Instance % of series % already holds %', (
            SELECT id FROM metadata.time_slot_instances
            WHERE series_id = v_r.series_id AND occurrence_date = p_local_date), v_r.series_id, p_local_date
            USING HINT = 'Resolve that row first';
    END IF;

    UPDATE metadata.time_slot_instances SET occurrence_date = p_local_date WHERE id = p_instance_id;
    UPDATE metadata.time_slot_instance_date_repair
    SET status = CASE WHEN p_local_date = utc_date THEN 'unchanged' ELSE 'repaired' END,
        local_date = p_local_date,
        note = note || ' -- resolved to ' || p_local_date || ' by ' || COALESCE(current_user_id()::text, session_user),
        scheduled_start = candidate_starts[v_k],
        scheduled_duration = (SELECT duration FROM metadata.time_slot_series WHERE id = candidate_series_id),
        repaired_at = NOW()
    WHERE instance_id = p_instance_id;

    -- The other occurrence on that UTC date may have an orphaned booking
    IF v_r.candidate_series_id IS NOT NULL THEN
        FOR v_k IN 1 .. cardinality(v_r.candidates) LOOP
            CONTINUE WHEN v_r.candidates[v_k] = p_local_date;
            v_note := metadata.occurrence_date_relink(v_r.candidate_series_id, v_r.candidates[v_k], v_r.candidate_starts[v_k]);
            IF v_note IS NOT NULL THEN
                v_notes := v_notes || (v_r.candidates[v_k] || ': ' || v_note);
            END IF;
        END LOOP;
    END IF;

    -- Resume the group's series once nothing in it is unresolved
    SELECT COALESCE(group_id, -id) INTO v_group_key FROM metadata.time_slot_series WHERE id = v_r.series_id;
    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_instance_date_repair x
        JOIN metadata.time_slot_series s ON s.id = x.series_id
        WHERE x.status = 'unresolved' AND COALESCE(s.group_id, -s.id) = v_group_key
    ) THEN
        UPDATE metadata.time_slot_series s
        SET status = COALESCE(r.prior_status, 'active')
        FROM metadata.time_slot_date_repair r
        WHERE r.series_id = s.id AND r.status = 'needs_attention' AND s.status = 'needs_attention'
          AND COALESCE(s.group_id, -s.id) = v_group_key;
        GET DIAGNOSTICS v_resumed = ROW_COUNT;
        UPDATE metadata.time_slot_date_repair r
        SET status = 'repaired', repaired_at = NOW()
        FROM metadata.time_slot_series s
        WHERE s.id = r.series_id AND r.status = 'needs_attention' AND COALESCE(s.group_id, -s.id) = v_group_key;
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'instance_id', p_instance_id, 'occurrence_date', p_local_date,
                              'relinked', to_jsonb(v_notes), 'series_resumed', v_resumed);
END
$$;
REVOKE EXECUTE ON FUNCTION metadata.resolve_occurrence_date(bigint, date) FROM PUBLIC;
COMMENT ON FUNCTION metadata.resolve_occurrence_date(bigint, date) IS
    'v0.76.9 upgrade remedy (admins): set the local date of an occurrence the conversion left unresolved; see docs/deployment/PRODUCTION.md';

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

    -- Occurrence dates of this group the v0.76.9 conversion could not decide
    IF EXISTS (
        SELECT 1 FROM metadata.time_slot_instance_date_repair r
        JOIN metadata.time_slot_series g ON g.id = r.series_id
        WHERE r.status = 'unresolved'
          AND (g.id = p_series_id OR (v_original.group_id IS NOT NULL AND g.group_id = v_original.group_id))
    ) THEN
        RAISE EXCEPTION 'The dates of this series need attention'
            USING HINT = 'An administrator must resolve them first (metadata.time_slot_instance_date_repair, status unresolved)';
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
