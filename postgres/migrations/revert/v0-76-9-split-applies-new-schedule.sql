-- Revert civic_os:v0-76-9-split-applies-new-schedule
--
-- Restores split_series_from_date (5 parameters, v0.76.9 occurrence-date version),
-- update_series_template as of v0.76.5, and removes the
-- edit trigger, the timezone check and the helpers. Exception flags recorded by the
-- edit trigger or the one-time drift check stay (they describe real edits).

BEGIN;

DROP FUNCTION IF EXISTS split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb, bigint, jsonb);

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

CREATE OR REPLACE FUNCTION update_series_template(
  p_series_id bigint,
  p_new_template jsonb,
  p_skip_exceptions boolean DEFAULT true
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_updated_count INT := 0;
    v_instance RECORD;
    v_set_clause TEXT;
    v_key TEXT;
    v_value JSONB;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL AND NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series_groups
        WHERE id = v_series.group_id
          AND (created_by = v_user_id OR is_admin() OR metadata._is_db_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    p_new_template := v_series.entity_template || p_new_template;
    PERFORM metadata.validate_entity_template(v_series.entity_table, p_new_template);

    UPDATE metadata.time_slot_series
    SET entity_template = p_new_template,
        template_updated_at = NOW(),
        template_updated_by = v_user_id
    WHERE id = p_series_id;

    v_set_clause := '';
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_new_template)
    LOOP
        IF v_key != 'time_slot' THEN
            IF v_set_clause != '' THEN v_set_clause := v_set_clause || ', '; END IF;
            v_set_clause := v_set_clause || format('%I = %L', v_key, v_value #>> '{}');
        END IF;
    END LOOP;

    IF v_set_clause != '' THEN
        FOR v_instance IN
            SELECT entity_id FROM metadata.time_slot_instances
            WHERE series_id = p_series_id AND entity_id IS NOT NULL
              AND (NOT p_skip_exceptions OR NOT is_exception)
        LOOP
            EXECUTE format('UPDATE public.%I SET %s WHERE id = $1', v_series.entity_table, v_set_clause)
            USING v_instance.entity_id;
            v_updated_count := v_updated_count + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'message', format('Template updated, %s records modified', v_updated_count),
        'series_id', p_series_id, 'records_updated', v_updated_count);
END;
$function$;

REVOKE EXECUTE ON FUNCTION update_series_template(bigint, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_series_template(bigint, jsonb, boolean) TO authenticated;


DO $$
DECLARE
    v_table regclass;
BEGIN
    FOR v_table IN SELECT tgrelid::regclass FROM pg_trigger WHERE tgname = 'zz_time_slot_series_instance_modified'
    LOOP
        EXECUTE format('DROP TRIGGER zz_time_slot_series_instance_modified ON %s', v_table);
    END LOOP;
END $$;

DROP TRIGGER IF EXISTS attach_series_modified_trigger ON metadata.time_slot_series;
DROP FUNCTION IF EXISTS metadata.attach_series_modified_trigger();
DROP TRIGGER IF EXISTS validate_series_timezone ON metadata.time_slot_series;
DROP FUNCTION IF EXISTS metadata.validate_series_timezone();
DROP FUNCTION IF EXISTS metadata.apply_split_to_future_instances(bigint, date, timestamp without time zone, interval, jsonb, text);
DROP FUNCTION IF EXISTS metadata.ensure_series_modified_trigger(name);
DROP FUNCTION IF EXISTS metadata.mark_series_instance_modified();
DROP FUNCTION IF EXISTS metadata.strip_series_status_columns(name, jsonb);
DROP FUNCTION IF EXISTS metadata.series_status_columns(name);

NOTIFY pgrst, 'reload schema';

COMMIT;
