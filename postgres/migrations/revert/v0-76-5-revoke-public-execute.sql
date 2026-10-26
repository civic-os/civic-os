-- Revert civic_os:v0-76-5-revoke-public-execute from pg
--
-- Restores PUBLIC EXECUTE on all functions, reverts _is_db_admin() to
-- current_user, and removes authorization guards from function bodies.
-- NOTE: This re-opens the security vulnerabilities fixed by the deploy.

BEGIN;

-- Remove the ALTER DEFAULT PRIVILEGES restriction.
-- Uses current_user so the revert works for managed-database admin roles
-- (doadmin, rdsadmin) that cannot ALTER DEFAULT PRIVILEGES FOR ROLE postgres.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
    current_user
  );
END;
$$;

-- Restore PUBLIC EXECUTE on all non-extension public functions
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure::text AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
          )
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.sig);
    END LOOP;
END;
$$;

-- Restore the exact pre-deploy ACLs (the blanket PUBLIC grant above leaves the default ACL; these
-- functions had explicit entries before v0-76-5, listed from the schema dump diff).
-- Functions that already had EXECUTE revoked from PUBLIC before v0-76-5:
REVOKE ALL ON FUNCTION public.add_gallery_image(p_entity_type name, p_entity_id text, p_column_name name, p_file_id uuid, p_sort_order integer, p_caption text, p_alt_text text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_gallery_image_by_id(p_gallery_id uuid, p_file_id uuid, p_sort_order integer, p_caption text, p_alt_text text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_guided_form_step(p_guided_form_key name, p_step_key name, p_display_name character varying, p_step_order integer, p_step_table name, p_parent_fk_column name, p_description text, p_can_skip boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_guided_form_step_condition(p_guided_form_key name, p_step_key name, p_condition_type text, p_field name, p_operator text, p_value text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_guided_form(p_guided_form_key name, p_parent_id bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_guided_form_step(p_guided_form_key name, p_parent_id bigint, p_step_key name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_draft_gallery(p_entity_type name, p_property_name name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_file_record(p_id uuid, p_entity_type text, p_entity_id text, p_file_name text, p_file_type text, p_file_size bigint, p_s3_bucket text, p_s3_original_key text, p_thumbnail_status text, p_property_name text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_category(p_category_id integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_category_group(p_entity_type text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_file_record(p_file_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_status(p_status_id integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_status_transition(p_transition_id integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_status_type(p_entity_type text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_guided_form_step_record(p_guided_form_key name, p_parent_id bigint, p_step_key name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_current_user_permissions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_entity_source_code(p_table_name name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_file_storage_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_gallery_storage_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_guided_form_context(p_guided_form_key name, p_table_name name, p_record_id bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_guided_form_progress(p_guided_form_key name, p_parent_id bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_missing_translations(p_target_locale text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_guided_form_permissions(p_guided_form_key name, p_role_id integer, p_permissions text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_gallery_to_entity(p_gallery_id uuid, p_entity_type name, p_entity_id text, p_column_name name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_guided_form_triggers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_guided_form(p_guided_form_key name, p_parent_table name, p_description text, p_on_submit_rpc name, p_parent_step_display_name character varying, p_review_intro_text text, p_lock_on_submit boolean, p_precondition_rpc name, p_ownership_column name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_gallery_image(p_gallery_id uuid, p_file_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reorder_gallery_images(p_gallery_id uuid, p_file_ids uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_guided_form(p_guided_form_key name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_guided_form(p_guided_form_key name, p_parent_id bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_gallery_image_meta(p_gallery_id uuid, p_file_id uuid, p_caption text, p_alt_text text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_category(p_entity_type text, p_display_name character varying, p_description text, p_color text, p_sort_order integer, p_category_id integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_category_group(p_entity_type text, p_description text, p_display_name text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_status(p_entity_type text, p_display_name character varying, p_description text, p_color text, p_sort_order integer, p_is_initial boolean, p_is_terminal boolean, p_status_id integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_status_transition(p_entity_type text, p_from_status_id integer, p_to_status_id integer, p_on_transition_rpc name, p_display_name character varying, p_description text, p_sort_order integer, p_is_enabled boolean, p_transition_id integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_status_type(p_entity_type text, p_description text, p_display_name text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_translations(p_translations jsonb) FROM PUBLIC;

-- Functions the deploy newly granted to authenticated (no explicit grant before v0-76-5):
REVOKE ALL ON FUNCTION public._all_steps_condition_skipped(p_guided_form_key name, p_parent_id bigint) FROM authenticated;
REVOKE ALL ON FUNCTION public._check_guided_form_complete(p_guided_form_key name, p_parent_id bigint) FROM authenticated;
REVOKE ALL ON FUNCTION public._gf_status_col(p_table_name name) FROM authenticated;
REVOKE ALL ON FUNCTION public.create_provisioned_user(p_email text, p_first_name text, p_last_name text, p_phone text, p_initial_roles text[], p_send_welcome_email boolean, p_send_welcome_sms boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.format_public_display_name(full_name text) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_manageable_roles() FROM authenticated;
REVOKE ALL ON FUNCTION public.get_role_can_manage(p_manager_role_id smallint) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_roles() FROM authenticated;

-- has_role: web_anon was granted before authenticated (ACL order is significant for exact dumps)
REVOKE EXECUTE ON FUNCTION has_role(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION has_role(uuid, text) TO web_anon;
GRANT EXECUTE ON FUNCTION has_role(uuid, text) TO authenticated;

-- Revert _is_db_admin() to current_user (the broken version)
-- Verbatim from deploy/v0-56-1-fix-managed-db-admin-guard.sql:26-34 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION metadata._is_db_admin()
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()                                          -- App-level JWT admin
    OR current_setting('is_superuser', true) = 'on'                 -- True PG superuser
    OR EXISTS (                                                      -- Managed DB admin
        SELECT 1 FROM pg_roles
        WHERE rolname = current_user AND rolcreaterole
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Revert cancel_series_occurrence() (remove auth/permission guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:863-913 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.cancel_series_occurrence(
    p_entity_table NAME,
    p_entity_id BIGINT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_instance RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get instance info
    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        -- Not part of a series, just delete normally
        EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_entity_table) USING p_entity_id;
        RETURN jsonb_build_object(
            'success', TRUE,
            'message', 'Record deleted (not part of a series)'
        );
    END IF;

    -- Mark junction as cancelled (keep row for history)
    UPDATE metadata.time_slot_instances
    SET
        entity_id = NULL,
        is_exception = TRUE,
        exception_type = 'cancelled',
        exception_reason = p_reason,
        exception_at = NOW(),
        exception_by = v_user_id
    WHERE id = v_instance.id;

    -- Delete the entity record
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_entity_table) USING p_entity_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Occurrence cancelled',
        'series_id', v_instance.series_id,
        'occurrence_date', v_instance.occurrence_date
    );
END;
$$;

-- Revert create_entity_note() (remove guards)
-- Verbatim from deploy/v0-16-0-add-entity-notes.sql:186-229 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.create_entity_note(
    p_entity_type NAME,
    p_entity_id TEXT,
    p_content TEXT,
    p_note_type VARCHAR DEFAULT 'note',
    p_is_internal BOOLEAN DEFAULT TRUE,
    p_author_id UUID DEFAULT NULL  -- NULL = current_user_id()
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_note_id BIGINT;
    v_author UUID;
BEGIN
    -- Determine author
    v_author := COALESCE(p_author_id, current_user_id());

    -- Validate entity type has notes enabled
    IF NOT EXISTS (
        SELECT 1 FROM metadata.entities
        WHERE table_name = p_entity_type AND enable_notes = TRUE
    ) THEN
        RAISE EXCEPTION 'Notes are not enabled for entity type: %', p_entity_type;
    END IF;

    -- Validate content not empty
    IF TRIM(p_content) = '' THEN
        RAISE EXCEPTION 'Note content cannot be empty';
    END IF;

    -- Insert note
    INSERT INTO metadata.entity_notes (
        entity_type, entity_id, author_id, content, note_type, is_internal
    ) VALUES (
        p_entity_type, p_entity_id, v_author, p_content, p_note_type, p_is_internal
    )
    RETURNING id INTO v_note_id;

    RETURN v_note_id;
END;
$$;

-- Revert preview_template_parts() (remove guards)
-- Verbatim from deploy/v0-11-0-add-notifications.sql:496-566 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION preview_template_parts(
    p_validation_id UUID DEFAULT gen_random_uuid(),
    p_subject_template TEXT DEFAULT NULL,
    p_html_template TEXT DEFAULT NULL,
    p_text_template TEXT DEFAULT NULL,
    p_sms_template TEXT DEFAULT NULL,
    p_sample_entity_data JSONB DEFAULT NULL
)
RETURNS TABLE(
    validation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Validate that at least one template part was provided
    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for preview';
    END IF;

    -- Default sample data if none provided
    IF p_sample_entity_data IS NULL THEN
        p_sample_entity_data := '{"display_name": "Example Entity", "id": 1}'::jsonb;
    END IF;

    -- Insert validation request (reuse same table)
    INSERT INTO metadata.template_validation_results (
        id,
        subject_template,
        html_template,
        text_template,
        sms_template,
        status
    )
    VALUES (
        p_validation_id,
        p_subject_template,
        p_html_template,
        p_text_template,
        p_sms_template,
        'pending'
    );

    -- Enqueue high-priority preview job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'preview_template_parts',
        jsonb_build_object(
            'validation_id', p_validation_id::text,
            'subject_template', p_subject_template,
            'html_template', p_html_template,
            'text_template', p_text_template,
            'sms_template', p_sms_template,
            'sample_entity_data', p_sample_entity_data
        ),
        'notifications',
        4,  -- HIGH PRIORITY (4 = highest)
        3,
        NOW(),
        'available'
    );

    -- Return validation_id immediately (non-blocking)
    RETURN QUERY SELECT p_validation_id;
END;
$$;

-- Revert validate_template_parts() (remove guards)
-- Verbatim from deploy/v0-11-0-add-notifications.sql:357-420 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION validate_template_parts(
    p_validation_id UUID DEFAULT gen_random_uuid(),
    p_subject_template TEXT DEFAULT NULL,
    p_html_template TEXT DEFAULT NULL,
    p_text_template TEXT DEFAULT NULL,
    p_sms_template TEXT DEFAULT NULL
)
RETURNS TABLE(
    validation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Validate that at least one template part was provided
    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for validation';
    END IF;

    -- Insert validation request
    INSERT INTO metadata.template_validation_results (
        id,
        subject_template,
        html_template,
        text_template,
        sms_template,
        status
    )
    VALUES (
        p_validation_id,
        p_subject_template,
        p_html_template,
        p_text_template,
        p_sms_template,
        'pending'
    );

    -- Enqueue high-priority validation job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'validate_template_parts',
        jsonb_build_object(
            'validation_id', p_validation_id::text,
            'subject_template', p_subject_template,
            'html_template', p_html_template,
            'text_template', p_text_template,
            'sms_template', p_sms_template
        ),
        'notifications',
        4,  -- HIGH PRIORITY (4 = highest, normal notifications are priority 1)
        3,
        NOW(),
        'available'
    );

    -- Return validation_id immediately (non-blocking)
    RETURN QUERY SELECT p_validation_id;
END;
$$;

-- Revert create_recurring_series() (remove guards)
-- Verbatim from deploy/v0-38-5-configurable-expand-horizon.sql:17-107 (last definition before v0-76-5).
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

-- Revert delete_series_group() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:1376-1423 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.delete_series_group(
    p_group_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_total_deleted INT := 0;
    v_result JSONB;
    v_group_exists BOOLEAN;
BEGIN
    -- Check if group exists
    SELECT EXISTS(
        SELECT 1 FROM metadata.time_slot_series_groups WHERE id = p_group_id
    ) INTO v_group_exists;

    IF NOT v_group_exists THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'message', format('Group %s not found', p_group_id),
            'group_id', p_group_id
        );
    END IF;

    -- Delete each series in the group
    FOR v_series IN
        SELECT id FROM metadata.time_slot_series WHERE group_id = p_group_id
    LOOP
        v_result := public.delete_series_with_instances(v_series.id);
        IF v_result->>'success' = 'true' THEN
            v_total_deleted := v_total_deleted + COALESCE((v_result->>'entities_deleted')::INT, 0);
        END IF;
    END LOOP;

    -- Group should be deleted via cascade when last series is deleted
    -- But ensure it's gone
    DELETE FROM metadata.time_slot_series_groups WHERE id = p_group_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Deleted group and %s entity records', v_total_deleted),
        'group_id', p_group_id,
        'entities_deleted', v_total_deleted
    );
END;
$$;

-- Revert delete_series_with_instances() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:1308-1363 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.delete_series_with_instances(
    p_series_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_entity_ids BIGINT[];
    v_deleted_count INT := 0;
BEGIN
    -- Get series info
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Collect all entity IDs
    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND entity_id IS NOT NULL;

    -- Delete entity records
    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format(
            'DELETE FROM public.%I WHERE id = ANY($1)',
            v_series.entity_table
        ) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Allow direct delete (bypass trigger)
    PERFORM set_config('recurring.allow_direct_delete', 'true', true);

    -- Delete series (cascades to instances via FK)
    DELETE FROM metadata.time_slot_series WHERE id = p_series_id;

    -- If this was the last series in the group, delete the group
    DELETE FROM metadata.time_slot_series_groups g
    WHERE g.id = v_series.group_id
      AND NOT EXISTS (
          SELECT 1 FROM metadata.time_slot_series s WHERE s.group_id = g.id
      );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Deleted series and %s entity records', v_deleted_count),
        'series_id', p_series_id,
        'entities_deleted', v_deleted_count
    );
END;
$$;

-- Revert expand_series_instances() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:805-850 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.expand_series_instances(
    p_series_id BIGINT,
    p_expand_until DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
BEGIN
    -- Get series
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Update expanded_until to signal worker
    UPDATE metadata.time_slot_series
    SET expanded_until = GREATEST(COALESCE(expanded_until, '1970-01-01'::DATE), p_expand_until)
    WHERE id = p_series_id;

    -- Queue River job (Go worker picks up and processes)
    -- Note: expand_until must be ISO8601 timestamp for Go parsing
    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available',
        'recurring',
        'expand_recurring_series',
        jsonb_build_object('series_id', p_series_id, 'expand_until', to_char(p_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        3,
        NOW(),
        NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Expansion queued',
        'series_id', p_series_id,
        'expand_until', p_expand_until
    );
END;
$$;

-- Revert reschedule_occurrence() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:2110-2167 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.reschedule_occurrence(
    p_entity_table NAME,
    p_entity_id BIGINT,
    p_new_time_slot TSTZRANGE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_instance RECORD;
    v_old_slot TSTZRANGE;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get instance info
    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        -- Not part of a series, just update directly
        EXECUTE format('UPDATE public.%I SET time_slot = $1 WHERE id = $2', p_entity_table)
        USING p_new_time_slot, p_entity_id;
        RETURN jsonb_build_object(
            'success', TRUE,
            'message', 'Time slot updated (not part of a series)'
        );
    END IF;

    -- Get current time_slot for audit trail
    EXECUTE format('SELECT time_slot FROM public.%I WHERE id = $1', p_entity_table)
    INTO v_old_slot USING p_entity_id;

    -- Update entity time slot
    EXECUTE format('UPDATE public.%I SET time_slot = $1 WHERE id = $2', p_entity_table)
    USING p_new_time_slot, p_entity_id;

    -- Mark as rescheduled exception (preserves history)
    UPDATE metadata.time_slot_instances
    SET is_exception = TRUE,
        exception_type = 'rescheduled',
        original_time_slot = v_old_slot,
        exception_at = NOW(),
        exception_by = v_user_id
    WHERE id = v_instance.id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Occurrence rescheduled',
        'series_id', v_instance.series_id,
        'occurrence_date', v_instance.occurrence_date,
        'original_time_slot', v_old_slot::TEXT,
        'new_time_slot', p_new_time_slot::TEXT
    );
END;
$$;

-- Revert preview_recurring_conflicts() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:598-688 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.preview_recurring_conflicts(
    p_entity_table NAME,
    p_scope_column NAME,           -- e.g., 'resource_id'
    p_scope_value TEXT,            -- e.g., '5'
    p_time_slot_column NAME,       -- e.g., 'time_slot'
    p_occurrences TIMESTAMPTZ[][]  -- Array of [start, end] pairs
)
RETURNS TABLE (
    occurrence_index INTEGER,
    occurrence_start TIMESTAMPTZ,
    occurrence_end TIMESTAMPTZ,
    has_conflict BOOLEAN,
    conflicting_id BIGINT,
    conflicting_display TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_idx INTEGER := 0;
    v_start TIMESTAMPTZ;
    v_end TIMESTAMPTZ;
    v_slot TSTZRANGE;
    v_query TEXT;
    v_conflict RECORD;
    v_scope_type TEXT;
BEGIN
    -- Get the column type for proper casting
    SELECT data_type INTO v_scope_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_entity_table
      AND column_name = p_scope_column;

    -- Build dynamic query for conflict detection
    FOR v_idx IN 1..array_length(p_occurrences, 1)
    LOOP
        v_start := p_occurrences[v_idx][1];
        v_end := p_occurrences[v_idx][2];
        v_slot := tstzrange(v_start, v_end, '[)');

        -- Check for overlapping records (cast scope_value to the column type)
        v_query := format(
            'SELECT id, COALESCE(display_name, ''#'' || id::text) as display_name
             FROM public.%I
             WHERE %I = $1::%s AND %I && $2
             LIMIT 1',
            p_entity_table,
            p_scope_column,
            COALESCE(v_scope_type, 'text'),
            p_time_slot_column
        );

        BEGIN
            EXECUTE v_query INTO v_conflict USING p_scope_value, v_slot;

            occurrence_index := v_idx;
            occurrence_start := v_start;
            occurrence_end := v_end;

            IF v_conflict.id IS NOT NULL THEN
                has_conflict := TRUE;
                conflicting_id := v_conflict.id;
                conflicting_display := v_conflict.display_name;
            ELSE
                has_conflict := FALSE;
                conflicting_id := NULL;
                conflicting_display := NULL;
            END IF;

            RETURN NEXT;
        EXCEPTION WHEN undefined_column THEN
            -- If display_name doesn't exist, try without it
            v_query := format(
                'SELECT id FROM public.%I WHERE %I = $1::%s AND %I && $2 LIMIT 1',
                p_entity_table, p_scope_column, COALESCE(v_scope_type, 'text'), p_time_slot_column
            );
            EXECUTE v_query INTO v_conflict USING p_scope_value, v_slot;

            occurrence_index := v_idx;
            occurrence_start := v_start;
            occurrence_end := v_end;
            has_conflict := v_conflict.id IS NOT NULL;
            conflicting_id := v_conflict.id;
            conflicting_display := CASE WHEN v_conflict.id IS NOT NULL THEN '#' || v_conflict.id::text END;
            RETURN NEXT;
        END;
    END LOOP;
END;
$$;

-- Revert split_series_from_date() (remove guards)
-- Verbatim from deploy/v0-38-5-recurring-dtstart-local-time.sql:256-357 (last definition before v0-76-5).
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

-- Revert update_series_group_info() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:1135-1184 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.update_series_group_info(
    p_group_id BIGINT,
    p_display_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_color TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_group RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := public.current_user_id();

    -- Get group
    SELECT * INTO v_group
    FROM metadata.time_slot_series_groups
    WHERE id = p_group_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Group not found');
    END IF;

    -- Check permissions (creator or has update permission or admin)
    IF NOT (
        v_group.created_by = v_user_id
        OR public.has_permission('time_slot_series_groups', 'update')
        OR public.is_admin()
    ) THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Permission denied');
    END IF;

    -- Update group
    UPDATE metadata.time_slot_series_groups
    SET
        display_name = COALESCE(NULLIF(TRIM(p_display_name), ''), display_name),
        description = p_description,
        color = p_color,
        updated_at = NOW()
    WHERE id = p_group_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Group updated',
        'group_id', p_group_id
    );
END;
$$;

-- Revert update_series_schedule() (remove guards)
-- Verbatim from deploy/v0-38-5-configurable-expand-horizon.sql:125-222 (last definition before v0-76-5).
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

-- Revert update_series_template() (remove guards)
-- Verbatim from deploy/v0-19-0-add-recurring-timeslot.sql:1041-1122 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.update_series_template(
    p_series_id BIGINT,
    p_new_template JSONB,
    p_skip_exceptions BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_updated_count INT := 0;
    v_instance RECORD;
    v_set_clause TEXT;
    v_key TEXT;
    v_value JSONB;
BEGIN
    v_user_id := public.current_user_id();

    -- Get series
    SELECT * INTO v_series
    FROM metadata.time_slot_series
    WHERE id = p_series_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    -- Merge new template with original (preserves required fields like resource_id)
    -- JSONB || operator: right side takes precedence for duplicate keys
    p_new_template := v_series.entity_template || p_new_template;

    -- Validate merged template
    PERFORM metadata.validate_entity_template(v_series.entity_table, p_new_template);

    -- Update series template
    UPDATE metadata.time_slot_series
    SET
        entity_template = p_new_template,
        template_updated_at = NOW(),
        template_updated_by = v_user_id
    WHERE id = p_series_id;

    -- Build dynamic SET clause for entity updates
    v_set_clause := '';
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_new_template)
    LOOP
        IF v_key != 'time_slot' THEN
            IF v_set_clause != '' THEN
                v_set_clause := v_set_clause || ', ';
            END IF;
            v_set_clause := v_set_clause || format('%I = %L', v_key, v_value #>> '{}');
        END IF;
    END LOOP;

    -- Update non-exception entity records
    IF v_set_clause != '' THEN
        FOR v_instance IN
            SELECT entity_id
            FROM metadata.time_slot_instances
            WHERE series_id = p_series_id
              AND entity_id IS NOT NULL
              AND (NOT p_skip_exceptions OR NOT is_exception)
        LOOP
            EXECUTE format(
                'UPDATE public.%I SET %s WHERE id = $1',
                v_series.entity_table,
                v_set_clause
            ) USING v_instance.entity_id;
            v_updated_count := v_updated_count + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Updated %s instances', v_updated_count),
        'series_id', p_series_id,
        'instances_updated', v_updated_count
    );
END;
$$;

-- Revert enable_entity_notes() (remove guards)
-- Verbatim from deploy/v0-16-0-add-entity-notes.sql:243-280 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION public.enable_entity_notes(p_entity_type NAME)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Enable notes flag (upsert pattern)
    INSERT INTO metadata.entities (table_name, enable_notes)
    VALUES (p_entity_type, TRUE)
    ON CONFLICT (table_name) DO UPDATE SET enable_notes = TRUE;

    -- Create permissions (table_name stores virtual entity like 'issues:notes')
    INSERT INTO metadata.permissions (table_name, permission)
    VALUES
        (p_entity_type || ':notes', 'read'),
        (p_entity_type || ':notes', 'create')
    ON CONFLICT DO NOTHING;

    -- Grant read+create to editor role
    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.table_name = p_entity_type || ':notes'
      AND r.display_name = 'editor'
    ON CONFLICT DO NOTHING;

    -- Grant read to user role
    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.table_name = p_entity_type || ':notes'
      AND p.permission = 'read'
      AND r.display_name = 'user'
    ON CONFLICT DO NOTHING;
END;
$$;

-- Revert request_upload_url() (remove guards)
-- Verbatim from deploy/v0-5-0-add-file-storage.sql:195-223 (last definition before v0-76-5).
CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_file_name TEXT,
  p_file_type TEXT
) RETURNS UUID AS $$
DECLARE
  v_request_id UUID;
BEGIN
  -- Create tracking record
  INSERT INTO metadata.file_upload_requests (entity_type, entity_id, file_name, file_type)
  VALUES (p_entity_type, p_entity_id, p_file_name, p_file_type)
  RETURNING id INTO v_request_id;

  -- Notify S3 signer service to generate presigned URL
  PERFORM pg_notify(
    'upload_url_request',
    json_build_object(
      'requestId', v_request_id,
      'fileName', p_file_name,
      'fileType', p_file_type,
      'entityType', p_entity_type,
      'entityId', p_entity_id
    )::text
  );

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revert get_upload_url (remove auth guard)
CREATE OR REPLACE FUNCTION get_upload_url(p_request_id uuid)
RETURNS TABLE(status text, url text, file_id uuid, error text) AS $$
  SELECT status, presigned_url, file_id, error_message
  FROM metadata.file_upload_requests
  WHERE id = p_request_id;
$$ LANGUAGE SQL SECURITY DEFINER;

-- Revert admin_get_user_bulk_subscriptions (remove permission guard)
CREATE OR REPLACE FUNCTION admin_get_user_bulk_subscriptions(p_user_id uuid)
 RETURNS TABLE(template_name character varying, template_description text, unsubscribed boolean, last_sent_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
    SELECT
        ntt.template_name,
        COALESCE(nt.description, ntt.template_name),
        BOOL_OR(ntt.unsubscribed),
        MAX(ntt.created_at)
    FROM metadata.notification_tracking_tokens ntt
    JOIN metadata.civic_os_users_private cup ON cup.email = ntt.recipient_email
    LEFT JOIN metadata.notification_templates nt ON nt.name = ntt.template_name AND nt.is_bulk = TRUE
    WHERE cup.id = p_user_id
      AND nt.is_bulk = TRUE
    GROUP BY ntt.template_name, nt.description
    ORDER BY MAX(ntt.created_at) DESC;
$function$;

-- All function bodies replaced by the deploy are restored verbatim above from their
-- last pre-v0-76-5 definitions.

-- Remove schema decision
DELETE FROM metadata.schema_decisions
WHERE migration_id = 'v0-76-5-revoke-public-execute';

NOTIFY pgrst, 'reload schema';

COMMIT;
