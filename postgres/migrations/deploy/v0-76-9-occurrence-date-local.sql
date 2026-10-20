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
--    This migration only flags the rows: every series in metadata.time_slot_date_repair
--    and every instance, with its original UTC date, in
--    metadata.time_slot_instance_date_repair, and it enqueues the worker job
--    repair_occurrence_dates. The worker computes the local dates with rrule-go, the
--    code that expands series (consolidated-worker-go occurrence_date_repair*.go),
--    re-links orphaned bookings on an exact unique match, detaches a second booking of
--    one occurrence (pre-v0.76.5 splits that booked twice) and moves split boundaries.
--    Ties it cannot decide are left flagged ('needs_attention') and reported.
--    Expansion and splits of a group wait until its repair is done.
--
--    UPGRADE NOTE: stop the consolidated worker while this migration runs and start
--    the v0.76.9 worker after it (MAINTENANCE_MODE is read only at worker startup, so
--    restart the worker for it to take effect). Run the pre-flight query in
--    docs/deployment/PRODUCTION.md first.
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
-- 1. Flag occurrence dates for repair by the worker (no date computation here)
-- ============================================================================

DO $flag$
BEGIN
    -- Idempotent: flag once
    IF to_regclass('metadata.time_slot_date_repair') IS NOT NULL THEN
        RAISE NOTICE 'occurrence_date repair already flagged; skipped';
        RETURN;
    END IF;

    CREATE TABLE metadata.time_slot_date_repair (
        series_id BIGINT PRIMARY KEY REFERENCES metadata.time_slot_series(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'repaired', 'needs_attention')),
        detail JSONB,
        flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        repaired_at TIMESTAMPTZ
    );
    COMMENT ON TABLE metadata.time_slot_date_repair IS
        'v0.76.9 occurrence_date repair per series (worker job repair_occurrence_dates). needs_attention: rows the repair could not decide, listed in detail; expansion and splits of the group wait until it is repaired.';

    -- No foreign key: a row detached by the repair keeps its record here
    CREATE TABLE metadata.time_slot_instance_date_repair (
        instance_id BIGINT PRIMARY KEY,
        series_id BIGINT NOT NULL,
        utc_date DATE NOT NULL,
        local_date DATE,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'repaired', 'unchanged', 'unresolved', 'detached')),
        note TEXT,
        detached_row JSONB,
        repaired_at TIMESTAMPTZ
    );
    COMMENT ON TABLE metadata.time_slot_instance_date_repair IS
        'v0.76.9 occurrence_date repair per instance: utc_date is the occurrence_date stored before v0.76.9 (the revert restores it); detached_row keeps an instance the repair detached, for the revert.';
    CREATE INDEX idx_instance_date_repair_series ON metadata.time_slot_instance_date_repair (series_id) WHERE status = 'pending';

    REVOKE ALL ON metadata.time_slot_date_repair, metadata.time_slot_instance_date_repair FROM PUBLIC;
    GRANT SELECT ON metadata.time_slot_date_repair TO authenticated;

    INSERT INTO metadata.time_slot_instance_date_repair (instance_id, series_id, utc_date)
    SELECT id, series_id, occurrence_date FROM metadata.time_slot_instances;
    INSERT INTO metadata.time_slot_date_repair (series_id)
    SELECT id FROM metadata.time_slot_series s
    WHERE EXISTS (SELECT 1 FROM metadata.time_slot_instances i WHERE i.series_id = s.id);

    IF EXISTS (SELECT 1 FROM metadata.time_slot_date_repair) THEN
        INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at, priority)
        VALUES ('available', 'recurring', 'repair_occurrence_dates', '{}'::jsonb, 5, NOW(), NOW(), 1);
    END IF;

    COMMENT ON COLUMN metadata.time_slot_instances.occurrence_date IS
        'Local calendar date of the scheduled occurrence in the series timezone';

    RAISE NOTICE 'occurrence_date repair flagged: % series, % instances; the v0.76.9 worker repairs them',
        (SELECT count(*) FROM metadata.time_slot_date_repair),
        (SELECT count(*) FROM metadata.time_slot_instance_date_repair);
END
$flag$;

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

    -- Occurrence dates of this group are still being converted (v0.76.9 repair)
    IF EXISTS (
        SELECT 1 FROM metadata.time_slot_date_repair r
        JOIN metadata.time_slot_series g ON g.id = r.series_id
        WHERE r.status <> 'repaired'
          AND (g.id = p_series_id OR (v_original.group_id IS NOT NULL AND g.group_id = v_original.group_id))
    ) THEN
        RAISE EXCEPTION 'The dates of this series are being repaired'
            USING HINT = 'Try again shortly; if it persists, see metadata.time_slot_date_repair (needs_attention)';
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
