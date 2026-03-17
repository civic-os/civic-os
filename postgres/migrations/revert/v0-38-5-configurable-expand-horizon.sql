-- Revert civic_os:v0-38-5-configurable-expand-horizon from pg
--
-- Remove the p_expand_horizon_days parameter from create_recurring_series()
-- and update_series_schedule(), restoring the original signatures with
-- hardcoded INTERVAL '90 days'.

BEGIN;

-- ============================================================================
-- Step 1: Drop the 13-param create_recurring_series and restore 12-param
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN, INTEGER);

CREATE OR REPLACE FUNCTION public.create_recurring_series(
    p_group_name TEXT,
    p_group_description TEXT DEFAULT NULL,
    p_group_color TEXT DEFAULT NULL,
    p_entity_table NAME DEFAULT NULL,
    p_entity_template JSONB DEFAULT '{}',
    p_rrule TEXT DEFAULT NULL,
    p_dtstart TIMESTAMP DEFAULT NULL,
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

COMMENT ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) IS
    'Creates a new recurring series with group, series record, and triggers expansion.
     dtstart is wall-clock local time (TIMESTAMP), timezone stored separately.
     Returns JSONB with group_id and series_id.
     Changed from TIMESTAMPTZ to TIMESTAMP in v0.38.5.';

GRANT EXECUTE ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) TO authenticated;


-- ============================================================================
-- Step 2: Drop the 5-param update_series_schedule and restore 4-param
-- ============================================================================

DROP FUNCTION IF EXISTS public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.update_series_schedule(
    p_series_id BIGINT,
    p_dtstart TIMESTAMP,
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

COMMENT ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT) IS
    'Updates series schedule (dtstart, duration, rrule) and regenerates instances.
     Deletes existing non-exception instances and entity records, then queues expansion.
     Requires creator, update permission, or admin.
     Changed p_dtstart from TIMESTAMPTZ to TIMESTAMP in v0.38.5.';

GRANT EXECUTE ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT) TO authenticated;


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
