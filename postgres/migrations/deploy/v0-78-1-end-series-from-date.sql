-- Deploy civic_os:v0-78-1-end-series-from-date
-- Requires: v0-77-2-about-core-version-label
--
-- v0.78.1 -- "Delete this and following occurrences" ends the series.
--
-- 1. end_series_from_date(p_series_id, p_occurrence_date) ends a series at one of
--    its occurrences and hard-deletes every record of the series from that date on,
--    in one transaction: this version's records from the date (occurrences edited
--    individually included), every later version of the group and its records, and
--    the version itself when the date is its first day (then the group, if empty).
--    Otherwise the version's rule ends the day before, as a split does
--    (effective_until and the RRULE's UNTIL, which is what bounds the worker's
--    expansion). A foreign key that restricts deleting one of the records aborts
--    the whole call. The bound is the stored occurrence_date (the series-local
--    date), never a time comparison. Until now the Detail page sent
--    cancel_series_occurrence for this scope, which cancels one occurrence only.
--
-- SECURITY: the series delete RPCs are SECURITY DEFINER and delete entity records
-- with definer rights behind an owner-or-admin check, so a series owner WITHOUT
-- delete permission on the entity table could delete its records (v0.76.9 closed
-- the same gap for update). end_series_from_date, delete_series_with_instances,
-- delete_series_group and cancel_series_occurrence (series members too) now
-- require has_permission(entity_table, 'delete') and set search_path.
-- delete_series_with_instances also accepts the series' own created_by when the
-- series has no group (it denied everyone, admins included, before).

BEGIN;

CREATE FUNCTION end_series_from_date(
  p_series_id bigint,
  p_occurrence_date date
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
AS $function$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_later BIGINT[];
    v_entity_ids BIGINT[];
    v_entities_deleted INT := 0;
    v_versions_deleted INT := 0;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Occurrence dates of this group the v0.76.9 conversion could not decide
    IF EXISTS (
        SELECT 1 FROM metadata.time_slot_instance_date_repair r
        JOIN metadata.time_slot_series g ON g.id = r.series_id
        WHERE r.status = 'unresolved'
          AND (g.id = p_series_id OR (v_series.group_id IS NOT NULL AND g.group_id = v_series.group_id))
    ) THEN
        RAISE EXCEPTION 'The dates of this series need attention'
            USING HINT = 'An administrator must resolve them first (metadata.time_slot_instance_date_repair, status unresolved)';
    END IF;

    -- Check series ownership or admin (use group or fallback to series created_by)
    IF v_series.group_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.time_slot_series_groups
            WHERE id = v_series.group_id
              AND (created_by = v_user_id OR is_admin() OR metadata._is_db_admin())
        ) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    ELSE
        IF NOT (v_series.created_by = v_user_id OR is_admin() OR metadata._is_db_admin()) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    END IF;

    -- The call deletes existing records: the caller must be allowed to delete them
    IF NOT has_permission(v_series.entity_table::text, 'delete') AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:delete permission', v_series.entity_table);
    END IF;

    -- A version that ended before the date was split since the page loaded
    IF v_series.effective_until IS NOT NULL AND p_occurrence_date > v_series.effective_until THEN
        RAISE EXCEPTION 'This version of the series ended on %', v_series.effective_until
            USING HINT = 'Reload the record and delete from the current version of the series';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_instances
        WHERE series_id = p_series_id AND occurrence_date = p_occurrence_date
    ) THEN
        RAISE EXCEPTION 'Series % has no occurrence on %', p_series_id, p_occurrence_date;
    END IF;

    IF v_series.group_id IS NOT NULL THEN
        SELECT array_agg(id) INTO v_later
        FROM metadata.time_slot_series
        WHERE group_id = v_series.group_id AND id <> p_series_id
          AND effective_from > p_occurrence_date;
    END IF;

    -- Every version of a group shares the entity table (splits copy it)
    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE entity_id IS NOT NULL
      AND ((series_id = p_series_id AND occurrence_date >= p_occurrence_date)
           OR series_id = ANY (COALESCE(v_later, '{}')));

    IF v_entity_ids IS NOT NULL THEN
        EXECUTE format('DELETE FROM public.%I WHERE id = ANY($1)', v_series.entity_table) USING v_entity_ids;
        GET DIAGNOSTICS v_entities_deleted = ROW_COUNT;
    END IF;

    DELETE FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND occurrence_date >= p_occurrence_date;

    PERFORM set_config('recurring.allow_direct_delete', 'true', true);

    IF v_later IS NOT NULL THEN
        DELETE FROM metadata.time_slot_series WHERE id = ANY (v_later);
        GET DIAGNOSTICS v_versions_deleted = ROW_COUNT;
    END IF;

    IF p_occurrence_date <= v_series.effective_from THEN
        DELETE FROM metadata.time_slot_series WHERE id = p_series_id;
        v_versions_deleted := v_versions_deleted + 1;

        DELETE FROM metadata.time_slot_series_groups g
        WHERE g.id = v_series.group_id
          AND NOT EXISTS (SELECT 1 FROM metadata.time_slot_series s WHERE s.group_id = g.id);
    ELSE
        UPDATE metadata.time_slot_series
        SET effective_until = (p_occurrence_date - INTERVAL '1 day')::DATE,
            rrule = metadata.modify_rrule_until(v_series.rrule, (p_occurrence_date - INTERVAL '1 day')::DATE)
        WHERE id = p_series_id;
    END IF;

    PERFORM set_config('recurring.allow_direct_delete', 'false', true);

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Deleted %s records from %s on', v_entities_deleted, p_occurrence_date),
        'series_id', p_series_id,
        'group_id', v_series.group_id,
        'entities_deleted', v_entities_deleted,
        'versions_deleted', v_versions_deleted
    );
