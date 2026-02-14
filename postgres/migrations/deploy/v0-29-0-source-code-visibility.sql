-- Deploy civic_os:v0-29-0-source-code-visibility to pg
-- requires: v0-28-1-filter-system-views

BEGIN;

-- ============================================================================
-- SOURCE CODE VISIBILITY
-- ============================================================================
-- Version: v0.29.0
-- Purpose: Make every piece of executable SQL visible and readable, including
--          to non-technical users. Extends the introspection system (v0.23.0+)
--          to expose actual source code alongside metadata.
--
-- Key Changes:
--   1. Add source_code to schema_functions view
--   2. Add trigger_definition + function_source to schema_triggers view
--   3. Create get_entity_source_code() RPC for consolidated entity code view
--   4. Create schema_rls_policies view (admin-only)
--
-- Permission Model:
--   Source code visibility follows the same rules as metadata visibility.
--   schema_functions/schema_triggers inherit existing WHERE clauses.
--   get_entity_source_code() uses has_permission() per code type.
--   RLS policies are gated by is_admin().
-- ============================================================================


-- ============================================================================
-- 0. PARSED SOURCE CODE TABLE (for server-side PL/pgSQL AST parsing)
-- ============================================================================
-- Must be created before schema_functions view which LEFT JOINs to it.
-- The Go consolidated worker parses functions/views into AST JSON using
-- pg_query_go (libpg_query). Stored pre-parsed ASTs enable the frontend to
-- map PL/pgSQL constructs to Blockly blocks without client-side parsing.

CREATE TABLE IF NOT EXISTS metadata.parsed_source_code (
  schema_name   NAME NOT NULL DEFAULT 'public',
  object_name   NAME NOT NULL,
  object_type   TEXT NOT NULL CHECK (object_type IN ('function', 'view')),
  language      TEXT NOT NULL DEFAULT 'sql',
  source_hash   TEXT NOT NULL,
  ast_json      JSONB,
  parse_error   TEXT,
  parsed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (schema_name, object_name, object_type)
);

COMMENT ON TABLE metadata.parsed_source_code IS
    'Pre-parsed AST JSON for public functions and views. Populated by the Go
     consolidated worker using pg_query_go. Frontend fetches AST via the public
     view to map PL/pgSQL nodes to Blockly blocks. Added in v0.29.0.';

-- Grant SELECT so security_invoker views (schema_functions, schema_triggers)
-- can LEFT JOIN this table when running as authenticated/web_anon.
GRANT SELECT ON metadata.parsed_source_code TO authenticated, web_anon;


-- ============================================================================
-- 1. UPDATE schema_functions VIEW - ADD source_code COLUMN
-- ============================================================================
-- The view already joins pg_proc. We add pg_get_functiondef(p.oid) which returns
-- the full CREATE OR REPLACE FUNCTION ... statement.

DROP VIEW IF EXISTS public.schema_functions;

CREATE VIEW public.schema_functions
WITH (security_invoker = true) AS
WITH
-- Get registered entity effects per function
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

    -- Overlay metadata or use smart defaults
    COALESCE(rf.display_name, initcap(replace(p.proname::text, '_', ' '))) AS display_name,
    rf.description,
    rf.category,
    rf.parameters,

    -- Get return type from pg_proc
    pg_get_function_result(p.oid) AS returns_type,
    rf.returns_description,

    COALESCE(rf.is_idempotent, false) AS is_idempotent,
    rf.minimum_role,

    -- Entity effects (only from registered functions)
    COALESCE(ee.visible_effects, '[]'::jsonb) AS entity_effects,
    COALESCE(ee.hidden_count, 0) AS hidden_effects_count,

    -- Whether this function is registered (has custom metadata)
    rf.function_name IS NOT NULL AS is_registered,

    -- Schedule indicator
    EXISTS (
        SELECT 1 FROM metadata.scheduled_jobs sj
        WHERE sj.function_name = p.proname::TEXT
          AND sj.enabled = true
    ) AS has_active_schedule,

    -- Permission check for execution (via entity_actions if protected)
    CASE
        WHEN EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = p.proname::NAME)
        THEN EXISTS (
            SELECT 1 FROM metadata.entity_actions ea
            WHERE ea.rpc_function = p.proname::NAME
              AND metadata.has_entity_action_permission(ea.id)
        )
        ELSE true
    END AS can_execute,

    -- v0.29.0: Full function source code
    pg_get_functiondef(p.oid) AS source_code,

    -- v0.29.0: Function language (plpgsql, sql, etc.)
    l.lanname AS language,

    -- v0.29.0: Pre-parsed AST JSON (from Go worker)
    psc.ast_json

FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN metadata.rpc_functions rf ON rf.function_name = p.proname
LEFT JOIN entity_effects ee ON ee.function_name = p.proname
LEFT JOIN metadata.parsed_source_code psc
    ON psc.object_name = p.proname AND psc.object_type = 'function'

WHERE n.nspname = 'public'
  AND p.prokind = 'f'  -- functions only (not procedures/aggregates)
  -- Exclude framework functions (same list as v0.24.0)
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
      -- v0.29.0: Exclude source code RPC itself
      'get_entity_source_code'
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
    'Catalog-first view of public functions with source code. Added source_code and language columns in v0.29.0.';


-- ============================================================================
-- 2. UPDATE schema_triggers VIEW - ADD source columns
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
    COALESCE(te.hidden_count, 0) AS hidden_effects_count,

    -- v0.29.0: Full trigger definition (CREATE TRIGGER statement)
    pg_get_triggerdef(t.oid) AS trigger_definition,

    -- v0.29.0: Full source code of the trigger's function
    pg_get_functiondef(proc.oid) AS function_source

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
    'Catalog-first view of public triggers with source code. Added trigger_definition and function_source columns in v0.29.0.';


-- ============================================================================
-- 3. CREATE get_entity_source_code() RPC
-- ============================================================================
-- Returns all executable SQL code objects for an entity, permission-filtered.
-- SECURITY DEFINER to access pg_catalog reliably.

CREATE OR REPLACE FUNCTION public.get_entity_source_code(p_table_name NAME)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_result JSONB := '[]'::jsonb;
    v_hidden_count INT := 0;
    v_is_admin BOOLEAN;
    v_has_read BOOLEAN;
    v_is_view BOOLEAN;
    v_oid OID;
