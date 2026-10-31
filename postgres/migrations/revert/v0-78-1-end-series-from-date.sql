-- Revert civic_os:v0-78-1-end-series-from-date
--
-- Drops end_series_from_date and restores delete_series_with_instances,
-- delete_series_group and cancel_series_occurrence as of v0.76.5 (owner or admin
-- only, no search_path). Records the function deleted stay deleted.

BEGIN;

DROP FUNCTION IF EXISTS end_series_from_date(bigint, date);

CREATE OR REPLACE FUNCTION delete_series_with_instances(p_series_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_series RECORD;
    v_entity_ids BIGINT[];
    v_deleted_count INT := 0;
BEGIN
    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series_groups
        WHERE id = v_series.group_id
          AND (created_by = current_user_id() OR is_admin() OR metadata._is_db_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND entity_id IS NOT NULL;

    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format('DELETE FROM public.%I WHERE id = ANY($1)', v_series.entity_table) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    PERFORM set_config('recurring.allow_direct_delete', 'true', true);
    DELETE FROM metadata.time_slot_series WHERE id = p_series_id;

    DELETE FROM metadata.time_slot_series_groups g
    WHERE g.id = v_series.group_id
      AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_series s WHERE s.group_id = g.id);

    RETURN jsonb_build_object('success', TRUE, 'message', format('Deleted series and %s entity records', v_deleted_count),
        'series_id', p_series_id, 'entities_deleted', v_deleted_count);
END;
$function$;

CREATE OR REPLACE FUNCTION delete_series_group(p_group_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_series RECORD;
    v_total_deleted INT := 0;
    v_result JSONB;
    v_group RECORD;
BEGIN
    SELECT * INTO v_group
    FROM metadata.time_slot_series_groups WHERE id = p_group_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', format('Group %s not found', p_group_id), 'group_id', p_group_id);
    END IF;

    IF NOT (v_group.created_by = current_user_id() OR is_admin() OR metadata._is_db_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series group owner or an admin';
    END IF;

    FOR v_series IN SELECT id FROM metadata.time_slot_series WHERE group_id = p_group_id
    LOOP
        v_result := delete_series_with_instances(v_series.id);
        IF v_result->>'success' = 'true' THEN
            v_total_deleted := v_total_deleted + COALESCE((v_result->>'entities_deleted')::INT, 0);
        END IF;
    END LOOP;

    DELETE FROM metadata.time_slot_series_groups WHERE id = p_group_id;

    RETURN jsonb_build_object('success', TRUE, 'message', format('Deleted group and %s entity records', v_total_deleted),
        'group_id', p_group_id, 'entities_deleted', v_total_deleted);
END;
$function$;

CREATE OR REPLACE FUNCTION cancel_series_occurrence(
  p_entity_table name,
  p_entity_id bigint,
  p_reason text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_instance RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        IF NOT has_permission(p_entity_table::text, 'delete') AND NOT metadata._is_db_admin() THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = format('Requires %s:delete permission', p_entity_table);
        END IF;
        EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_entity_table) USING p_entity_id;
        RETURN jsonb_build_object('success', TRUE, 'message', 'Record deleted (not part of a series)');
    END IF;

    -- Check series ownership or admin
    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series s
        JOIN metadata.time_slot_series_groups g ON g.id = s.group_id
        WHERE s.id = v_instance.series_id
          AND (g.created_by = v_user_id OR is_admin() OR metadata._is_db_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    UPDATE metadata.time_slot_instances
    SET entity_id = NULL,
        is_exception = TRUE,
        exception_type = 'cancelled',
        exception_reason = p_reason,
        exception_at = NOW(),
        exception_by = v_user_id
    WHERE id = v_instance.id;

    EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_entity_table) USING p_entity_id;

    RETURN jsonb_build_object(
        'success', TRUE, 'message', 'Occurrence cancelled',
        'series_id', v_instance.series_id, 'occurrence_date', v_instance.occurrence_date
    );
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
