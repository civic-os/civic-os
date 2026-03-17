-- Deploy civic_os:v0-38-5-recurring-dtstart-local-time
--
-- Fix recurring schedules timezone bugs:
-- 1. Change dtstart from TIMESTAMPTZ to TIMESTAMP (wall-clock local time)
-- 2. Store timezone separately (already exists) for UTC conversion
-- 3. Fix effective_from for existing rows
-- 4. Replace 3 SQL functions with TIMESTAMP parameter types

BEGIN;

-- ============================================================================
-- Step 1: Convert dtstart column from TIMESTAMPTZ to TIMESTAMP
-- ============================================================================
-- Recurring schedules are defined in wall-clock time ("every Tuesday at 5pm").
-- Storing as TIMESTAMPTZ caused UTC<->local round-trip bugs in frontend, SQL,
-- and Go worker. TIMESTAMP stores the literal wall-clock time the user entered.

-- Convert existing data: use timezone column to derive local time where available
UPDATE metadata.time_slot_series
SET dtstart = (dtstart AT TIME ZONE timezone)
WHERE timezone IS NOT NULL AND timezone != '';

-- For rows without timezone, dtstart is already treated as UTC wall-clock time
-- (no conversion needed — the TIMESTAMPTZ -> TIMESTAMP cast just drops the zone)

-- Drop dependent views (PostgreSQL blocks ALTER TYPE on columns referenced by views)
-- Drop order: outermost first, then inner
DROP VIEW IF EXISTS public.schema_series_groups CASCADE;
DROP VIEW IF EXISTS metadata.series_groups_summary CASCADE;
DROP VIEW IF EXISTS public.time_slot_series CASCADE;

-- Now alter the column type
ALTER TABLE metadata.time_slot_series
    ALTER COLUMN dtstart TYPE TIMESTAMP USING dtstart::TIMESTAMP;

-- Fix effective_from for existing rows (now correct since dtstart is local)
UPDATE metadata.time_slot_series
SET effective_from = dtstart::DATE;

-- Recreate dependent views (same definitions, they pick up the new column type)
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

GRANT SELECT ON metadata.series_groups_summary TO web_anon, authenticated;

CREATE OR REPLACE VIEW public.schema_series_groups
WITH (security_invoker = true)
AS
SELECT
    id, display_name, description, color, created_by, created_at, updated_at,
    version_count, started_on, entity_table, current_version,
    active_instance_count, exception_count, status, instances
FROM metadata.series_groups_summary;

GRANT SELECT ON public.schema_series_groups TO web_anon, authenticated;


-- ============================================================================
-- Step 2: Replace create_recurring_series() with TIMESTAMP parameter
-- ============================================================================

-- Drop old signature first
DROP FUNCTION IF EXISTS public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN);

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
        -- Queue River job for expansion (90 days from TODAY)
        -- Note: expand_until must be ISO8601 timestamp for Go parsing
        INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
        VALUES (
            'available',
            'recurring',
            'expand_recurring_series',
            jsonb_build_object(
                'series_id', v_series_id,
                'expand_until', to_char((NOW() + INTERVAL '90 days')::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
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

COMMENT ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) IS
    'Creates a new recurring series with group, series record, and triggers expansion.
     dtstart is wall-clock local time (TIMESTAMP), timezone stored separately.
     Returns JSONB with group_id and series_id.
     Changed from TIMESTAMPTZ to TIMESTAMP in v0.38.5.';

GRANT EXECUTE ON FUNCTION public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMP, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN) TO authenticated;


-- ============================================================================
-- Step 3: Replace split_series_from_date() with TIMESTAMP parameter
-- ============================================================================

DROP FUNCTION IF EXISTS public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB);

