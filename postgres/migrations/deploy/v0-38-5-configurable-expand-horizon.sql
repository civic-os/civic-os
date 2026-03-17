-- Deploy civic_os:v0-38-5-configurable-expand-horizon
--
-- Add configurable expansion horizon parameter to recurring series functions.
-- Both create_recurring_series() and update_series_schedule() gain a
-- p_expand_horizon_days INTEGER DEFAULT 90 parameter so agencies can
-- control how far into the future instances are generated.

BEGIN;

-- ============================================================================
-- Step 1: Replace create_recurring_series() — add p_expand_horizon_days param
-- ============================================================================

-- Drop the 12-param signature from v0-38-5-recurring-dtstart-local-time
DROP FUNCTION IF EXISTS public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN);

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
    p_skip_conflicts BOOLEAN DEFAULT FALSE,
    p_expand_horizon_days INTEGER DEFAULT 90
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
    -- Get current user
    v_user_id := public.current_user_id();

    -- Validate required fields
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

    -- Validate RRULE (will raise exception if invalid)
    PERFORM metadata.validate_rrule(p_rrule);

    -- Validate entity template
    PERFORM metadata.validate_entity_template(p_entity_table, p_entity_template);

    -- Create group
    INSERT INTO metadata.time_slot_series_groups (
        display_name, description, color, created_by
    ) VALUES (
        p_group_name, p_group_description, p_group_color, v_user_id
    ) RETURNING id INTO v_group_id;

    -- Create series (dtstart is now local wall-clock time, effective_from is just the date)
    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, entity_table,
        entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id, 1, p_dtstart::DATE, p_entity_table,
        p_entity_template, p_rrule, p_dtstart, p_duration, p_timezone,
        p_time_slot_property, 'active', v_user_id
    ) RETURNING id INTO v_series_id;

    -- If expand_now is true, queue expansion job
    IF p_expand_now THEN
        -- Queue River job for expansion (p_expand_horizon_days from TODAY)
        INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
        VALUES (
            'available',
            'recurring',
            'expand_recurring_series',
            jsonb_build_object(
                'series_id', v_series_id,
                'expand_until', to_char((NOW() + (p_expand_horizon_days || ' days')::INTERVAL)::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ),
            3,
            NOW(),
            NOW()
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

COMMENT ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN, INTEGER) IS
    'Creates a new recurring series with group, series record, and triggers expansion.
     dtstart is wall-clock local time (TIMESTAMP), timezone stored separately.
     p_expand_horizon_days controls how far into the future to generate instances (default 90).
     Returns JSONB with group_id and series_id.';

GRANT EXECUTE ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN, INTEGER) TO authenticated;


-- ============================================================================
-- Step 2: Replace update_series_schedule() — add p_expand_horizon_days param
-- ============================================================================

-- Drop the 4-param signature from v0-38-5-recurring-dtstart-local-time
DROP FUNCTION IF EXISTS public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT);

CREATE OR REPLACE FUNCTION public.update_series_schedule(
    p_series_id BIGINT,
    p_dtstart TIMESTAMP,
    p_duration INTERVAL,
    p_rrule TEXT,
    p_expand_horizon_days INTEGER DEFAULT 90
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

    -- Get series
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Check permissions (creator or has update permission or admin)
    IF NOT (
        v_series.created_by = v_user_id
        OR public.has_permission('time_slot_series', 'update')
        OR public.is_admin()
    ) THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Permission denied');
    END IF;

    -- Validate RRULE (will raise exception if invalid)
    PERFORM metadata.validate_rrule(p_rrule);

    -- Step 1: Collect entity IDs from non-exception instances
    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id
      AND entity_id IS NOT NULL
      AND is_exception = FALSE;

    -- Step 2: Delete entity records
    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format(
            'DELETE FROM public.%I WHERE id = ANY($1)',
            v_series.entity_table
        ) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Step 3: Delete non-exception instances
    DELETE FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND is_exception = FALSE;

    -- Step 4: Update series schedule and reset expansion tracking
    UPDATE metadata.time_slot_series
    SET
        dtstart = p_dtstart,
        duration = p_duration,
        rrule = p_rrule,
        expanded_until = NULL,  -- Reset to trigger fresh expansion
        effective_from = p_dtstart::DATE
    WHERE id = p_series_id;

    -- Step 5: Calculate expansion horizon (p_expand_horizon_days from TODAY)
    v_expand_until := (NOW() + (p_expand_horizon_days || ' days')::INTERVAL)::DATE;

    -- Step 6: Queue River job for expansion
    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available',
        'recurring',
        'expand_recurring_series',
        jsonb_build_object(
            'series_id', p_series_id,
            'expand_until', to_char(v_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ),
        3,
        NOW(),
        NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Schedule updated. Deleted %s old records. Expansion queued.', v_deleted_count),
        'series_id', p_series_id,
        'entities_deleted', v_deleted_count,
        'expand_until', v_expand_until
    );
END;
$$;

COMMENT ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT, INTEGER) IS
    'Updates series schedule (dtstart, duration, rrule) and regenerates instances.
     Deletes existing non-exception instances and entity records, then queues expansion.
     p_expand_horizon_days controls how far into the future to generate instances (default 90).
     Requires creator, update permission, or admin.';

GRANT EXECUTE ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT, INTEGER) TO authenticated;


-- ============================================================================
-- Step 3: Notify PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