END;
$function$;

COMMENT ON FUNCTION end_series_from_date(bigint, date) IS
    'Ends a recurring series at one of its occurrences and deletes every record of the
     series from that date on (later versions included), in one transaction. Requires
     series ownership or admin, and delete permission on the entity table.
     Added in v0.78.1.';

REVOKE EXECUTE ON FUNCTION end_series_from_date(bigint, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_series_from_date(bigint, date) TO authenticated;

-- ----------------------------------------------------------------------------
-- delete_series_with_instances: series owner or admin, and entity delete permission
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delete_series_with_instances(p_series_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
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

    IF v_series.group_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.time_slot_series_groups
            WHERE id = v_series.group_id
              AND (created_by = current_user_id() OR is_admin() OR metadata._is_db_admin())
        ) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    ELSE
        IF NOT (v_series.created_by = current_user_id() OR is_admin() OR metadata._is_db_admin()) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    END IF;

    IF NOT has_permission(v_series.entity_table::text, 'delete') AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:delete permission', v_series.entity_table);
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

-- ----------------------------------------------------------------------------
-- delete_series_group: series owner or admin, and entity delete permission
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delete_series_group(p_group_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
AS $function$
DECLARE
    v_series RECORD;
    v_total_deleted INT := 0;
    v_result JSONB;
    v_group RECORD;
    v_table NAME;
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

    FOR v_table IN SELECT DISTINCT entity_table FROM metadata.time_slot_series WHERE group_id = p_group_id
    LOOP
        IF NOT has_permission(v_table::text, 'delete') AND NOT metadata._is_db_admin() THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = format('Requires %s:delete permission', v_table);
        END IF;
    END LOOP;

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

-- ----------------------------------------------------------------------------
-- cancel_series_occurrence: entity delete permission for every record, members too
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cancel_series_occurrence(
  p_entity_table name,
  p_entity_id bigint,
  p_reason text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, metadata, postgis
AS $function$
DECLARE
    v_instance RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT has_permission(p_entity_table::text, 'delete') AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:delete permission', p_entity_table);
    END IF;

    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
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
