-- Deploy civic_os:v0-31-0-edit-user-info to pg
-- requires: v0-31-0-user-provisioning

BEGIN;

-- ============================================================================
-- EDIT USER INFO SYSTEM
-- ============================================================================
-- Version: v0.31.0
-- Purpose: Allow admins to edit existing user information (name, phone) and
--          sync changes to Keycloak via async River job. Adds first_name and
--          last_name columns for structured name storage.
--
-- Architecture:
--   1. Admin edits user via UI → calls update_user_info() RPC
--   2. RPC validates, updates civic_os_users + civic_os_users_private
--   3. Enqueues River job (update_keycloak_user) for async Keycloak sync
--   4. Go worker updates Keycloak user profile (firstName, lastName, phone)
--
-- Key Changes:
--   - Add first_name/last_name to civic_os_users_private
--   - Backfill from user_provisioning (exact) then parse display_name (fallback)
--   - Update refresh_current_user() to write first_name/last_name
--   - Update managed_users view to expose new columns
--   - New update_user_info() RPC with permission checks
-- ============================================================================


-- ============================================================================
-- 1. ADD COLUMNS TO civic_os_users_private
-- ============================================================================

ALTER TABLE metadata.civic_os_users_private
    ADD COLUMN IF NOT EXISTS first_name TEXT,
    ADD COLUMN IF NOT EXISTS last_name TEXT;


-- ============================================================================
-- 2. BACKFILL first_name/last_name FROM EXISTING DATA
-- ============================================================================

-- 2a. Exact data from completed provisioning records
UPDATE metadata.civic_os_users_private p
SET first_name = up.first_name,
    last_name = up.last_name
FROM metadata.user_provisioning up
WHERE up.keycloak_user_id = p.id
  AND up.status = 'completed'
  AND p.first_name IS NULL;

-- 2b. Fallback: last-space split for remaining rows with display_name
-- "John Michael Doe" → first="John Michael", last="Doe"
-- "SingleName" → first="SingleName", last=NULL
UPDATE metadata.civic_os_users_private
SET first_name = CASE
        WHEN position(' ' IN TRIM(display_name)) > 0
        THEN TRIM(LEFT(TRIM(display_name), length(TRIM(display_name)) - length(split_part(TRIM(display_name), ' ', array_length(string_to_array(TRIM(display_name), ' '), 1))) - 1))
        ELSE TRIM(display_name)
    END,
    last_name = CASE
        WHEN position(' ' IN TRIM(display_name)) > 0
        THEN split_part(TRIM(display_name), ' ', array_length(string_to_array(TRIM(display_name), ' '), 1))
        ELSE NULL
    END
WHERE first_name IS NULL
  AND display_name IS NOT NULL
  AND TRIM(display_name) != '';


-- ============================================================================
-- 3. UPDATE refresh_current_user() TO WRITE first_name/last_name
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_first_name TEXT;
  v_last_name TEXT;
  v_user_roles TEXT[];
  v_role_name TEXT;
  v_role_id SMALLINT;
  v_result metadata.civic_os_users;
BEGIN
  -- Get claims from JWT
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();
  v_phone := public.current_user_phone();

  -- Validate we have required data
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  -- Parse first_name/last_name from display_name using last-space split
  IF position(' ' IN TRIM(v_display_name)) > 0 THEN
    v_last_name := split_part(TRIM(v_display_name), ' ',
                     array_length(string_to_array(TRIM(v_display_name), ' '), 1));
    v_first_name := TRIM(LEFT(TRIM(v_display_name),
                     length(TRIM(v_display_name)) - length(v_last_name) - 1));
  ELSE
    v_first_name := TRIM(v_display_name);
    v_last_name := NULL;
  END IF;

  -- Upsert into civic_os_users (public profile)
  -- Store shortened name (e.g., "John D.") for privacy
  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  -- Upsert into civic_os_users_private (private profile)
  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, first_name, last_name, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, v_first_name, v_last_name, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        updated_at = NOW();

  -- Sync roles from JWT to metadata.user_roles
  v_user_roles := public.get_user_roles();

  -- Delete old role mappings for this user
  DELETE FROM metadata.user_roles WHERE user_id = v_user_id;

  -- Insert new role mappings (skip Keycloak system roles)
  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    -- Skip Keycloak system roles (offline_access, uma_authorization, default-roles-*)
    IF metadata.is_keycloak_system_role(v_role_name) THEN
      CONTINUE;
    END IF;

    -- Lookup role_id by display_name
    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE display_name = v_role_name;

    -- If role doesn't exist, auto-create it (keeps JWT and DB in sync)
    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, description)
      VALUES (v_role_name, 'Auto-created from JWT claim')
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    -- Insert user-role mapping
    INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
    VALUES (v_user_id, v_role_id, NOW())
    ON CONFLICT (user_id, role_id) DO UPDATE
      SET synced_at = NOW();
  END LOOP;

  -- Return the public user record
  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS
    'Sync current user data from JWT claims to database. Includes name, email,
     phone, first_name, last_name, and roles. Updated in v0.31.0 to write
     first_name/last_name parsed from JWT name claim.';


