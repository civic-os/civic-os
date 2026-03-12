-- Deploy civic_os:v0-35-0-admin-notification-prefs to pg
-- requires: v0-35-0-add-sms-opted-out

BEGIN;

-- ============================================================================
-- 1. GRANT + RLS for admin access to notification_preferences
-- ============================================================================
-- The managed_users VIEW (security_invoker = true) runs subqueries as the
-- caller's role. The authenticated role needs SELECT on the table, and admins
-- need an RLS policy that lets them see all rows (not just their own).
--
-- PostgreSQL OR's PERMISSIVE policies: a row is visible if ANY policy passes.
-- - Regular users: pass "own preferences" policy → see only their rows
-- - Admins: pass "admin read" policy → see all rows

GRANT SELECT, UPDATE ON metadata.notification_preferences TO authenticated;

CREATE POLICY "Admin read all preferences"
    ON metadata.notification_preferences
    FOR SELECT
    TO authenticated
    USING (public.has_permission('civic_os_users_private', 'read'));

CREATE POLICY "Admin update all preferences"
    ON metadata.notification_preferences
    FOR UPDATE
    TO authenticated
    USING (public.has_permission('civic_os_users_private', 'update'));


-- ============================================================================
-- 2. EXTEND managed_users VIEW with notification columns
-- ============================================================================
-- Add email_notif_enabled, sms_notif_enabled, sms_opted_out to the managed_users
-- VIEW so the User Management table can display notification status icons
-- without N+1 queries.

DROP VIEW IF EXISTS public.managed_users;
CREATE VIEW public.managed_users
WITH (security_invoker = true) AS

-- Active users (fully provisioned)
SELECT
    u.id,
    u.display_name,
    p.display_name AS full_name,
    p.first_name,
    p.last_name,
    p.email::TEXT AS email,
    p.phone::TEXT AS phone,
    'active'::TEXT AS status,
    NULL::TEXT AS error_message,
    COALESCE(
        (SELECT array_agg(r.display_name ORDER BY r.display_name)
         FROM metadata.user_roles ur
         JOIN metadata.roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id
           AND NOT metadata.is_keycloak_system_role(r.display_name)
           AND r.display_name != 'anonymous'),
        (SELECT up2.initial_roles
         FROM metadata.user_provisioning up2
         WHERE up2.keycloak_user_id = u.id
         ORDER BY up2.completed_at DESC NULLS LAST
         LIMIT 1)
    ) AS roles,
    u.created_at,
    NULL::BIGINT AS provision_id,
    -- Notification preference columns (new in v0.35.0)
    (SELECT np.enabled FROM metadata.notification_preferences np
     WHERE np.user_id = u.id AND np.channel = 'email') AS email_notif_enabled,
    (SELECT np.enabled FROM metadata.notification_preferences np
     WHERE np.user_id = u.id AND np.channel = 'sms') AS sms_notif_enabled,
    (SELECT np.sms_opted_out FROM metadata.notification_preferences np
     WHERE np.user_id = u.id AND np.channel = 'sms') AS sms_opted_out
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id

UNION ALL

-- Pending/failed provisioning requests (not yet in civic_os_users)
SELECT
    up.keycloak_user_id AS id,
    (up.first_name || ' ' || substring(up.last_name from 1 for 1) || '.')::TEXT AS display_name,
    (up.first_name || ' ' || up.last_name)::TEXT AS full_name,
    up.first_name::TEXT,
    up.last_name::TEXT,
    up.email::TEXT,
    up.phone::TEXT,
    up.status::TEXT,
    up.error_message,
    up.initial_roles AS roles,
    up.created_at,
    up.id AS provision_id,
    -- Pending users have no notification preferences yet
    NULL::BOOLEAN AS email_notif_enabled,
    NULL::BOOLEAN AS sms_notif_enabled,
    NULL::BOOLEAN AS sms_opted_out
FROM metadata.user_provisioning up
WHERE up.status NOT IN ('completed');

COMMENT ON VIEW public.managed_users IS
    'Combined view of all users for admin User Management page. Active users
     from civic_os_users UNION pending/failed provisioning requests.
     Includes first_name/last_name (v0.31.0), provision_id for retry,
     and notification preference columns (v0.35.0).
     Mutations use RPCs. Excluded from schema_entities.';

GRANT SELECT ON public.managed_users TO authenticated;


-- ============================================================================
-- 3. ADMIN RPCs FOR NOTIFICATION PREFERENCE MANAGEMENT
-- ============================================================================
-- Two SECURITY DEFINER RPCs for privileged access to user notification prefs.
-- Gated by civic_os_users_private permissions (same as update_user_info, assign_user_role).
-- Bypasses RLS (which restricts to user_id = current_user_id()).

