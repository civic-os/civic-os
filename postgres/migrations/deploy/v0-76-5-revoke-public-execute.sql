-- Deploy civic_os:v0-76-5-revoke-public-execute to pg
-- requires: v0-76-0-maintenance-mode
--
-- Security hotfix: revoke default PUBLIC EXECUTE on non-anonymous functions,
-- add authorization guards to unguarded SECURITY DEFINER RPCs, fix
-- metadata._is_db_admin(), and set ALTER DEFAULT PRIVILEGES for the future.

BEGIN;

-- ===========================================================================
-- 1. ALTER DEFAULT PRIVILEGES
-- ===========================================================================
-- Functions created by 'postgres' from now on will NOT receive PUBLIC EXECUTE.
-- CREATE OR REPLACE on existing functions keeps their current ACL.
-- Caveat: extension functions created after this also lose PUBLIC; document
-- that CREATE EXTENSION should be followed by an explicit GRANT if needed.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ===========================================================================
-- 2. REVOKE EXECUTE FROM PUBLIC — authenticated-only functions
-- ===========================================================================
-- These functions should only be callable by logged-in users. Most already
-- have GRANT ... TO authenticated; we revoke PUBLIC so web_anon can't call
-- them via PostgREST.

-- File storage
REVOKE EXECUTE ON FUNCTION request_upload_url(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_upload_url(uuid) FROM PUBLIC;

-- Recurring series
REVOKE EXECUTE ON FUNCTION cancel_series_occurrence(name, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_recurring_series(text, text, text, name, jsonb, text, timestamp without time zone, interval, text, name, boolean, boolean, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_series_group(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_series_with_instances(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION expand_series_instances(bigint, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION preview_recurring_conflicts(name, name, text, name, timestamp with time zone[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reschedule_occurrence(name, bigint, tstzrange) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION split_series_from_date(bigint, date, timestamp without time zone, interval, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_series_group_info(bigint, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_series_schedule(bigint, timestamp without time zone, interval, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_series_template(bigint, jsonb, boolean) FROM PUBLIC;

-- Notes
REVOKE EXECUTE ON FUNCTION create_entity_note(name, text, text, character varying, boolean, uuid) FROM PUBLIC;

-- Notifications
REVOKE EXECUTE ON FUNCTION create_notification(uuid, character varying, character varying, character varying, jsonb, text[]) FROM PUBLIC;

-- Template validation/preview
REVOKE EXECUTE ON FUNCTION preview_template_parts(uuid, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_template_parts(uuid, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_preview_results(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_validation_results(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cleanup_old_validation_results() FROM PUBLIC;

-- Notes enablement (integrator setup, but has app/MCP callers)
REVOKE EXECUTE ON FUNCTION enable_entity_notes(name) FROM PUBLIC;

-- User management
REVOKE EXECUTE ON FUNCTION admin_get_user_bulk_subscriptions(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_get_user_notification_preferences(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_set_bulk_email_unsubscribe(uuid, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_update_notification_preference(uuid, text, boolean, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assign_user_role(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bulk_provision_users(json) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_provisioned_user(text, text, text, text, text[], boolean, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION retry_user_provisioning(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION revoke_user_role(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_user_info(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION has_role(uuid, text) FROM PUBLIC;

-- Roles and permissions
REVOKE EXECUTE ON FUNCTION can_manage_role(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_role(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_role(smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_admin_audit_log(text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_entity_action_roles(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_manageable_roles() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_real_user_roles() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_role_can_manage(smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_role_permissions(smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_roles() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION grant_entity_action_permission(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION is_real_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION revoke_entity_action_permission(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_role_can_manage(smallint, smallint, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_role_permission(smallint, text, text, boolean) FROM PUBLIC;

-- Metadata management
REVOKE EXECUTE ON FUNCTION add_property_change_trigger(name, name, text, name, character varying, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_status_transition(text, text, text, name, character varying, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_entity_sort_order(name, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_property_sort_order(name, name, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_entity_metadata(name, text, text, integer, text[], boolean, text, boolean, text, text, boolean, boolean, text, boolean, text, name, name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_property_metadata(name, name, text, text, integer, integer, boolean, boolean, boolean, boolean, boolean, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_property_metadata(name, name, text, text, integer, integer, boolean, boolean, boolean, boolean, boolean, boolean, boolean, name, name) FROM PUBLIC;

-- Status/category admin
REVOKE EXECUTE ON FUNCTION get_category_entity_types() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_status_entity_types() FROM PUBLIC;

-- Payment
REVOKE EXECUTE ON FUNCTION create_payment_intent_sync(numeric, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION initiate_payment_refund(uuid, numeric, text) FROM PUBLIC;

-- Profile
REVOKE EXECUTE ON FUNCTION get_own_profile() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_own_profile(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION refresh_current_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_user_locale(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_user_bulk_subscriptions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_bulk_email_unsubscribe(text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION log_impersonation(text[], text) FROM PUBLIC;

-- Guided forms
REVOKE EXECUTE ON FUNCTION _all_steps_condition_skipped(name, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION _check_guided_form_complete(name, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION _gf_status_col(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cancel_guided_form(name, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_guided_form_step(name, bigint, name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_guided_form_step_record(name, bigint, name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_guided_form_context(name, name, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_guided_form_progress(name, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION start_guided_form(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_guided_form(name, bigint) FROM PUBLIC;

-- Gallery
REVOKE EXECUTE ON FUNCTION add_gallery_image(name, text, name, uuid, integer, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_gallery_image_by_id(uuid, uuid, integer, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_draft_gallery(name, name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION link_gallery_to_entity(uuid, name, text, name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION remove_gallery_image(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reorder_gallery_images(uuid, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_gallery_image_meta(uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_file_storage_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_gallery_storage_stats() FROM PUBLIC;

-- File management
REVOKE EXECUTE ON FUNCTION create_file_record(uuid, text, text, text, text, bigint, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_file_record(uuid) FROM PUBLIC;

-- Status/category CRUD
REVOKE EXECUTE ON FUNCTION delete_category(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_category_group(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_status(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_status_transition(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_status_type(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_category(text, character varying, text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_category_group(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_status(text, character varying, text, text, integer, boolean, boolean, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_status_transition(text, integer, integer, name, character varying, text, integer, boolean, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_status_type(text, text, text) FROM PUBLIC;

-- Translations
REVOKE EXECUTE ON FUNCTION get_missing_translations(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upsert_translations(jsonb) FROM PUBLIC;

-- System
REVOKE EXECUTE ON FUNCTION get_entity_source_code(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_current_user_permissions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION trigger_scheduled_job(character varying) FROM PUBLIC;

-- ===========================================================================
-- 3. REVOKE EXECUTE FROM PUBLIC — internal-only functions
-- ===========================================================================
-- These are trigger functions, worker-only helpers, or integrator setup
-- functions that no API role should call directly.

-- Trigger functions
REVOKE EXECUTE ON FUNCTION add_status_change_note() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enqueue_notification_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION insert_s3_presign_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION insert_thumbnail_job() FROM PUBLIC;
-- NOTE: notify_issue_created() and notify_issue_status_changed() are
-- pothole example functions, not core. Revoked in the example trailing script.
REVOKE EXECUTE ON FUNCTION set_created_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_file_created_by() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_category_entity_type() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_status_entity_type() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_default_notification_preferences() FROM PUBLIC;

-- Integrator setup (run as postgres in init scripts/migrations)
REVOKE EXECUTE ON FUNCTION register_guided_form(name, name, text, name, character varying, text, boolean, name, name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_guided_form_step(name, name, character varying, integer, name, name, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_guided_form_step_condition(name, name, text, name, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION grant_guided_form_permissions(name, integer, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rebuild_guided_form_triggers() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ensure_table_permissions(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_role_key(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_schema_decision(text, text, name[], name[], text, text, text, text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_m2m_options_source_rpcs() FROM PUBLIC;

-- Worker-only
REVOKE EXECUTE ON FUNCTION create_payment_intent_sync(numeric, text) FROM PUBLIC;

-- Also revoke web_anon where it was explicitly granted but shouldn't be
REVOKE EXECUTE ON FUNCTION has_role(uuid, text) FROM web_anon;
REVOKE EXECUTE ON FUNCTION get_series_membership(name, bigint) FROM web_anon;

-- ===========================================================================
-- 4. GRANT to authenticated — ensure all authenticated functions have it
-- ===========================================================================
-- Many already have this grant; these ensure completeness.

GRANT EXECUTE ON FUNCTION _all_steps_condition_skipped(name, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION _check_guided_form_complete(name, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION _gf_status_col(name) TO authenticated;
GRANT EXECUTE ON FUNCTION create_provisioned_user(text, text, text, text, text[], boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION enable_entity_notes(name) TO authenticated;
GRANT EXECUTE ON FUNCTION format_public_display_name(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_category_entity_types() TO authenticated;
GRANT EXECUTE ON FUNCTION get_entity_action_roles(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_manageable_roles() TO authenticated;
GRANT EXECUTE ON FUNCTION get_role_can_manage(smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION get_roles() TO authenticated;
GRANT EXECUTE ON FUNCTION get_status_entity_types() TO authenticated;
GRANT EXECUTE ON FUNCTION has_role(uuid, text) TO authenticated;

-- ===========================================================================
-- 5. Fix metadata._is_db_admin() — use session_user instead of current_user
-- ===========================================================================
-- The function is SECURITY DEFINER, so current_user is always 'postgres'
-- inside it, making the rolcreaterole check always true. session_user is
-- the login role: 'authenticator' for PostgREST, 'postgres'/'doadmin' for
-- integrators running migrations.

CREATE OR REPLACE FUNCTION metadata._is_db_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT public.is_admin()
    OR current_setting('is_superuser', true) = 'on'
    OR EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = session_user AND rolcreaterole
    );
$function$;

-- ===========================================================================
-- 6. Add authorization guard to request_upload_url
-- ===========================================================================

CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type text,
  p_entity_id text,
  p_file_name text,
  p_file_type text
) RETURNS uuid AS $$
DECLARE
  v_request_id UUID;
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to request upload URLs';
  END IF;

  INSERT INTO metadata.file_upload_requests (entity_type, entity_id, file_name, file_type)
  VALUES (p_entity_type, p_entity_id, p_file_name, p_file_type)
  RETURNING id INTO v_request_id;

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

-- ===========================================================================
-- 7. Add authorization guard to get_upload_url
-- ===========================================================================

CREATE OR REPLACE FUNCTION get_upload_url(p_request_id uuid)
RETURNS TABLE(status text, url text, file_id uuid, error text) AS $$
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to retrieve upload URLs';
  END IF;

  RETURN QUERY
  SELECT fur.status, fur.presigned_url, fur.file_id, fur.error_message
  FROM metadata.file_upload_requests fur
  WHERE fur.id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===========================================================================
-- 8. Add authorization guard to admin_get_user_bulk_subscriptions
-- ===========================================================================

CREATE OR REPLACE FUNCTION admin_get_user_bulk_subscriptions(p_user_id uuid)
 RETURNS TABLE(template_name character varying, template_description text, unsubscribed boolean, last_sent_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
  IF NOT has_permission('civic_os_users_private', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires civic_os_users_private:update permission';
  END IF;

  RETURN QUERY
  SELECT
      ntt.template_name,
      COALESCE(nt.description, ntt.template_name::text),
      BOOL_OR(ntt.unsubscribed),
      MAX(ntt.created_at)
  FROM metadata.notification_tracking_tokens ntt
  JOIN metadata.civic_os_users_private cup ON cup.email = ntt.recipient_email
  LEFT JOIN metadata.notification_templates nt ON nt.name = ntt.template_name AND nt.is_bulk = TRUE
  WHERE cup.id = p_user_id
    AND nt.is_bulk = TRUE
  GROUP BY ntt.template_name, nt.description
  ORDER BY MAX(ntt.created_at) DESC;
END;
$function$;

-- ===========================================================================
-- 9. Add authorization guard to create_entity_note
-- ===========================================================================

CREATE OR REPLACE FUNCTION create_entity_note(
  p_entity_type name,
  p_entity_id text,
  p_content text,
  p_note_type character varying DEFAULT 'note'::character varying,
  p_is_internal boolean DEFAULT true,
  p_author_id uuid DEFAULT NULL::uuid
) RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'metadata', 'public'
AS $function$
DECLARE
    v_note_id BIGINT;
    v_author UUID;
    v_is_db_admin BOOLEAN := metadata._is_db_admin();
BEGIN
    v_author := COALESCE(p_author_id, current_user_id());

    -- DB admins (migrations, workers) bypass auth -- they have no JWT context
    IF NOT v_is_db_admin THEN
        IF v_author IS NULL THEN
            RAISE EXCEPTION 'Authentication required'
                USING HINT = 'Must be logged in to create notes';
        END IF;

        -- System notes (from triggers like add_status_change_note) skip the
        -- permission check -- the user already proved they can update the entity
        -- row, and the note is machine-generated, not user-initiated.
        IF p_note_type != 'system' THEN
            IF NOT has_permission(p_entity_type || ':notes', 'create') THEN
                RAISE EXCEPTION 'Permission denied'
                    USING HINT = format('Requires %s:notes:create permission', p_entity_type);
            END IF;
        END IF;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.entities
        WHERE table_name = p_entity_type AND enable_notes = TRUE
    ) THEN
        RAISE EXCEPTION 'Notes are not enabled for entity type: %', p_entity_type;
    END IF;

    IF TRIM(p_content) = '' THEN
        RAISE EXCEPTION 'Note content cannot be empty';
    END IF;

    -- Only admins can impersonate other authors (skip for db-admin sessions
    -- which have no current_user_id to compare against)
    IF NOT v_is_db_admin
        AND p_author_id IS NOT NULL
        AND p_author_id != current_user_id()
    THEN
        IF NOT is_admin() THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Only admins can set custom authors';
        END IF;
    END IF;

    INSERT INTO metadata.entity_notes (
        entity_type, entity_id, author_id, content, note_type, is_internal
    ) VALUES (
        p_entity_type, p_entity_id, v_author, p_content, p_note_type, p_is_internal
    )
    RETURNING id INTO v_note_id;

    RETURN v_note_id;
END;
$function$;

-- ===========================================================================
-- 10. Add authorization guard to preview_template_parts
-- ===========================================================================

CREATE OR REPLACE FUNCTION preview_template_parts(
  p_validation_id uuid DEFAULT gen_random_uuid(),
  p_subject_template text DEFAULT NULL,
  p_html_template text DEFAULT NULL,
  p_text_template text DEFAULT NULL,
  p_sms_template text DEFAULT NULL,
  p_sample_entity_data jsonb DEFAULT NULL
) RETURNS TABLE(validation_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'metadata', 'public'
AS $function$
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Only admins can preview notification templates';
    END IF;

    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for preview';
    END IF;

    IF p_sample_entity_data IS NULL THEN
        p_sample_entity_data := '{"display_name": "Example Entity", "id": 1}'::jsonb;
    END IF;

    INSERT INTO metadata.template_validation_results (
        id, subject_template, html_template, text_template, sms_template, status
    ) VALUES (
        p_validation_id, p_subject_template, p_html_template, p_text_template, p_sms_template, 'pending'
    );

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
        'notifications', 4, 3, NOW(), 'available'
    );

    RETURN QUERY SELECT p_validation_id;
END;
$function$;

-- ===========================================================================
-- 11. Add authorization guard to validate_template_parts
-- ===========================================================================

CREATE OR REPLACE FUNCTION validate_template_parts(
  p_validation_id uuid DEFAULT gen_random_uuid(),
  p_subject_template text DEFAULT NULL,
  p_html_template text DEFAULT NULL,
  p_text_template text DEFAULT NULL,
  p_sms_template text DEFAULT NULL
) RETURNS TABLE(validation_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'metadata', 'public'
AS $function$
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Only admins can validate notification templates';
    END IF;

    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for validation';
    END IF;

    INSERT INTO metadata.template_validation_results (
        id, subject_template, html_template, text_template, sms_template, status
    ) VALUES (
        p_validation_id, p_subject_template, p_html_template, p_text_template, p_sms_template, 'pending'
    );

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
        'notifications', 4, 3, NOW(), 'available'
    );

    RETURN QUERY SELECT p_validation_id;
END;
$function$;

-- ===========================================================================
-- 12. Add authorization guards to recurring series functions
-- ===========================================================================
-- Pattern: Entity RBAC + series owner. Functions check:
-- (a) current_user_id() IS NOT NULL (authenticated)
-- (b) ownership via created_by = current_user_id() OR is_admin()
-- (c) entity-level has_permission() where applicable

-- cancel_series_occurrence: entity delete permission + series ownership
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
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        IF NOT has_permission(p_entity_table::text, 'delete') THEN
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
          AND (g.created_by = v_user_id OR is_admin())
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

-- create_recurring_series: entity create permission
CREATE OR REPLACE FUNCTION create_recurring_series(
  p_group_name text,
  p_group_description text DEFAULT NULL,
  p_group_color text DEFAULT NULL,
  p_entity_table name DEFAULT NULL,
  p_entity_template jsonb DEFAULT '{}'::jsonb,
  p_rrule text DEFAULT NULL,
  p_dtstart timestamp without time zone DEFAULT NULL,
  p_duration interval DEFAULT NULL,
  p_timezone text DEFAULT NULL,
  p_time_slot_property name DEFAULT 'time_slot'::name,
  p_expand_now boolean DEFAULT false,
  p_skip_conflicts boolean DEFAULT false,
  p_expand_horizon_days integer DEFAULT 90
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_group_id BIGINT;
    v_series_id BIGINT;
    v_user_id UUID;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_entity_table IS NULL THEN RAISE EXCEPTION 'entity_table is required'; END IF;
    IF p_rrule IS NULL THEN RAISE EXCEPTION 'rrule is required'; END IF;
    IF p_dtstart IS NULL THEN RAISE EXCEPTION 'dtstart is required'; END IF;
    IF p_duration IS NULL THEN RAISE EXCEPTION 'duration is required'; END IF;

    IF NOT has_permission(p_entity_table::text, 'create') THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:create permission', p_entity_table);
    END IF;

    PERFORM metadata.validate_rrule(p_rrule);
    PERFORM metadata.validate_entity_template(p_entity_table, p_entity_template);

    INSERT INTO metadata.time_slot_series_groups (display_name, description, color, created_by)
    VALUES (p_group_name, p_group_description, p_group_color, v_user_id)
    RETURNING id INTO v_group_id;

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
            jsonb_build_object('series_id', v_series_id, 'expand_until',
                to_char((CURRENT_DATE + (p_expand_horizon_days || ' days')::INTERVAL)::TIMESTAMPTZ,
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
            3, NOW(), NOW()
        );
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE, 'group_id', v_group_id, 'series_id', v_series_id,
        'message', CASE WHEN p_expand_now THEN 'Series created and expansion queued'
                        ELSE 'Series created' END
    );
END;
$function$;

-- delete_series_group: series owner or admin
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

    IF NOT (v_group.created_by = current_user_id() OR is_admin()) THEN
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

-- delete_series_with_instances: series owner or admin
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
          AND (created_by = current_user_id() OR is_admin())
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

-- expand_series_instances: series owner or admin
CREATE OR REPLACE FUNCTION expand_series_instances(p_series_id bigint, p_expand_until date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_series RECORD;
BEGIN
    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series_groups
        WHERE id = v_series.group_id
          AND (created_by = current_user_id() OR is_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    UPDATE metadata.time_slot_series
    SET expanded_until = GREATEST(COALESCE(expanded_until, '1970-01-01'::DATE), p_expand_until)
    WHERE id = p_series_id;

    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available', 'recurring', 'expand_recurring_series',
        jsonb_build_object('series_id', p_series_id, 'expand_until',
            to_char(p_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        3, NOW(), NOW()
    );

    RETURN jsonb_build_object('success', TRUE, 'message', 'Expansion queued',
        'series_id', p_series_id, 'expand_until', p_expand_until);
END;
$function$;

-- reschedule_occurrence: series owner or admin
CREATE OR REPLACE FUNCTION reschedule_occurrence(
  p_entity_table name,
  p_entity_id bigint,
  p_new_time_slot tstzrange
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_instance RECORD;
    v_old_slot TSTZRANGE;
    v_user_id UUID;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_instance
    FROM metadata.time_slot_instances
    WHERE entity_table = p_entity_table AND entity_id = p_entity_id;

    IF NOT FOUND THEN
        IF NOT has_permission(p_entity_table::text, 'update') THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = format('Requires %s:update permission', p_entity_table);
        END IF;
        EXECUTE format('UPDATE public.%I SET time_slot = $1 WHERE id = $2', p_entity_table)
        USING p_new_time_slot, p_entity_id;
        RETURN jsonb_build_object('success', TRUE, 'message', 'Time slot updated (not part of a series)');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series s
        JOIN metadata.time_slot_series_groups g ON g.id = s.group_id
        WHERE s.id = v_instance.series_id
          AND (g.created_by = v_user_id OR is_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    EXECUTE format('SELECT time_slot FROM public.%I WHERE id = $1', p_entity_table)
    INTO v_old_slot USING p_entity_id;

    EXECUTE format('UPDATE public.%I SET time_slot = $1 WHERE id = $2', p_entity_table)
    USING p_new_time_slot, p_entity_id;

    UPDATE metadata.time_slot_instances
    SET is_exception = TRUE,
        exception_type = 'rescheduled',
        original_time_slot = v_old_slot,
        exception_at = NOW(),
        exception_by = v_user_id
    WHERE id = v_instance.id;

    RETURN jsonb_build_object(
        'success', TRUE, 'message', 'Occurrence rescheduled',
        'series_id', v_instance.series_id, 'occurrence_date', v_instance.occurrence_date,
        'original_time_slot', v_old_slot::TEXT, 'new_time_slot', p_new_time_slot::TEXT
    );
END;
$function$;

-- preview_recurring_conflicts: authenticated + entity read permission
CREATE OR REPLACE FUNCTION preview_recurring_conflicts(
  p_entity_table name,
  p_scope_column name,
  p_scope_value text,
  p_time_slot_column name,
  p_occurrences timestamp with time zone[]
) RETURNS TABLE(occurrence_index integer, occurrence_start timestamp with time zone,
                occurrence_end timestamp with time zone, has_conflict boolean,
                conflicting_id bigint, conflicting_display text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    v_idx INTEGER := 0;
    v_start TIMESTAMPTZ;
    v_end TIMESTAMPTZ;
    v_slot TSTZRANGE;
    v_query TEXT;
    v_conflict RECORD;
    v_scope_type TEXT;
BEGIN
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT has_permission(p_entity_table::text, 'read') THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = format('Requires %s:read permission', p_entity_table);
    END IF;

    SELECT data_type INTO v_scope_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = p_entity_table AND column_name = p_scope_column;

    FOR v_idx IN 1..array_length(p_occurrences, 1)
    LOOP
        v_start := p_occurrences[v_idx][1];
        v_end := p_occurrences[v_idx][2];
        v_slot := tstzrange(v_start, v_end, '[)');

        v_query := format(
            'SELECT id, COALESCE(display_name, ''#'' || id::text) as display_name
             FROM public.%I WHERE %I = $1::%s AND %I && $2 LIMIT 1',
            p_entity_table, p_scope_column, COALESCE(v_scope_type, 'text'), p_time_slot_column
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
            occurrence_index := v_idx;
            occurrence_start := v_start;
            occurrence_end := v_end;
            has_conflict := FALSE;
            conflicting_id := NULL;
            conflicting_display := NULL;
            RETURN NEXT;
        END;
    END LOOP;
END;
$function$;

-- split_series_from_date: series owner or admin
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
    IF v_user_id IS NULL THEN
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
              AND (created_by = v_user_id OR is_admin())
        ) THEN
            RAISE EXCEPTION 'Permission denied'
                USING HINT = 'Must be the series owner or an admin';
        END IF;
    ELSE
        IF NOT (v_original.created_by = v_user_id OR is_admin()) THEN
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

-- update_series_group_info: fix NULL-trap in guard
CREATE OR REPLACE FUNCTION update_series_group_info(
  p_group_id bigint,
  p_display_name text,
  p_description text DEFAULT NULL,
  p_color text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_group RECORD;
    v_user_id UUID;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_group FROM metadata.time_slot_series_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Group not found');
    END IF;

    IF NOT (v_group.created_by = v_user_id OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series group owner or an admin';
    END IF;

    UPDATE metadata.time_slot_series_groups
    SET display_name = COALESCE(NULLIF(TRIM(p_display_name), ''), display_name),
        description = p_description,
        color = p_color,
        updated_at = NOW()
    WHERE id = p_group_id;

    RETURN jsonb_build_object('success', TRUE, 'message', 'Group updated', 'group_id', p_group_id);
END;
$function$;

-- update_series_schedule: fix NULL-trap in guard
CREATE OR REPLACE FUNCTION update_series_schedule(
  p_series_id bigint,
  p_dtstart timestamp without time zone,
  p_duration interval,
  p_rrule text,
  p_expand_horizon_days integer DEFAULT 90
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_series RECORD;
    v_user_id UUID;
    v_entity_ids BIGINT[];
    v_deleted_count INT := 0;
    v_expand_until DATE;
BEGIN
    v_user_id := current_user_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series_groups
        WHERE id = v_series.group_id
          AND (created_by = v_user_id OR is_admin())
    ) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Must be the series owner or an admin';
    END IF;

    PERFORM metadata.validate_rrule(p_rrule);

    SELECT array_agg(entity_id) INTO v_entity_ids
    FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND entity_id IS NOT NULL AND is_exception = FALSE;

    IF v_entity_ids IS NOT NULL AND array_length(v_entity_ids, 1) > 0 THEN
        EXECUTE format('DELETE FROM public.%I WHERE id = ANY($1)', v_series.entity_table) USING v_entity_ids;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    DELETE FROM metadata.time_slot_instances
    WHERE series_id = p_series_id AND is_exception = FALSE;

    UPDATE metadata.time_slot_series
    SET dtstart = p_dtstart, duration = p_duration, rrule = p_rrule,
        expanded_until = NULL, updated_at = NOW()
    WHERE id = p_series_id;

    v_expand_until := (CURRENT_DATE + (p_expand_horizon_days || ' days')::INTERVAL)::DATE;

    INSERT INTO metadata.river_job (state, queue, kind, args, max_attempts, created_at, scheduled_at)
    VALUES (
        'available', 'recurring', 'expand_recurring_series',
        jsonb_build_object('series_id', p_series_id, 'expand_until',
            to_char(v_expand_until::TIMESTAMPTZ, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        3, NOW(), NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE, 'message', format('Schedule updated, %s old records deleted, re-expansion queued', v_deleted_count),
        'series_id', p_series_id, 'old_records_deleted', v_deleted_count
    );
END;
$function$;

-- update_series_template: series owner or admin
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
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT * INTO v_series FROM metadata.time_slot_series WHERE id = p_series_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Series not found');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM metadata.time_slot_series_groups
        WHERE id = v_series.group_id
          AND (created_by = v_user_id OR is_admin())
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

-- ===========================================================================
-- 13. Add guard to enable_entity_notes (integrator setup + MCP caller)
-- ===========================================================================

CREATE OR REPLACE FUNCTION enable_entity_notes(p_entity_type name)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NOT metadata._is_db_admin() THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Only database administrators can enable entity notes';
    END IF;

    INSERT INTO metadata.entities (table_name, enable_notes)
    VALUES (p_entity_type, TRUE)
    ON CONFLICT (table_name) DO UPDATE SET enable_notes = TRUE;

    INSERT INTO metadata.permissions (table_name, permission)
    VALUES
        (p_entity_type || ':notes', 'read'),
        (p_entity_type || ':notes', 'create')
    ON CONFLICT DO NOTHING;

    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.table_name = p_entity_type || ':notes'
      AND r.display_name = 'editor'
    ON CONFLICT DO NOTHING;

    INSERT INTO metadata.permission_roles (permission_id, role_id)
    SELECT p.id, r.id
    FROM metadata.permissions p
    CROSS JOIN metadata.roles r
    WHERE p.table_name = p_entity_type || ':notes'
      AND p.permission = 'read'
      AND r.display_name = 'user'
    ON CONFLICT DO NOTHING;
END;
$function$;

-- ===========================================================================
-- 14. Schema Decision (ADR)
-- ===========================================================================

INSERT INTO metadata.schema_decisions (
    title,
    decision,
    rationale,
    migration_id
) VALUES (
    'Revoke PUBLIC EXECUTE on non-anonymous functions',
    'REVOKE EXECUTE FROM PUBLIC on all functions whose intended audience is not anonymous users. Add ALTER DEFAULT PRIVILEGES to prevent regression. Add in-body authorization guards to all unguarded SECURITY DEFINER functions. Fix metadata._is_db_admin() to use session_user instead of current_user.',
    'PostgreSQL grants EXECUTE to PUBLIC by default on new functions. Migrations only GRANT ... TO authenticated (or REVOKE ... FROM web_anon, which is a no-op since the grant comes from PUBLIC). This allows anonymous users (web_anon) to call SECURITY DEFINER RPCs via PostgREST, bypassing RLS and table-level grants. Verified exploits: anonymous file upload (request_upload_url/get_upload_url), arbitrary table row deletion (cancel_series_occurrence), notification spam (create_notification), data tampering (update_series_template), DDL privilege escalation (_is_db_admin always true). CVSS: 9.8 (network, low complexity, no auth, high impact). Full audit of 156 public functions classified each as anon (33), authenticated (98), or internal (25).',
    'v0-76-5-revoke-public-execute'
);

-- ===========================================================================
-- 15. Reload PostgREST schema cache
-- ===========================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