BEGIN
    -- Permission check: user must be able to read the entity
    v_has_read := metadata.has_permission(p_table_name::TEXT, 'read'::TEXT);
    IF NOT v_has_read THEN
        RETURN jsonb_build_object('code_objects', '[]'::jsonb, 'hidden_code_count', 0);
    END IF;

    v_is_admin := metadata.is_admin();

    -- Check if entity is a VIEW
    SELECT c.relkind = 'v', c.oid
    INTO v_is_view, v_oid
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = p_table_name;

    -- 1. VIEW DEFINITION (for virtual entities)
    IF v_is_view AND v_oid IS NOT NULL THEN
        v_result := v_result || jsonb_build_array(jsonb_build_object(
            'object_type', 'view_definition',
            'object_name', p_table_name,
            'display_name', 'View Definition',
            'description', 'SQL view that defines this virtual entity',
            'source_code', 'CREATE OR REPLACE VIEW public.' || p_table_name || ' AS' || E'\n' || pg_get_viewdef(v_oid, true),
            'language', 'sql',
            'related_table', p_table_name,
            'category', 'definition',
            'ast_json', (SELECT psc.ast_json FROM metadata.parsed_source_code psc
                         WHERE psc.object_name = p_table_name AND psc.object_type = 'view'),
            'parse_error', (SELECT psc.parse_error FROM metadata.parsed_source_code psc
                            WHERE psc.object_name = p_table_name AND psc.object_type = 'view')
        ));
    END IF;

    -- 2. RPC FUNCTIONS (via rpc_entity_effects)
    -- Use DISTINCT ON to deduplicate when a function has multiple effects
    -- on the same entity (e.g., both 'read' and 'update' effects).
    -- Includes pre-parsed AST from metadata.parsed_source_code.
    SELECT v_result || COALESCE(jsonb_agg(row_to_json(sub)::jsonb), '[]'::jsonb)
    INTO v_result
    FROM (
        SELECT DISTINCT ON (p.proname)
            'function' AS object_type,
            p.proname::TEXT AS object_name,
            COALESCE(rf.display_name, initcap(replace(p.proname::TEXT, '_', ' '))) AS display_name,
            COALESCE(rf.description, ree.description) AS description,
            pg_get_functiondef(p.oid) AS source_code,
            l.lanname AS language,
            p_table_name::TEXT AS related_table,
            COALESCE(rf.category, 'uncategorized') AS category,
            psc.ast_json,
            psc.parse_error
        FROM metadata.rpc_entity_effects ree
        JOIN pg_proc p ON p.proname = ree.function_name
        JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
        JOIN pg_language l ON l.oid = p.prolang
        LEFT JOIN metadata.rpc_functions rf ON rf.function_name = ree.function_name
        LEFT JOIN metadata.parsed_source_code psc
            ON psc.object_name = p.proname AND psc.object_type = 'function'
        WHERE ree.entity_table = p_table_name
        ORDER BY p.proname
    ) sub;

    -- 3. TRIGGERS (on this table)
    -- AST is looked up by the trigger's function name (proc.proname), not the trigger name.
    SELECT v_result || COALESCE(jsonb_agg(row_to_json(sub)::jsonb), '[]'::jsonb)
    INTO v_result
    FROM (
        SELECT
            'trigger_function' AS object_type,
            t.tgname::TEXT AS object_name,
            COALESCE(dt.display_name, initcap(replace(t.tgname::TEXT, '_', ' '))) AS display_name,
            dt.description,
            pg_get_functiondef(proc.oid) AS source_code,
            'plpgsql' AS language,
            p_table_name::TEXT AS related_table,
            COALESCE(dt.purpose, 'trigger') AS category,
            psc.ast_json,
            psc.parse_error
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        JOIN pg_proc proc ON proc.oid = t.tgfoid
        LEFT JOIN metadata.database_triggers dt
            ON dt.trigger_name = t.tgname AND dt.table_name = c.relname
        LEFT JOIN metadata.parsed_source_code psc
            ON psc.object_name = proc.proname AND psc.object_type = 'function'
        WHERE ns.nspname = 'public'
          AND c.relname = p_table_name
          AND NOT t.tgisinternal
    ) sub;

    -- 4. INSTEAD OF TRIGGER DEFINITIONS (for views)
    IF v_is_view THEN
        SELECT v_result || COALESCE(jsonb_agg(row_to_json(sub)::jsonb), '[]'::jsonb)
        INTO v_result
        FROM (
            SELECT
                'trigger_definition' AS object_type,
                t.tgname::TEXT AS object_name,
                'Trigger: ' || t.tgname::TEXT AS display_name,
                'INSTEAD OF trigger definition' AS description,
                pg_get_triggerdef(t.oid) AS source_code,
                'sql' AS language,
                p_table_name::TEXT AS related_table,
                'trigger' AS category
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'public'
              AND c.relname = p_table_name
              AND NOT t.tgisinternal
              AND (t.tgtype::int & 64) != 0  -- INSTEAD OF triggers only
        ) sub;
    END IF;

    -- 5. CHECK CONSTRAINTS
    SELECT v_result || COALESCE(jsonb_agg(row_to_json(sub)::jsonb), '[]'::jsonb)
    INTO v_result
    FROM (
        SELECT
            'check_constraint' AS object_type,
            con.conname::TEXT AS object_name,
            'CHECK: ' || con.conname::TEXT AS display_name,
            'Check constraint on ' || p_table_name::TEXT AS description,
            pg_get_constraintdef(con.oid, true) AS source_code,
            'sql' AS language,
            p_table_name::TEXT AS related_table,
            'constraint' AS category
        FROM pg_constraint con
        JOIN pg_class c ON con.conrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND c.relname = p_table_name
          AND con.contype = 'c'  -- CHECK constraints only
    ) sub;

    -- 6. COLUMN DEFAULTS (skip nextval sequences)
    SELECT v_result || COALESCE(jsonb_agg(row_to_json(sub)::jsonb), '[]'::jsonb)
    INTO v_result
    FROM (
        SELECT
            'column_default' AS object_type,
            a.attname::TEXT AS object_name,
            'Default: ' || a.attname::TEXT AS display_name,
            'Default value for column ' || a.attname::TEXT AS description,
            pg_get_expr(d.adbin, d.adrelid) AS source_code,
            'sql' AS language,
            p_table_name::TEXT AS related_table,
            'default' AS category
        FROM pg_attrdef d
        JOIN pg_attribute a ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND c.relname = p_table_name
          AND NOT a.attisdropped
          AND pg_get_expr(d.adbin, d.adrelid) NOT LIKE 'nextval(%'
    ) sub;

    -- 7. RLS POLICIES (admin-only)
    IF v_is_admin THEN
        SELECT v_result || COALESCE(jsonb_agg(row_to_json(sub)::jsonb), '[]'::jsonb)
        INTO v_result
        FROM (
            SELECT
                'rls_policy' AS object_type,
                pol.polname::TEXT AS object_name,
                'Policy: ' || pol.polname::TEXT AS display_name,
                CASE pol.polcmd
                    WHEN 'r' THEN 'SELECT policy'
                    WHEN 'a' THEN 'INSERT policy'
                    WHEN 'w' THEN 'UPDATE policy'
                    WHEN 'd' THEN 'DELETE policy'
                    ELSE 'ALL policy'
                END AS description,
                'USING (' || COALESCE(pg_get_expr(pol.polqual, pol.polrelid), 'true') || ')' ||
                CASE WHEN pol.polwithcheck IS NOT NULL
                    THEN E'\nWITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')'
                    ELSE ''
                END AS source_code,
                'sql' AS language,
                p_table_name::TEXT AS related_table,
                'security' AS category
            FROM pg_policy pol
            JOIN pg_class c ON pol.polrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = 'public'
              AND c.relname = p_table_name
        ) sub;
    ELSE
        -- Count hidden RLS policies for non-admins
        SELECT COUNT(*)
        INTO v_hidden_count
        FROM pg_policy pol
        JOIN pg_class c ON pol.polrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND c.relname = p_table_name;
    END IF;

    RETURN jsonb_build_object(
        'code_objects', v_result,
        'hidden_code_count', v_hidden_count
    );