-- a) Read: admin_get_user_notification_preferences(p_user_id)
--    Permission: civic_os_users_private:read (same as managed_users VIEW)
CREATE OR REPLACE FUNCTION admin_get_user_notification_preferences(p_user_id UUID)
RETURNS TABLE(
    channel TEXT,
    enabled BOOLEAN,
    email_address TEXT,
    phone_number TEXT,
    sms_opted_out BOOLEAN,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    -- Permission check: reuse civic_os_users_private:read (same as user provisioning)
    IF NOT public.has_permission('civic_os_users_private', 'read') THEN
        RAISE EXCEPTION 'Permission denied: civic_os_users_private:read required';
    END IF;

    RETURN QUERY
    SELECT
        np.channel::TEXT,
        np.enabled,
        np.email_address::TEXT,
        np.phone_number::TEXT,
        np.sms_opted_out,
        np.created_at,
        np.updated_at
    FROM metadata.notification_preferences np
    WHERE np.user_id = p_user_id
    ORDER BY np.channel;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_get_user_notification_preferences TO authenticated;

COMMENT ON FUNCTION admin_get_user_notification_preferences IS
    'Get notification preferences for any user. Requires civic_os_users_private:read. Bypasses RLS.';


-- b) Write: admin_update_notification_preference(p_user_id, p_channel, p_enabled, p_clear_opted_out)
--    Permission: civic_os_users_private:update (same as update_user_info)
--    p_clear_opted_out: When true AND channel='sms', clears the sms_opted_out flag.
--    This lets admins re-probe Telnyx after a user texts START to re-subscribe.
--    If the user is still opted out, the worker will re-set the flag on next send.
CREATE OR REPLACE FUNCTION admin_update_notification_preference(
    p_user_id UUID,
    p_channel TEXT,
    p_enabled BOOLEAN,
    p_clear_opted_out BOOLEAN DEFAULT false
)
RETURNS JSON
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_rows_updated INTEGER;
BEGIN
    -- Permission check: reuse civic_os_users_private:update (same as update_user_info)
    IF NOT public.has_permission('civic_os_users_private', 'update') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    UPDATE metadata.notification_preferences
    SET enabled = p_enabled,
        sms_opted_out = CASE
            WHEN p_clear_opted_out AND p_channel = 'sms' THEN false
            ELSE sms_opted_out
        END,
        updated_at = NOW()
    WHERE user_id = p_user_id AND channel = p_channel;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

    IF v_rows_updated = 0 THEN
        RETURN json_build_object('success', false, 'error',
            'No preference found for user ' || p_user_id || ' channel ' || p_channel);
    END IF;

    RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_notification_preference TO authenticated;

COMMENT ON FUNCTION admin_update_notification_preference IS
    'Toggle enabled flag on a user notification preference. Requires civic_os_users_private:update. Optional p_clear_opted_out resets sms_opted_out for re-probing after user texts START.';


-- ============================================================================
-- 4. EXCLUDE ADMIN RPCs FROM schema_functions
-- ============================================================================
-- Update schema_functions to exclude these admin RPCs (same pattern as other admin RPCs)

DROP VIEW IF EXISTS public.parsed_source_code;
DROP VIEW IF EXISTS public.schema_functions;

CREATE VIEW public.schema_functions
WITH (security_invoker = true) AS
WITH
entity_effects AS (
    SELECT
        ree.function_name,
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', ree.entity_table,
            'effect', ree.effect_type,
            'auto_detected', ree.is_auto_detected,
            'description', ree.description
        )) FILTER (
            WHERE metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
        ) AS visible_effects,
        COUNT(*) FILTER (
            WHERE NOT metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
        )::INT AS hidden_count
    FROM metadata.rpc_entity_effects ree
    GROUP BY ree.function_name
)
SELECT
    p.proname AS function_name,
    n.nspname::NAME AS schema_name,
    COALESCE(rf.display_name, initcap(replace(p.proname::text, '_', ' '))) AS display_name,
    rf.description,
    rf.category,
    rf.parameters,
    pg_get_function_result(p.oid) AS returns_type,
    rf.returns_description,
    COALESCE(rf.is_idempotent, false) AS is_idempotent,
    rf.minimum_role,
    COALESCE(ee.visible_effects, '[]'::jsonb) AS entity_effects,
    COALESCE(ee.hidden_count, 0) AS hidden_effects_count,
    rf.function_name IS NOT NULL AS is_registered,
    EXISTS (
        SELECT 1 FROM metadata.scheduled_jobs sj
        WHERE sj.function_name = p.proname::TEXT
          AND sj.enabled = true
    ) AS has_active_schedule,
    CASE
        WHEN EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
        THEN EXISTS (
            SELECT 1 FROM metadata.entity_actions ea
            WHERE ea.rpc_function = p.proname::NAME
              AND metadata.has_entity_action_permission(ea.id)
        )
        ELSE true
    END AS can_execute,
    pg_get_functiondef(p.oid) AS source_code,
    l.lanname AS language,
    psc.ast_json

FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN metadata.rpc_functions rf ON rf.function_name = p.proname
LEFT JOIN entity_effects ee ON ee.function_name = p.proname
LEFT JOIN metadata.parsed_source_code psc
    ON psc.object_name = p.proname AND psc.object_type = 'function'

WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND p.proname NOT IN (
      'is_admin', 'has_permission', 'get_user_roles',
      'current_user_id', 'current_user_email', 'current_user_name', 'current_user_phone',
      'check_jwt', 'get_initial_status', 'get_statuses_for_entity', 'get_status_entity_types',
      'has_role', 'has_entity_action_permission',
      'refresh_current_user',
      'grant_entity_action_permission', 'revoke_entity_action_permission', 'get_entity_action_roles',
      'upsert_entity_metadata', 'upsert_property_metadata',
      'update_entity_sort_order', 'update_property_sort_order',
      'create_role', 'get_roles', 'get_role_permissions',
      'set_role_permission', 'ensure_table_permissions', 'enable_entity_notes',
      'get_dashboards', 'get_dashboard', 'get_user_default_dashboard',
      'schema_relations_func', 'schema_view_relations_func', 'schema_view_validations_func',
      'set_created_at', 'set_updated_at', 'set_file_created_by',
      'add_status_change_note', 'add_payment_status_change_note',
      'add_reservation_status_change_note', 'validate_status_entity_type',
      'enqueue_notification_job', 'create_notification', 'create_default_notification_preferences',
      'notify_new_reservation_request', 'notify_reservation_status_change',
      'insert_s3_presign_job', 'insert_thumbnail_job', 'create_payment_intent_sync',
      'cleanup_old_validation_results', 'get_validation_results',
      'get_preview_results', 'preview_template_parts', 'validate_template_parts',
      'get_upload_url', 'request_upload_url',
      'format_public_display_name',
      'get_entity_source_code',
      'create_schema_decision',
      'can_manage_role', 'get_manageable_roles',
      'assign_user_role', 'revoke_user_role',
      'delete_role', 'set_role_can_manage', 'get_role_can_manage',
      'create_provisioned_user', 'retry_user_provisioning', 'bulk_provision_users',
      'update_user_info',
      'admin_get_user_notification_preferences', 'admin_update_notification_preference'
  )
  AND (
      NOT EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
      OR EXISTS (
          SELECT 1 FROM metadata.entity_actions ea
          WHERE ea.rpc_function = p.proname::NAME
            AND metadata.has_entity_action_permission(ea.id)
      )
      OR EXISTS (
          SELECT 1 FROM metadata.rpc_entity_effects ree
          WHERE ree.function_name = p.proname
            AND metadata.has_permission(ree.entity_table::TEXT, 'read'::TEXT)
      )
  );

COMMENT ON VIEW public.schema_functions IS
    'Catalog-first view of public functions with source code. Updated in v0.35.0 to exclude admin notification RPCs.';

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;

CREATE VIEW public.parsed_source_code
WITH (security_invoker = true) AS
SELECT psc.schema_name, psc.object_name, psc.object_type, psc.language,
       psc.ast_json, psc.parse_error, psc.parsed_at
FROM metadata.parsed_source_code psc
WHERE
  (psc.object_type = 'function' AND (
    EXISTS (
      SELECT 1 FROM public.schema_functions sf
      WHERE sf.function_name = psc.object_name
    )
    OR
    EXISTS (
      SELECT 1 FROM public.schema_triggers st
      WHERE st.function_name = psc.object_name
    )
  ))
  OR
  (psc.object_type = 'view'
    AND metadata.has_permission(psc.object_name::TEXT, 'read'::TEXT));

COMMENT ON VIEW public.parsed_source_code IS
    'Permission-filtered view of pre-parsed AST JSON. Delegates visibility to
     schema_functions/schema_triggers for functions and has_permission for views.
     Added in v0.29.0.';

GRANT SELECT ON public.parsed_source_code TO authenticated, web_anon;


-- ============================================================================
-- 5. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
