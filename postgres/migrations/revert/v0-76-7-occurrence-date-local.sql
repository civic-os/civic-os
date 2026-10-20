-- Revert civic_os:v0-76-7-occurrence-date-local
--
-- Restores UTC occurrence dates (the exact inverse of the deploy mapping; rows the
-- fixed worker wrote after deploy are converted the same way, matching the old worker)
-- and the v0.76.5 split_series_from_date without the re-link.

BEGIN;

CREATE TEMP TABLE _occurrence_date_revert ON COMMIT DROP AS
WITH zone AS (
    SELECT s.id AS series_id,
           s.dtstart::time AS start_time,
           -- Same fallback as the worker: unset or unknown timezone means UTC
           CASE WHEN s.timezone IN (SELECT name FROM pg_timezone_names) THEN s.timezone ELSE 'UTC' END AS tz
    FROM metadata.time_slot_series s
)
SELECT i.id,
       ((((i.occurrence_date + z.start_time) AT TIME ZONE z.tz) AT TIME ZONE 'UTC')::date) AS utc_date
FROM metadata.time_slot_instances i
JOIN zone z ON z.series_id = i.series_id
WHERE ((((i.occurrence_date + z.start_time) AT TIME ZONE z.tz) AT TIME ZONE 'UTC')::date) <> i.occurrence_date;

ALTER TABLE metadata.time_slot_instances DROP CONSTRAINT unique_series_occurrence;

UPDATE metadata.time_slot_instances i
SET occurrence_date = r.utc_date
FROM _occurrence_date_revert r
WHERE r.id = i.id;

ALTER TABLE metadata.time_slot_instances
    ADD CONSTRAINT unique_series_occurrence UNIQUE (series_id, occurrence_date);

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

COMMIT;
