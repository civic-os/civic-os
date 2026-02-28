-- Revert civic_os:v0-31-0-user-provisioning from pg

BEGIN;

-- ============================================================================
-- 1. DROP PUBLIC VIEWS
-- ============================================================================

DROP VIEW IF EXISTS public.managed_users;


-- ============================================================================
-- 1b. DROP ADMIN RLS POLICY ON user_roles
-- ============================================================================

DROP POLICY IF EXISTS "User managers see all roles" ON metadata.user_roles;


-- ============================================================================
-- 2. DROP NEW RPCs
-- ============================================================================

DROP FUNCTION IF EXISTS public.can_manage_role(TEXT);
DROP FUNCTION IF EXISTS public.get_manageable_roles();
DROP FUNCTION IF EXISTS public.assign_user_role(UUID, TEXT);
DROP FUNCTION IF EXISTS public.revoke_user_role(UUID, TEXT);
DROP FUNCTION IF EXISTS public.delete_role(SMALLINT);
DROP FUNCTION IF EXISTS public.set_role_can_manage(SMALLINT, SMALLINT, BOOLEAN);
DROP FUNCTION IF EXISTS public.get_role_can_manage(SMALLINT);
DROP FUNCTION IF EXISTS public.create_provisioned_user(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS public.retry_user_provisioning(BIGINT);
DROP FUNCTION IF EXISTS public.bulk_provision_users(JSON);


-- ============================================================================
-- 2b. RESTORE get_roles() (remove system role filter)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_roles()
RETURNS TABLE (
  id SMALLINT,
  display_name TEXT,
  description TEXT
) AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT r.id, r.display_name, r.description
  FROM metadata.roles r
  ORDER BY r.id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- ============================================================================
-- 2c. RESTORE refresh_current_user() (v0.11.0 version, with auto-create)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_current_user()
RETURNS metadata.civic_os_users AS $$
DECLARE
  v_user_id UUID;
  v_display_name TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_user_roles TEXT[];
  v_role_name TEXT;
  v_role_id SMALLINT;
  v_result metadata.civic_os_users;
BEGIN
  v_user_id := public.current_user_id();
  v_display_name := public.current_user_name();
  v_email := public.current_user_email();
  v_phone := public.current_user_phone();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated user found in JWT';
  END IF;

  IF v_display_name IS NULL OR v_display_name = '' THEN
    RAISE EXCEPTION 'No display name found in JWT (name or preferred_username claim required)';
  END IF;

  INSERT INTO metadata.civic_os_users (id, display_name, created_at, updated_at)
  VALUES (v_user_id, public.format_public_display_name(v_display_name), NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = NOW();

  INSERT INTO metadata.civic_os_users_private (id, display_name, email, phone, created_at, updated_at)
  VALUES (v_user_id, v_display_name, v_email, v_phone, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        updated_at = NOW();

  v_user_roles := public.get_user_roles();
  DELETE FROM metadata.user_roles WHERE user_id = v_user_id;

  FOREACH v_role_name IN ARRAY v_user_roles
  LOOP
    SELECT id INTO v_role_id
    FROM metadata.roles
    WHERE display_name = v_role_name;

    IF v_role_id IS NULL THEN
      INSERT INTO metadata.roles (display_name, description)
      VALUES (v_role_name, 'Auto-created from JWT claim')
      RETURNING id INTO v_role_id;

      RAISE NOTICE 'Auto-created role "%" from JWT', v_role_name;
    END IF;

    INSERT INTO metadata.user_roles (user_id, role_id, synced_at)
    VALUES (v_user_id, v_role_id, NOW())
    ON CONFLICT (user_id, role_id) DO UPDATE
      SET synced_at = NOW();
  END LOOP;

  SELECT * INTO v_result
  FROM metadata.civic_os_users
  WHERE id = v_user_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_current_user() IS 'Sync current user data from JWT claims to database. Includes name, email, phone, and roles.';


-- ============================================================================
-- 2d. DROP HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS metadata.is_keycloak_system_role(TEXT);


-- ============================================================================
-- 3. RESTORE CREATE_ROLE (remove Keycloak sync)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_role(
  p_display_name TEXT,
  p_description TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_new_role_id SMALLINT;
  v_exists BOOLEAN;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Admin access required'
    );
  END IF;

  IF p_display_name IS NULL OR TRIM(p_display_name) = '' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Role name cannot be empty'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM metadata.roles
    WHERE display_name = TRIM(p_display_name)
  ) INTO v_exists;

  IF v_exists THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Role with this name already exists'
    );
  END IF;

  INSERT INTO metadata.roles (display_name, description)
  VALUES (TRIM(p_display_name), TRIM(p_description))
  RETURNING id INTO v_new_role_id;

  RETURN json_build_object(
    'success', true,
    'role_id', v_new_role_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- 4. RESTORE SCHEMA_FUNCTIONS VIEW (remove v0.31.0 exclusions)
-- ============================================================================

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
      'create_schema_decision'
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
    'Catalog-first view of public functions with source code. Updated in v0.30.0 to exclude create_schema_decision.';

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;


-- ============================================================================
-- 4b. RECREATE PARSED_SOURCE_CODE VIEW
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
-- 5. CLEAN UP PERMISSION ENTRIES (added in v0.31.0)
-- ============================================================================

DELETE FROM metadata.permission_roles
WHERE permission_id IN (
    SELECT id FROM metadata.permissions
    WHERE table_name = 'civic_os_users_private'
      AND permission IN ('create', 'update')
);

DELETE FROM metadata.permissions
WHERE table_name = 'civic_os_users_private'
  AND permission IN ('create', 'update');


-- ============================================================================
-- 6. DROP TABLES (CASCADE cleans up triggers, indexes, RLS)
-- ============================================================================

DROP TABLE IF EXISTS metadata.role_can_manage CASCADE;
DROP TABLE IF EXISTS metadata.user_provisioning CASCADE;


-- ============================================================================
-- 7. RESTORE schema_entities VIEW (remove managed_users from exclusion list)
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN ('time_slot_series', 'time_slot_instances', 'civic_os_users')
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with Virtual Entities support.
     Tables are auto-discovered; VIEWs require explicit metadata.entities entry.
     VIEWs with INSTEAD OF triggers can behave like tables for CRUD operations.
     System/framework views (schema_*, time_slot_*, civic_os_users) are excluded.
     Updated in v0.28.1.';


-- ============================================================================
-- 8. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