END;
$$;

COMMENT ON FUNCTION public.get_entity_source_code(NAME) IS
    'Returns all executable SQL code objects for an entity, permission-filtered.
     Includes: view definitions, RPC functions, triggers, CHECK constraints,
     column defaults, and RLS policies (admin-only).
     Added in v0.29.0.';

-- Revoke default PUBLIC execute, then grant to both authenticated and
-- web_anon. Anonymous users can already see schema_functions/schema_triggers
-- source code via the views; this RPC follows the same permission model
-- (has_permission() filters results internally).
REVOKE EXECUTE ON FUNCTION public.get_entity_source_code(NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_source_code(NAME) TO authenticated, web_anon;


-- ============================================================================
-- 4. CREATE schema_rls_policies VIEW (admin-only)
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_rls_policies
WITH (security_invoker = true) AS
SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    pol.polname AS policy_name,
    CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
    ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) AS roles,
    CASE pol.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        ELSE 'ALL'
    END AS command,
    pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
    pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expression
FROM pg_policy pol
JOIN pg_class c ON pol.polrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public'
  AND metadata.is_admin();

COMMENT ON VIEW public.schema_rls_policies IS
    'Admin-only view of RLS policies with USING and WITH CHECK expressions. Added in v0.29.0.';

GRANT SELECT ON public.schema_rls_policies TO authenticated;


-- ============================================================================
-- 5. PARSED SOURCE CODE PUBLIC VIEW (permission-filtered)
-- ============================================================================
-- Table was created in section 0 (before schema_functions which references it).
-- This public view provides permission filtering via existing introspection views.
CREATE VIEW public.parsed_source_code
WITH (security_invoker = true) AS
SELECT psc.schema_name, psc.object_name, psc.object_type, psc.language,
       psc.ast_json, psc.parse_error, psc.parsed_at
FROM metadata.parsed_source_code psc
WHERE
  -- Functions: visible if function appears in schema_functions
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
  -- Views: visible if user has read permission on the view-as-entity
  (psc.object_type = 'view'
    AND metadata.has_permission(psc.object_name::TEXT, 'read'::TEXT));

COMMENT ON VIEW public.parsed_source_code IS
    'Permission-filtered view of pre-parsed AST JSON. Delegates visibility to
     schema_functions/schema_triggers for functions and has_permission for views.
     Added in v0.29.0.';

GRANT SELECT ON public.parsed_source_code TO authenticated, web_anon;


-- ============================================================================
-- 6. RE-GRANT PERMISSIONS
-- ============================================================================

GRANT SELECT ON public.schema_functions TO authenticated, web_anon;
GRANT SELECT ON public.schema_triggers TO authenticated, web_anon;


-- ============================================================================
-- 7. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
