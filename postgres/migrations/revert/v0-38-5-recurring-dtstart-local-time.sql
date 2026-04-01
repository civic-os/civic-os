-- Revert civic_os:v0-38-5-recurring-dtstart-local-time from pg
--
-- Convert dtstart back from TIMESTAMP to TIMESTAMPTZ and restore
-- the original function signatures.

BEGIN;

-- ============================================================================
-- Step 1: Convert dtstart column back to TIMESTAMPTZ
-- ============================================================================

-- Convert local wall-clock time back to TIMESTAMPTZ using the timezone column
UPDATE metadata.time_slot_series
SET dtstart = (dtstart::TIMESTAMP AT TIME ZONE timezone)
WHERE timezone IS NOT NULL AND timezone != '';

-- Drop dependent views before type change (CASCADE handles transitive deps like schema_series_groups)
DROP VIEW IF EXISTS metadata.series_groups_summary CASCADE;
DROP VIEW IF EXISTS public.time_slot_series;

-- For rows without timezone, assume UTC
ALTER TABLE metadata.time_slot_series
    ALTER COLUMN dtstart TYPE TIMESTAMPTZ USING dtstart::TIMESTAMPTZ;

-- Recreate view with original column type
CREATE OR REPLACE VIEW public.time_slot_series
WITH (security_invoker = true)
AS
SELECT
    id, group_id, version_number, effective_from, effective_until,
    entity_table, entity_template, rrule, dtstart, duration, timezone,
    time_slot_property, status, expanded_until, created_by, created_at,
    template_updated_at, template_updated_by
FROM metadata.time_slot_series;

GRANT SELECT ON public.time_slot_series TO web_anon, authenticated;


-- ============================================================================
-- Step 2: Restore original create_recurring_series() with TIMESTAMPTZ
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN);

-- The original function will be restored by re-deploying v0-19-0
-- For safety, create a minimal version that accepts TIMESTAMPTZ
CREATE OR REPLACE FUNCTION public.create_recurring_series(
    p_group_name TEXT,
    p_group_description TEXT DEFAULT NULL,
    p_group_color TEXT DEFAULT NULL,
    p_entity_table NAME DEFAULT NULL,
    p_entity_template JSONB DEFAULT '{}',
    p_rrule TEXT DEFAULT NULL,
    p_dtstart TIMESTAMPTZ DEFAULT NULL,
    p_duration INTERVAL DEFAULT NULL,
    p_timezone TEXT DEFAULT NULL,
    p_time_slot_property NAME DEFAULT 'time_slot',
    p_expand_now BOOLEAN DEFAULT FALSE,
    p_skip_conflicts BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_group_id BIGINT;
    v_series_id BIGINT;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    IF p_entity_table IS NULL THEN
        RAISE EXCEPTION 'entity_table is required';
    END IF;
    IF p_rrule IS NULL THEN
        RAISE EXCEPTION 'rrule is required';
    END IF;
    IF p_dtstart IS NULL THEN
        RAISE EXCEPTION 'dtstart is required';
    END IF;
    IF p_duration IS NULL THEN
        RAISE EXCEPTION 'duration is required';
    END IF;

    PERFORM metadata.validate_rrule(p_rrule);
    PERFORM metadata.validate_entity_template(p_entity_table, p_entity_template);

    INSERT INTO metadata.time_slot_series_groups (
        display_name, description, color, created_by
    ) VALUES (
        p_group_name, p_group_description, p_group_color, v_user_id
    ) RETURNING id INTO v_group_id;

    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, entity_table,
        entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id, 1, p_dtstart::DATE, p_entity_table,
        p_entity_template, p_rrule, p_dtstart, p_duration, p_timezone,
        p_time_slot_property, 'active', v_user_id
    ) RETURNING id INTO v_series_id;

    IF p_expand_now THEN
        INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
        VALUES (
            'available', 'recurring', 'expand_recurring_series',
            jsonb_build_object(
                'series_id', v_series_id,
                'expand_until', to_char((NOW() + INTERVAL '90 days')::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ),
            3, NOW(), NOW()
        );
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'group_id', v_group_id,
        'series_id', v_series_id,
        'message', 'Recurring series created successfully'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) TO authenticated;