CREATE OR REPLACE FUNCTION public.split_series_from_date(
    p_series_id BIGINT,
    p_split_date DATE,
    p_new_dtstart TIMESTAMP,
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

    -- Get original series
    SELECT * INTO v_original
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Ensure series has a group (create if standalone)
    IF v_original.group_id IS NULL THEN
        INSERT INTO metadata.time_slot_series_groups (display_name, created_by)
        VALUES (
            COALESCE(v_original.entity_template->>'purpose', 'Recurring Schedule'),
            v_user_id
        )
        RETURNING id INTO v_group_id;

        UPDATE metadata.time_slot_series
        SET group_id = v_group_id, version_number = 1
        WHERE id = p_series_id;
    ELSE
        v_group_id := v_original.group_id;
    END IF;

    -- Get next version number
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_new_version
    FROM metadata.time_slot_series
    WHERE group_id = v_group_id;

    -- Terminate original series
    UPDATE metadata.time_slot_series
    SET
        effective_until = (p_split_date - INTERVAL '1 day')::DATE,
        rrule = metadata.modify_rrule_until(v_original.rrule, (p_split_date - INTERVAL '1 day')::DATE)
    WHERE id = p_series_id;

    -- Merge new template with original (preserves required fields like resource_id)
    -- JSONB || operator: right side takes precedence for duplicate keys
    IF p_new_template IS NOT NULL THEN
        p_new_template := v_original.entity_template || p_new_template;
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_new_template);
    END IF;

    -- Create new version
    INSERT INTO metadata.time_slot_series (
        group_id, version_number, effective_from, effective_until,
        entity_table, entity_template, rrule, dtstart, duration, timezone,
        time_slot_property, status, created_by
    ) VALUES (
        v_group_id,
        v_new_version,
        p_split_date,
        NULL,  -- Ongoing
        v_original.entity_table,
        COALESCE(p_new_template, v_original.entity_template),
        v_original.rrule,
        p_new_dtstart,
        COALESCE(p_new_duration, v_original.duration),
        v_original.timezone,
        v_original.time_slot_property,
        'active',
        v_user_id
    )
    RETURNING id INTO v_new_series_id;

    -- Re-link future instances to new series
    UPDATE metadata.time_slot_instances
    SET series_id = v_new_series_id
    WHERE series_id = p_series_id
      AND occurrence_date >= p_split_date;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Series split successfully',
        'original_series_id', p_series_id,
        'new_series_id', v_new_series_id,
        'group_id', v_group_id,
        'split_date', p_split_date
    );
END;
$$;

COMMENT ON FUNCTION public.split_series_from_date(BIGINT, DATE, TIMESTAMP, INTERVAL, JSONB) IS
    'Splits a series for "edit this and future" operations.
     Creates new version in same group, terminates original.
     Changed p_new_dtstart from TIMESTAMPTZ to TIMESTAMP in v0.39.0.';

GRANT EXECUTE ON FUNCTION public.split_series_from_date(BIGINT, DATE, TIMESTAMP, INTERVAL, JSONB) TO authenticated;


-- ============================================================================
-- Step 4: Replace update_series_schedule() with TIMESTAMP parameter
-- ============================================================================

DROP FUNCTION IF EXISTS public.update_series_schedule(BIGINT, TIMESTAMPTZ, INTERVAL, TEXT);

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
    -- effective_from = dtstart::DATE is now correct since dtstart is local wall-clock time
    UPDATE metadata.time_slot_series
    SET
        dtstart = p_dtstart,
        duration = p_duration,
        rrule = p_rrule,
        expanded_until = NULL,  -- Reset to trigger fresh expansion
        effective_from = p_dtstart::DATE
    WHERE id = p_series_id;

    -- Step 5: Calculate expansion horizon (90 days from TODAY, not dtstart)
    v_expand_until := (NOW() + INTERVAL '90 days')::DATE;

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

COMMENT ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT) IS
    'Updates series schedule (dtstart, duration, rrule) and regenerates instances.
     Deletes existing non-exception instances and entity records, then queues expansion.
     Requires creator, update permission, or admin.
     Changed p_dtstart from TIMESTAMPTZ to TIMESTAMP in v0.39.0.';

GRANT EXECUTE ON FUNCTION public.update_series_schedule(BIGINT, TIMESTAMP, INTERVAL, TEXT) TO authenticated;


-- ============================================================================
-- Step 5: Notify PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
