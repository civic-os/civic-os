-- Revert civic_os:v0-29-0-source-code-visibility from pg

BEGIN;

-- ============================================================================
-- 1. DROP NEW OBJECTS (order matters: views depend on metadata.parsed_source_code)
-- ============================================================================

DROP VIEW IF EXISTS public.schema_rls_policies;
DROP FUNCTION IF EXISTS public.get_entity_source_code(NAME);
DROP VIEW IF EXISTS public.parsed_source_code;

-- schema_functions LEFT JOINs metadata.parsed_source_code, so we must
-- drop/recreate schema_functions BEFORE dropping the table.

-- ============================================================================
-- 2. RESTORE schema_functions VIEW (without source_code, language columns)
-- ============================================================================

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
    END AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN metadata.rpc_functions rf ON rf.function_name = p.proname
LEFT JOIN entity_effects ee ON ee.function_name = p.proname
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
      'schema_relations_func',
      'set_created_at', 'set_updated_at', 'set_file_created_by',
      'add_status_change_note', 'add_payment_status_change_note',
      'add_reservation_status_change_note', 'validate_status_entity_type',
      'enqueue_notification_job', 'create_notification', 'create_default_notification_preferences',
      'notify_new_reservation_request', 'notify_reservation_status_change',
      'insert_s3_presign_job', 'insert_thumbnail_job', 'create_payment_intent_sync',
      'cleanup_old_validation_results', 'get_validation_results',
      'get_preview_results', 'preview_template_parts', 'validate_template_parts',
      'get_upload_url', 'request_upload_url',
      'format_public_display_name'
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
    'Catalog-first view of public functions with optional metadata overlay. Extension functions are in plugins schema; internal helpers are in metadata schema; framework RPCs are filtered by name.';


-- ============================================================================
-- 3. RESTORE schema_triggers VIEW (without trigger_definition, function_source)
-- ============================================================================

DROP VIEW IF EXISTS public.schema_triggers;

CREATE VIEW public.schema_triggers
WITH (security_invoker = true) AS
WITH
trigger_effects AS (
    SELECT
        tee.trigger_name,
        tee.trigger_table,
        tee.trigger_schema,
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', tee.affected_table,
            'effect', tee.effect_type,
            'auto_detected', tee.is_auto_detected,
            'description', tee.description
        )) FILTER (
            WHERE metadata.has_permission(tee.affected_table::TEXT, 'read'::TEXT)
        ) AS visible_effects,
        COUNT(*) FILTER (
            WHERE NOT metadata.has_permission(tee.affected_table::TEXT, 'read'::TEXT)
        )::INT AS hidden_count
    FROM metadata.trigger_entity_effects tee
    GROUP BY tee.trigger_name, tee.trigger_table, tee.trigger_schema
)
SELECT
    t.tgname AS trigger_name,
    c.relname AS table_name,
    n.nspname::NAME AS schema_name,
    CASE
        WHEN (t.tgtype::int & 2) != 0 THEN 'BEFORE'
        WHEN (t.tgtype::int & 64) != 0 THEN 'INSTEAD OF'
        ELSE 'AFTER'
    END::VARCHAR(10) AS timing,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN (t.tgtype::int & 4) != 0 THEN 'INSERT'::VARCHAR(20) END,
        CASE WHEN (t.tgtype::int & 8) != 0 THEN 'DELETE'::VARCHAR(20) END,
        CASE WHEN (t.tgtype::int & 16) != 0 THEN 'UPDATE'::VARCHAR(20) END
    ], NULL) AS events,
    proc.proname AS function_name,
    COALESCE(dt.display_name, initcap(replace(t.tgname::text, '_', ' '))) AS display_name,
    dt.description,
    dt.purpose,
    t.tgenabled != 'D' AS is_enabled,
    dt.trigger_name IS NOT NULL AS is_registered,
    COALESCE(te.visible_effects, '[]'::jsonb) AS entity_effects,
    COALESCE(te.hidden_count, 0) AS hidden_effects_count
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc proc ON proc.oid = t.tgfoid
LEFT JOIN metadata.database_triggers dt
    ON dt.trigger_name = t.tgname
    AND dt.table_name = c.relname
    AND dt.schema_name = n.nspname
LEFT JOIN trigger_effects te
    ON te.trigger_name = t.tgname
    AND te.trigger_table = c.relname
    AND te.trigger_schema = n.nspname
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND metadata.has_permission(c.relname::TEXT, 'read'::TEXT);

COMMENT ON VIEW public.schema_triggers IS
    'Catalog-first view of public triggers with optional metadata overlay.';


-- ============================================================================
-- 4. DROP parsed_source_code TABLE (safe now that schema_functions is recreated without the JOIN)
-- ============================================================================

DROP TABLE IF EXISTS metadata.parsed_source_code;

-- ============================================================================
-- 5. RE-GRANT PERMISSIONS
-- ============================================================================

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;
GRANT SELECT ON public.schema_triggers TO authenticated, web_anon;

COMMIT;
