-- Revert civic_os:v0-76-9-occurrence-date-local
--
-- Restores UTC occurrence dates: rows the deploy converted get their original back
-- (metadata.time_slot_instance_date_repair.utc_date); rows created after it (by the
-- v0.76.9 worker, re-linked orphans and placeholders) are computed as the old worker
-- would have (UTC date of the booking's start where it still falls on the stored
-- local date, otherwise of the version's scheduled time). Split boundaries the
-- conversion moved are restored from metadata.time_slot_date_repair.detail, and series
-- it paused get their status back. Also restores the v0.76.5 split_series_from_date
-- (without the re-link) and drops the conversion tables and functions.
--
-- LOSSY: the UTC-keyed model cannot hold two occurrences of one series on the same
-- UTC date. Rows that existed before the deploy keep their date; of the others the
-- earliest stays and the rest are unlinked (their bookings stay), each reported with
-- a NOTICE. Rows the repair detached are re-linked at their original date when it
-- is free. Stop the worker first.

BEGIN;

DO $revert$
DECLARE
    v_pair RECORD;
    v_drop RECORD;
    v_b RECORD;
BEGIN
    CREATE TEMP TABLE _occ_evidence (instance_id bigint PRIMARY KEY, start_at timestamptz) ON COMMIT DROP;
    FOR v_pair IN SELECT DISTINCT entity_table, time_slot_property FROM metadata.time_slot_series
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

    CREATE TEMP TABLE _occ_revert ON COMMIT DROP AS
    SELECT i.id, i.series_id, i.occurrence_date AS local_date, (b.instance_id IS NOT NULL) AS pre_deploy,
           CASE WHEN b.instance_id IS NOT NULL THEN b.utc_date
                WHEN e.start_at IS NOT NULL
                     AND (e.start_at AT TIME ZONE s.tz)::date = i.occurrence_date
                THEN (e.start_at AT TIME ZONE 'UTC')::date
                ELSE ((((i.occurrence_date + s.dtstart::time) AT TIME ZONE s.tz)
                       AT TIME ZONE 'UTC')::date)
           END AS utc_date
    FROM metadata.time_slot_instances i
    -- Series timezone as the worker resolves it (UTC when unset or not an exact name);
    -- inline so pg_timezone_names, which reads the zone files, is scanned once
    JOIN (SELECT x.id, x.dtstart,
                 CASE WHEN x.timezone IN (SELECT name FROM pg_timezone_names) THEN x.timezone ELSE 'UTC' END AS tz
          FROM metadata.time_slot_series x) s ON s.id = i.series_id
    LEFT JOIN _occ_evidence e ON e.instance_id = i.id
    LEFT JOIN metadata.time_slot_instance_date_repair b ON b.instance_id = i.id;

    -- Collisions: rows present before the deploy first, then the earliest occurrence
    FOR v_drop IN
        SELECT id, series_id, local_date, utc_date FROM (
            SELECT r.*, row_number() OVER (PARTITION BY series_id, utc_date
                                           ORDER BY pre_deploy DESC, local_date, id) AS n
            FROM _occ_revert r) ranked
        WHERE n > 1
    LOOP
        RAISE NOTICE 'Revert unlinks instance % (series %, %): its UTC date % is taken by another occurrence',
            v_drop.id, v_drop.series_id, v_drop.local_date, v_drop.utc_date;
        DELETE FROM metadata.time_slot_instances WHERE id = v_drop.id;
        DELETE FROM _occ_revert WHERE id = v_drop.id;
    END LOOP;

    ALTER TABLE metadata.time_slot_instances DROP CONSTRAINT unique_series_occurrence;
    UPDATE metadata.time_slot_instances i
    SET occurrence_date = r.utc_date
    FROM _occ_revert r
    WHERE r.id = i.id AND r.utc_date <> i.occurrence_date;
    ALTER TABLE metadata.time_slot_instances
        ADD CONSTRAINT unique_series_occurrence UNIQUE (series_id, occurrence_date);

    -- Rows the conversion detached (a second booking of one occurrence) come back at
    -- their original UTC date, unless another row now holds it
    IF to_regclass('metadata.time_slot_instance_date_repair') IS NOT NULL THEN
        INSERT INTO metadata.time_slot_instances
        SELECT (jsonb_populate_record(NULL::metadata.time_slot_instances,
                                      b.detached_row || jsonb_build_object('occurrence_date', b.utc_date))).*
        FROM metadata.time_slot_instance_date_repair b
        WHERE b.status = 'detached' AND b.detached_row IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances x
                          WHERE x.series_id = b.series_id AND x.occurrence_date = b.utc_date)
          AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_instances x WHERE x.id = (b.detached_row ->> 'id')::bigint)
        ON CONFLICT DO NOTHING;
    END IF;

    -- Split boundaries the conversion moved
    IF to_regclass('metadata.time_slot_date_repair') IS NOT NULL THEN
        FOR v_b IN
            SELECT series_id, detail -> 'boundary_moved' AS b
            FROM metadata.time_slot_date_repair WHERE detail ? 'boundary_moved'
        LOOP
            UPDATE metadata.time_slot_series
            SET effective_until = (v_b.b ->> 'effective_until')::date, rrule = v_b.b ->> 'rrule'
            WHERE id = v_b.series_id;
            UPDATE metadata.time_slot_series
            SET effective_from = (v_b.b ->> 'successor_effective_from')::date
            WHERE id = (v_b.b ->> 'successor_id')::bigint;
        END LOOP;
    END IF;

    -- Series the conversion paused (unresolved rows)
    IF to_regclass('metadata.time_slot_date_repair') IS NOT NULL THEN
        UPDATE metadata.time_slot_series s
        SET status = COALESCE(r.prior_status, 'active')
        FROM metadata.time_slot_date_repair r
        WHERE r.series_id = s.id AND r.status = 'needs_attention' AND s.status = 'needs_attention';
    END IF;

    COMMENT ON COLUMN metadata.time_slot_instances.occurrence_date IS NULL;
END
$revert$;

DROP TABLE IF EXISTS metadata.time_slot_instance_date_repair;
DROP TABLE IF EXISTS metadata.time_slot_date_repair;

DROP FUNCTION IF EXISTS metadata.resolve_occurrence_date(bigint, date);
DROP FUNCTION IF EXISTS metadata.occurrence_date_relink(bigint, date, timestamptz);
DROP FUNCTION IF EXISTS metadata.occurrence_date_orphans(bigint, timestamptz);

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

    RETURN jsonb_build_object(
        'success', TRUE, 'original_series_id', p_series_id,
        'new_series_id', v_new_series_id, 'group_id', v_group_id,
        'split_date', p_split_date
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb) TO authenticated;

-- current_version without timezone (v0.38.5 definition)
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