-- ============================================================================
-- Step 3: Restore original split_series_from_date() with TIMESTAMPTZ
-- ============================================================================

DROP FUNCTION IF EXISTS public.split_series_from_date(BIGINT, DATE, TIMESTAMP, INTERVAL, JSONB);

CREATE OR REPLACE FUNCTION public.split_series_from_date(
    p_series_id BIGINT,
    p_split_date DATE,
    p_new_dtstart TIMESTAMPTZ,
    p_new_duration INTERVAL DEFAULT NULL,
    p_new_template JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_original RECORD;
    v_group_id BIGINT;
    v_new_version INT;
    v_new_series_id BIGINT;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    SELECT * INTO v_original
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
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
    FROM metadata.time_slot_series
    WHERE group_id = v_group_id;

    UPDATE metadata.time_slot_series
    SET
        effective_until = (p_split_date - INTERVAL '1 day')::DATE,
        rrule = metadata.modify_rrule_until(v_original.rrule, (p_split_date - INTERVAL '1 day')::DATE)
    WHERE id = p_series_id;

    IF p_new_template IS NOT NULL THEN
        p_new_template := v_original.entity_template || p_new_template;
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_new_template);
    END IF;

    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, effective_until,
        entity_table, entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id, v_new_version, p_split_date, NULL,
        v_original.entity_table, COALESCE(p_new_template, v_original.entity_template),
        v_original.rrule, p_new_dtstart, COALESCE(p_new_duration, v_original.duration),
        v_original.timezone, v_original.time_slot_property, 'active', v_user_id
    )
    RETURNING id INTO v_new_series_id;

    UPDATE metadata.time_slot_instances
    SET series_id = v_new_series_id
    WHERE series_id = p_series_id
      AND occurrence_date >= p_split_date;

    RETURN jsonb_build_object(
        'success', TRUE, 'message', 'Series split successfully',
        'original_series_id', p_series_id, 'new_series_id', v_new_series_id,
        'group_id', v_group_id, 'split_date', p_split_date
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB) TO authenticated;


-- ============================================================================
-- Step 4: Restore original update_series_schedule() with TIMESTAMPTZ
-- ============================================================================

DROP FUNCTION IF EXISTS public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT);

CREATE OR REPLACE FUNCTION public.update_series_schedule(
    p_series_id BIGINT,
    p_dtstart TIMESTAMPTZ,
    p_duration INTERVAL,
    p_rrule TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_entity_ids BIGINT[];
    v_deleted_count INT := 0;
    v_expand_until DATE;
BEGIN
    v_user_id := public.current_user_id();

    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT (
        v_series.created_by = v_user_id
        OR public.has_permission('time_slot_series', 'update')
        OR public.is_admin()
    ) THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Permission denied');
    END IF;

    PERFORM metadata.validate_rrule(p_rrule);

    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id
      AND entity_id IS NOT NULL
      AND is_exception = FALSE;

    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format(
            'DELETE FROM public.%I WHERE id = ANY($1)',
            v_series.entity_table
        ) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    DELETE FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND is_exception = FALSE;

    UPDATE metadata.time_slot_series
    SET
        dtstart = p_dtstart,
        duration = p_duration,
        rrule = p_rrule,
        expanded_until = NULL,
        effective_from = p_dtstart::DATE
    WHERE id = p_series_id;

    v_expand_until := (NOW() + INTERVAL '90 days')::DATE;

    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available', 'recurring', 'expand_recurring_series',
        jsonb_build_object('series_id', p_series_id, 'expand_until', to_char(v_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        3, NOW(), NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Schedule updated. Deleted %s old records. Expansion queued.', v_deleted_count),
        'series_id', p_series_id, 'entities_deleted', v_deleted_count, 'expand_until', v_expand_until
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMPTZ, INTERVAL, TEXT) TO authenticated;


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