-- ============================================================================
-- 4. CREATE update_user_info() RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_user_info(
  p_user_id UUID,
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_full_name TEXT;
  v_public_display TEXT;
BEGIN
  -- Permission check: must have civic_os_users_private:update permission
  IF NOT public.has_permission('civic_os_users_private', 'update') THEN
    RETURN json_build_object('success', false, 'error', 'Permission denied');
  END IF;

  -- Validate required fields
  IF TRIM(COALESCE(p_first_name, '')) = '' OR TRIM(COALESCE(p_last_name, '')) = '' THEN
    RETURN json_build_object('success', false, 'error', 'First name and last name are required');
  END IF;

  -- Verify user exists
  IF NOT EXISTS (SELECT 1 FROM metadata.civic_os_users WHERE id = p_user_id) THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Build full name and public display name
  v_full_name := TRIM(p_first_name) || ' ' || TRIM(p_last_name);
  v_public_display := public.format_public_display_name(v_full_name);

  -- Update civic_os_users (public profile)
  UPDATE metadata.civic_os_users
  SET display_name = v_public_display,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Update civic_os_users_private (private profile)
  UPDATE metadata.civic_os_users_private
  SET display_name = v_full_name,
      first_name = TRIM(p_first_name),
      last_name = TRIM(p_last_name),
      phone = CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN NULL ELSE TRIM(p_phone) END,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Enqueue River job for async Keycloak sync
  INSERT INTO metadata.river_job (args, kind, queue, state, priority, max_attempts)
  VALUES (
    json_build_object(
      'user_id', p_user_id::TEXT,
      'first_name', TRIM(p_first_name),
      'last_name', TRIM(p_last_name),
      'phone', CASE WHEN TRIM(COALESCE(p_phone, '')) = '' THEN '' ELSE TRIM(p_phone) END
    )::JSONB,
    'update_keycloak_user',
    'user_provisioning',
    'available',
    1,
    5
  );

  RETURN json_build_object('success', true, 'message', 'User info updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.update_user_info(UUID, TEXT, TEXT, TEXT) IS
    'Update user profile info (name, phone) and enqueue Keycloak sync.
     Requires civic_os_users_private:update permission. Added in v0.31.0.';

GRANT EXECUTE ON FUNCTION public.update_user_info(UUID, TEXT, TEXT, TEXT) TO authenticated;


-- ============================================================================
-- 5. ADD update PERMISSION FOR civic_os_users_private (admin only)
-- ============================================================================

-- Ensure the update permission entry exists for civic_os_users_private
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('civic_os_users_private', 'update')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant update permission to admin role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission = 'update'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 6. UPDATE managed_users VIEW (add first_name/last_name)
-- ============================================================================

DROP VIEW IF EXISTS public.managed_users;
CREATE VIEW public.managed_users
WITH (security_invoker = true) AS

-- Active users (fully provisioned, have Keycloak accounts)
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
    NULL::BIGINT AS provision_id
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
    up.id AS provision_id
FROM metadata.user_provisioning up
WHERE up.status NOT IN ('completed');

COMMENT ON VIEW public.managed_users IS
    'Combined view of all users for admin User Management page. Active users
     from civic_os_users UNION pending/failed provisioning requests.
     Includes first_name/last_name (v0.31.0) and provision_id for retry.
     Mutations use RPCs (create_provisioned_user, retry_user_provisioning,
     update_user_info). Excluded from schema_entities.';

GRANT SELECT ON public.managed_users TO authenticated;


-- ============================================================================
-- 7. UPDATE schema_functions VIEW (exclude update_user_info)
-- ============================================================================

-- Recreate dependent views in correct order
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
      'update_user_info'
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
    'Catalog-first view of public functions with source code. Updated in v0.31.0 to exclude update_user_info.';

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;


-- ============================================================================
-- 7b. RECREATE PARSED_SOURCE_CODE VIEW
-- ============================================================================

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
-- 8. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
