-- Revert civic_os:v0-86-3-split-invoker from pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Restores the v0.76.9 SECURITY DEFINER split_series_from_date(), which writes the edited occurrence with
-- definer rights, and drops metadata._split_series_from_date().

BEGIN;

CREATE OR REPLACE FUNCTION split_series_from_date(
  p_series_id bigint,
  p_split_date date,
  p_new_dtstart timestamp without time zone,
  p_new_duration interval DEFAULT NULL,
  p_new_template jsonb DEFAULT NULL,
  p_edited_entity_id bigint DEFAULT NULL,
  p_edited_values jsonb DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
AS $function$
DECLARE
    v_original RECORD;
    v_group_id BIGINT;
    v_new_version INT;
    v_new_series_id BIGINT;
    v_user_id UUID;
    v_count INT;
    v_consumed INT;
    v_future JSONB;
    v_shift INT := 0;
    v_last_before DATE;
    v_set_clause TEXT := '';
    v_key TEXT;
    v_value JSONB;
    v_status_cols TEXT[];
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

    -- The split rewrites existing records: the caller must be allowed to update them
    IF NOT has_permission(v_original.entity_table::text, 'update') AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:update permission', v_original.entity_table);
    END IF;

    -- A version that already ended was split before (e.g. a retried save): reload
    IF v_original.effective_until IS NOT NULL
       OR EXISTS (SELECT 1 FROM metadata.time_slot_series
                  WHERE group_id = v_original.group_id AND id <> p_series_id
                    AND effective_from = p_split_date) THEN
        RAISE EXCEPTION 'This series was already split on %', p_split_date
            USING HINT = 'Reload the record and edit the current version of the series';
    END IF;

    -- Splitting a version on (or before) its own first day would end it before it starts
    IF p_split_date <= v_original.effective_from THEN
        RAISE EXCEPTION 'This is the first occurrence of this version of the series'
            USING HINT = 'Change all occurrences instead';
    END IF;

    IF p_edited_entity_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date = p_split_date
          AND entity_table = v_original.entity_table AND entity_id = p_edited_entity_id
    ) THEN
        RAISE EXCEPTION 'Record % is not the occurrence of series % on %', p_edited_entity_id, p_series_id, p_split_date;
    END IF;

    -- Without BY* parts the pattern follows dtstart, so the following occurrences
    -- move by the edited occurrence's day offset (see apply_split_to_future_instances)
    IF v_original.rrule !~* '(^|;)BY[A-Z]+=' THEN
        v_shift := p_new_dtstart::date - p_split_date;
    END IF;
    IF v_shift < 0 THEN
        SELECT max(occurrence_date) INTO v_last_before
        FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date < p_split_date;
        IF v_last_before IS NOT NULL AND p_split_date + v_shift <= v_last_before THEN
            RAISE EXCEPTION 'Moving this occurrence to % would put it on or before the previous occurrence (%)',
                p_split_date + v_shift, v_last_before
                USING HINT = 'Move it to a later date, or change all occurrences instead';
        END IF;
    END IF;
    IF v_shift <> 0 AND EXISTS (
        SELECT 1 FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date > p_split_date
          AND is_exception AND entity_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Moving the following occurrences to another day would detach occurrences that were edited individually'
            USING HINT = 'Edit those occurrences individually, or change all occurrences instead';
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

    -- The new version keeps the original status: workflow never propagates via templates
    IF p_new_template IS NOT NULL THEN
        p_new_template := v_original.entity_template
            || metadata.strip_series_status_columns(v_original.entity_table, p_new_template)
            - 'time_slot' - v_original.time_slot_property::text;
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

    -- COUNT is a total for the whole series: the new version gets what is left after
    -- the occurrences before the split date (all expanded, since the split date is an
    -- expanded occurrence and expansion is contiguous from dtstart)
    v_count := substring(v_original.rrule FROM '(?i)(?:^|;)COUNT=(\d+)')::INT;
    IF v_count IS NOT NULL THEN
        SELECT count(*) INTO v_consumed
        FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date < p_split_date;

        UPDATE metadata.time_slot_series
        SET rrule = regexp_replace(rrule, '(?i)((?:^|;)COUNT=)\d+', '\1' || GREATEST(v_count - v_consumed, 1))
        WHERE id = v_new_series_id;
    END IF;

    -- Move the following non-exception occurrences onto the new schedule and template
    v_future := metadata.apply_split_to_future_instances(
        v_new_series_id, p_split_date, p_new_dtstart,
        COALESCE(p_new_duration, v_original.duration),
        COALESCE(p_new_template, v_original.entity_template),
        v_original.time_slot_property);

    -- Save the edited occurrence in the same transaction (atomic with the split)
    IF p_edited_entity_id IS NOT NULL AND p_edited_values IS NOT NULL AND p_edited_values <> '{}'::jsonb THEN
        PERFORM metadata.validate_entity_template(v_original.entity_table, p_edited_values - 'id');
        FOR v_key, v_value IN SELECT * FROM jsonb_each(p_edited_values - 'id')
        LOOP
            IF v_set_clause <> '' THEN v_set_clause := v_set_clause || ', '; END IF;
            v_set_clause := v_set_clause || format('%I = %L', v_key, v_value #>> '{}');
        END LOOP;
        PERFORM set_config('civic_os.series_write', 'on', true);
        EXECUTE format('UPDATE public.%I SET %s WHERE id = $1', v_original.entity_table, v_set_clause)
        USING p_edited_entity_id;
        PERFORM set_config('civic_os.series_write', 'off', true);

        -- A status change on this occurrence is its own, not the series': an exception
        v_status_cols := metadata.series_status_columns(v_original.entity_table);
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_edited_values) k WHERE k = ANY (v_status_cols)) THEN
            UPDATE metadata.time_slot_instances
            SET is_exception = TRUE, exception_type = 'modified', exception_at = NOW(), exception_by = v_user_id
            WHERE series_id = v_new_series_id AND entity_id = p_edited_entity_id;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE, 'original_series_id', p_series_id,
        'new_series_id', v_new_series_id, 'group_id', v_group_id,
        'split_date', p_split_date,
        'future_updated', v_future->'updated', 'future_conflicts', v_future->'conflicts',
        'edited_entity_id', p_edited_entity_id
    );
END;
$function$;

COMMENT ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb) IS NULL;

DROP FUNCTION metadata._split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb);

NOTIFY pgrst, 'reload schema';

COMMIT;
