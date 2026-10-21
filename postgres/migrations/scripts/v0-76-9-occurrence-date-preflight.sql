-- Civic OS v0.76.9 upgrade pre-flight: recurring occurrence dates (changes nothing)
--
-- Run on the current database BEFORE deploying v0.76.9, e.g.
--   psql "$DATABASE_URL" -f postgres/migrations/scripts/v0-76-9-occurrence-date-preflight.sql
-- It plans the occurrence_date conversion of migration v0-76-9-occurrence-date-local
-- with the migration's own code (temporary functions and tables, rolled back) and
-- lists what the upgrade will not decide by itself: groups whose RRULE it does not
-- evaluate, ties without evidence, rows no occurrence explains, occurrences booked
-- twice, orphaned bookings it will try to re-link, and split boundaries it will move.
-- See docs/deployment/PRODUCTION.md (Upgrading to v0.76.9).

BEGIN;

-- >>> shared with deploy/v0-76-9-occurrence-date-local.sql (keep identical)

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

DO $preflight$
DECLARE
    v_r RECORD;
    v_any boolean;
BEGIN
    PERFORM pg_temp.occ_plan();

    RAISE NOTICE 'Instances: % in % series (% without a booking: cancelled or skipped)',
        (SELECT count(*) FROM _occ_inst), (SELECT count(DISTINCT series_id) FROM _occ_inst),
        (SELECT count(*) FROM _occ_inst WHERE entity_id IS NULL);
    RAISE NOTICE 'Converted by the upgrade: % moved to their local date, % already on it',
        (SELECT count(*) FROM _occ_inst WHERE status = 'repaired'),
        (SELECT count(*) FROM _occ_inst WHERE status = 'unchanged');

    v_any := false;
    FOR v_r IN SELECT g.group_key, g.unsupported, array_agg(v.id ORDER BY v.id) AS series
               FROM _occ_grp g JOIN _occ_ver v ON v.group_key = g.group_key
               WHERE g.unsupported IS NOT NULL AND g.until IS NOT NULL
               GROUP BY g.group_key, g.unsupported ORDER BY g.group_key
    LOOP
        v_any := true;
        RAISE NOTICE 'Rule not evaluated: series % (%): every row needs a date from an admin', v_r.series, v_r.unsupported;
    END LOOP;
    IF NOT v_any THEN RAISE NOTICE 'Rules not evaluated: none'; END IF;

    v_any := false;
    FOR v_r IN SELECT p.series_id, p.id, p.entity_id, p.utc_date, p.candidates, p.note
               FROM _occ_inst p JOIN _occ_grp g ON g.group_key = p.group_key
               WHERE p.status = 'unresolved' AND g.unsupported IS NULL ORDER BY p.series_id, p.id
    LOOP
        v_any := true;
        RAISE NOTICE 'Undecided: series %, instance % (booking %), stored %, candidates %: %',
            v_r.series_id, v_r.id, COALESCE(v_r.entity_id::text, 'none'), v_r.utc_date, v_r.candidates, v_r.note;
    END LOOP;
    IF NOT v_any THEN RAISE NOTICE 'Undecided rows (ties without evidence, rows no occurrence explains): none'; END IF;

    v_any := false;
    FOR v_r IN SELECT p.series_id, p.id, p.entity_id, p.new_date, p.note FROM _occ_inst p
               WHERE p.status = 'detached' ORDER BY p.series_id, p.id
    LOOP
        v_any := true;
        RAISE NOTICE 'Booked twice: series % on %: booking % will be detached (kept as a standalone record): %',
            v_r.series_id, v_r.new_date, COALESCE(v_r.entity_id::text, 'none'), v_r.note;
    END LOOP;
    IF NOT v_any THEN RAISE NOTICE 'Occurrences booked twice: none'; END IF;

    RAISE NOTICE 'Possibly orphaned bookings to re-link on an exact, unique match: %',
        (SELECT count(*) FROM (
            SELECT DISTINCT p.cand_series, c.d FROM _occ_inst p
            CROSS JOIN LATERAL unnest(p.candidates) c(d)
            WHERE p.status IN ('repaired', 'unchanged') AND p.cand_series IS NOT NULL
              AND cardinality(p.candidates) > 1 AND c.d <> p.new_date
              AND NOT EXISTS (SELECT 1 FROM _occ_inst h WHERE h.series_id = p.cand_series
                              AND h.new_date = c.d AND h.status <> 'detached')) x);
    RAISE NOTICE 'Split boundaries to move: %',
        (SELECT count(*) FROM _occ_ver o
         JOIN _occ_ver n ON n.group_key = o.group_key AND n.version_number = o.version_number + 1 AND o.group_key > 0
         WHERE o.effective_until IS NOT NULL
           AND (SELECT min(p.new_date) FROM _occ_inst p WHERE p.series_id = n.id AND p.status <> 'detached') <= o.effective_until);
    RAISE NOTICE 'Series the upgrade will pause until an admin resolves their rows: %',
        (SELECT count(*) FROM _occ_ver v WHERE EXISTS (
            SELECT 1 FROM _occ_inst p WHERE p.group_key = v.group_key AND p.status = 'unresolved'));
END
$preflight$;

ROLLBACK;
