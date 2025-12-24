-- Deploy civic-os:v0-23-0-system-introspection to pg
-- requires: v0-22-0-add-scheduled-jobs
-- System Introspection: RPC registry, trigger documentation, entity dependency graphs
-- Version: 0.23.0

BEGIN;

-- ============================================================================
-- SYSTEM INTROSPECTION SCHEMA
-- ============================================================================
-- This migration adds database introspection capabilities for auto-generated
-- documentation, dependency visualization, and safe function exposure.
--
-- Key tables:
--   - rpc_functions: Registry of documented RPC functions
--   - database_triggers: Registry of documented triggers
--   - rpc_entity_effects: What entities each RPC modifies
--   - trigger_entity_effects: What entities each trigger modifies
--   - notification_triggers: When notifications are sent
--
-- Key views:
--   - schema_functions: Permission-filtered RPC metadata
--   - schema_triggers: Permission-filtered trigger metadata
--   - schema_entity_dependencies: Unified structural + behavioral dependencies
--   - schema_notifications: Notification trigger documentation
--   - schema_permissions_matrix: Admin-only RBAC overview
--   - schema_scheduled_functions: Admin-only scheduled job info
-- ============================================================================


-- ============================================================================
-- 1. RPC FUNCTION REGISTRY
-- ============================================================================
-- Registry of RPC functions with documentation for auto-generated user guides.
-- Functions must be explicitly registered; this is opt-in, not auto-discovery.

CREATE TABLE metadata.rpc_functions (
    function_name NAME PRIMARY KEY,
    schema_name NAME NOT NULL DEFAULT 'public',
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50),  -- 'workflow', 'crud', 'utility', 'payment', 'notification'
    parameters JSONB,      -- [{"name": "p_id", "type": "BIGINT", "description": "..."}]
    returns_type VARCHAR(100),
    returns_description TEXT,
    is_idempotent BOOLEAN DEFAULT FALSE,
    minimum_role VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE metadata.rpc_functions IS
    'Registry of RPC functions with documentation for auto-generated user guides.
     Functions must be explicitly registered; this is opt-in, not auto-discovery.';

COMMENT ON COLUMN metadata.rpc_functions.function_name IS
    'Name of the PostgreSQL function (without schema prefix).';

COMMENT ON COLUMN metadata.rpc_functions.schema_name IS
    'Schema where the function is defined. Defaults to public.';

COMMENT ON COLUMN metadata.rpc_functions.category IS
    'Function category: workflow, crud, utility, payment, notification.';

COMMENT ON COLUMN metadata.rpc_functions.parameters IS
    'JSONB array of parameter definitions: [{name, type, description}].';

COMMENT ON COLUMN metadata.rpc_functions.is_idempotent IS
    'Whether calling the function multiple times has the same effect as once.';

COMMENT ON COLUMN metadata.rpc_functions.minimum_role IS
    'Minimum role required to execute this function (informational).';


-- ============================================================================
-- 2. DATABASE TRIGGER REGISTRY
-- ============================================================================
-- Registry of database triggers with human-readable documentation.
-- Triggers must be explicitly registered for documentation purposes.

CREATE TABLE metadata.database_triggers (
    trigger_name NAME NOT NULL,
    table_name NAME NOT NULL,
    schema_name NAME NOT NULL DEFAULT 'public',
    timing VARCHAR(10) NOT NULL CHECK (timing IN ('BEFORE', 'AFTER', 'INSTEAD OF')),
    events VARCHAR(20)[] NOT NULL,   -- ['INSERT', 'UPDATE', 'DELETE']
    function_name NAME NOT NULL,
    display_name VARCHAR(100),
    description TEXT NOT NULL,
    purpose VARCHAR(50),  -- 'audit', 'validation', 'cascade', 'notification', 'workflow'
    is_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (trigger_name, table_name, schema_name)
);

COMMENT ON TABLE metadata.database_triggers IS
    'Registry of database triggers with human-readable documentation.
     Triggers must be explicitly registered for documentation purposes.';

COMMENT ON COLUMN metadata.database_triggers.timing IS
    'When the trigger fires: BEFORE, AFTER, or INSTEAD OF.';

COMMENT ON COLUMN metadata.database_triggers.events IS
    'Array of events that fire the trigger: INSERT, UPDATE, DELETE.';

COMMENT ON COLUMN metadata.database_triggers.purpose IS
    'Purpose category: audit, validation, cascade, notification, workflow.';


-- ============================================================================
-- 3. ENTITY EFFECTS TABLES
-- ============================================================================
-- Track what entities each function/trigger modifies.

-- RPC → Entity effects
CREATE TABLE metadata.rpc_entity_effects (
    id SERIAL PRIMARY KEY,
    function_name NAME NOT NULL REFERENCES metadata.rpc_functions(function_name) ON DELETE CASCADE,
    entity_table NAME NOT NULL,
    effect_type VARCHAR(20) NOT NULL CHECK (effect_type IN ('create', 'read', 'update', 'delete')),
    description TEXT,
    is_auto_detected BOOLEAN DEFAULT FALSE,  -- TRUE if from static analysis
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (function_name, entity_table, effect_type)
);

COMMENT ON TABLE metadata.rpc_entity_effects IS
    'Maps RPC functions to the entities they affect, with effect type (CRUD).';

COMMENT ON COLUMN metadata.rpc_entity_effects.is_auto_detected IS
    'TRUE if this effect was detected by static analysis of function body.';


-- Trigger → Entity effects
CREATE TABLE metadata.trigger_entity_effects (
    id SERIAL PRIMARY KEY,
    trigger_name NAME NOT NULL,
    trigger_table NAME NOT NULL,
    trigger_schema NAME NOT NULL DEFAULT 'public',
    affected_table NAME NOT NULL,
    effect_type VARCHAR(20) NOT NULL CHECK (effect_type IN ('create', 'read', 'update', 'delete')),
    description TEXT,
    is_auto_detected BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (trigger_name, trigger_table, trigger_schema)
        REFERENCES metadata.database_triggers ON DELETE CASCADE
);

COMMENT ON TABLE metadata.trigger_entity_effects IS
    'Maps triggers to entities they affect beyond their source table.';


-- ============================================================================
-- 4. NOTIFICATION TRIGGERS
-- ============================================================================
-- Documents when and how notifications are sent.

CREATE TABLE metadata.notification_triggers (
    id SERIAL PRIMARY KEY,
    trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('rpc', 'trigger', 'manual')),
    source_function NAME,                 -- RPC or trigger function
    source_table NAME,
    template_id INT REFERENCES metadata.notification_templates(id) ON DELETE SET NULL,
    trigger_condition TEXT,               -- Human-readable condition
    recipient_description TEXT,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE metadata.notification_triggers IS
    'Documents when notifications are sent, linking sources to templates.';

COMMENT ON COLUMN metadata.notification_triggers.trigger_type IS
    'How the notification is triggered: rpc, trigger, or manual.';

COMMENT ON COLUMN metadata.notification_triggers.trigger_condition IS
    'Human-readable description of when the notification fires.';


-- ============================================================================
-- 5. UPDATE TRIGGERS
-- ============================================================================
-- Automatically update updated_at timestamps.

CREATE OR REPLACE FUNCTION metadata.update_introspection_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_rpc_functions_timestamp
    BEFORE UPDATE ON metadata.rpc_functions
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();

CREATE TRIGGER update_database_triggers_timestamp
    BEFORE UPDATE ON metadata.database_triggers
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();

CREATE TRIGGER update_rpc_entity_effects_timestamp
    BEFORE UPDATE ON metadata.rpc_entity_effects
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();

CREATE TRIGGER update_trigger_entity_effects_timestamp
    BEFORE UPDATE ON metadata.trigger_entity_effects
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();

CREATE TRIGGER update_notification_triggers_timestamp
    BEFORE UPDATE ON metadata.notification_triggers
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();


-- ============================================================================
-- 6. STATIC ANALYSIS FUNCTION
-- ============================================================================
-- Parses pg_proc.prosrc to extract table references with confidence levels.

CREATE OR REPLACE FUNCTION metadata.analyze_function_dependencies(p_function_name NAME)
RETURNS TABLE (
    table_name NAME,
    effect_type VARCHAR(20),
    confidence VARCHAR(20)  -- 'high', 'medium', 'low'
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog
AS $$
DECLARE
    v_source TEXT;
    v_match TEXT[];
BEGIN
    -- Get function source from pg_proc (not exposed to users)
    SELECT p.prosrc INTO v_source
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = p_function_name AND n.nspname = 'public';

    IF v_source IS NULL THEN
        RETURN;
    END IF;

    -- Upper-case for case-insensitive matching
    v_source := upper(v_source);

    -- INSERT INTO pattern (high confidence)
    FOR v_match IN
        SELECT regexp_matches(v_source, 'INSERT\s+INTO\s+([A-Z_][A-Z0-9_]*)', 'g')
    LOOP
        RETURN QUERY SELECT
            lower(v_match[1])::NAME,
            'create'::VARCHAR(20),
            'high'::VARCHAR(20);
    END LOOP;

    -- UPDATE pattern (high confidence)
    FOR v_match IN
        SELECT regexp_matches(v_source, 'UPDATE\s+([A-Z_][A-Z0-9_]*)', 'g')
    LOOP
        RETURN QUERY SELECT
            lower(v_match[1])::NAME,
            'update'::VARCHAR(20),
            'high'::VARCHAR(20);
    END LOOP;

    -- DELETE FROM pattern (high confidence)
    FOR v_match IN
        SELECT regexp_matches(v_source, 'DELETE\s+FROM\s+([A-Z_][A-Z0-9_]*)', 'g')
    LOOP
        RETURN QUERY SELECT
            lower(v_match[1])::NAME,
            'delete'::VARCHAR(20),
            'high'::VARCHAR(20);
    END LOOP;

    -- SELECT FROM pattern (medium confidence - could be read-only)
    FOR v_match IN
        SELECT regexp_matches(v_source, 'FROM\s+([A-Z_][A-Z0-9_]*)', 'g')
    LOOP
        -- Skip if already captured as write operation
        RETURN QUERY SELECT
            lower(v_match[1])::NAME,
            'read'::VARCHAR(20),
            'medium'::VARCHAR(20);
    END LOOP;

    -- JOIN pattern (medium confidence)
    FOR v_match IN
        SELECT regexp_matches(v_source, 'JOIN\s+([A-Z_][A-Z0-9_]*)', 'g')
    LOOP
        RETURN QUERY SELECT
            lower(v_match[1])::NAME,
            'read'::VARCHAR(20),
            'medium'::VARCHAR(20);
    END LOOP;
END;
$$;

COMMENT ON FUNCTION metadata.analyze_function_dependencies IS
    'Parses function source to detect table references. Returns table name, effect type, and confidence level.';


-- ============================================================================
-- 7. AUTO-REGISTRATION HELPERS
-- ============================================================================

-- Register a single function with auto-detection of entity effects
CREATE OR REPLACE FUNCTION metadata.auto_register_function(
    p_function_name NAME,
    p_display_name VARCHAR(100) DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_category VARCHAR(50) DEFAULT 'utility'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_dep RECORD;
BEGIN
    -- Insert or update function metadata
    INSERT INTO metadata.rpc_functions (function_name, display_name, description, category)
    VALUES (
        p_function_name,
        COALESCE(p_display_name, p_function_name::VARCHAR(100)),
        p_description,
        p_category
    )
    ON CONFLICT (function_name) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, metadata.rpc_functions.display_name),
        description = COALESCE(EXCLUDED.description, metadata.rpc_functions.description),
        category = COALESCE(EXCLUDED.category, metadata.rpc_functions.category),
        updated_at = NOW();

    -- Auto-detect entity effects from function body
    FOR v_dep IN SELECT DISTINCT * FROM metadata.analyze_function_dependencies(p_function_name) LOOP
        INSERT INTO metadata.rpc_entity_effects
            (function_name, entity_table, effect_type, is_auto_detected)
        VALUES (p_function_name, v_dep.table_name, v_dep.effect_type, TRUE)
        ON CONFLICT (function_name, entity_table, effect_type) DO NOTHING;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION metadata.auto_register_function IS
    'Register an RPC function with optional metadata. Automatically detects entity effects via static analysis.';


-- Bulk register all public RPC functions
CREATE OR REPLACE FUNCTION metadata.auto_register_all_rpcs()
RETURNS TABLE (function_name NAME, effects_found INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, pg_catalog, public
AS $$
DECLARE
    v_func RECORD;
    v_count INT;
BEGIN
    FOR v_func IN
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.proname NOT LIKE 'pg_%'
          AND p.proname NOT LIKE 'schema_%'
          AND p.proname NOT LIKE 'postgis_%'
          AND p.proname NOT LIKE '_st_%'
          -- Skip known framework functions that shouldn't be documented
          AND p.proname NOT IN ('current_user_id', 'current_user_email', 'has_permission', 'is_admin', 'get_user_roles')
    LOOP
        PERFORM metadata.auto_register_function(v_func.proname);

        SELECT COUNT(*) INTO v_count
        FROM metadata.rpc_entity_effects ree
        WHERE ree.function_name = v_func.proname;

        function_name := v_func.proname;
        effects_found := v_count;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION metadata.auto_register_all_rpcs IS
    'Bulk-register all public RPC functions. Returns count of detected entity effects per function.';


-- ============================================================================
-- 8. PUBLIC VIEWS
-- ============================================================================

-- 8.1 schema_functions: Permission-filtered RPC metadata
CREATE OR REPLACE VIEW public.schema_functions
WITH (security_invoker = true) AS
SELECT
    rf.function_name,
    rf.schema_name,
    rf.display_name,
    rf.description,
    rf.category,
    rf.parameters,
    rf.returns_type,
    rf.returns_description,
    rf.is_idempotent,
    rf.minimum_role,

    -- Filtered entity effects (only readable tables)
    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', ree.entity_table,
            'effect', ree.effect_type,
            'auto_detected', ree.is_auto_detected,
            'description', ree.description
        )) FILTER (
            WHERE ree.id IS NOT NULL
              AND public.has_permission(ree.entity_table::TEXT, 'read')
        ),
        '[]'::jsonb
    ) AS entity_effects,

    -- Count of hidden effects (transparency without disclosure)
    COUNT(*) FILTER (
        WHERE ree.id IS NOT NULL
          AND NOT public.has_permission(ree.entity_table::TEXT, 'read')
    )::INT AS hidden_effects_count,

    -- Schedule indicator
    EXISTS (
        SELECT 1 FROM metadata.scheduled_jobs sj
        WHERE sj.function_name = rf.function_name::VARCHAR(200)
          AND sj.enabled = true
    ) AS has_active_schedule,

    -- Permission check for execution (via entity_actions if protected)
    CASE
        -- If this RPC is protected via entity_actions, check permission
        WHEN EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = rf.function_name)
        THEN EXISTS (
            SELECT 1 FROM metadata.entity_actions ea
            WHERE ea.rpc_function = rf.function_name
              AND public.has_entity_action_permission(ea.id)
        )
        -- Unprotected RPCs are executable by all authenticated users
        ELSE true
    END AS can_execute

FROM metadata.rpc_functions rf
LEFT JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
WHERE
    -- Show if user can execute (unprotected or has permission)
    (NOT EXISTS (SELECT 1 FROM metadata.entity_actions ea WHERE ea.rpc_function = rf.function_name)
     OR EXISTS (
         SELECT 1 FROM metadata.entity_actions ea
         WHERE ea.rpc_function = rf.function_name
           AND public.has_entity_action_permission(ea.id)
     ))
    -- OR if user can read any affected table
    OR EXISTS (
        SELECT 1 FROM metadata.rpc_entity_effects ree2
        WHERE ree2.function_name = rf.function_name
          AND public.has_permission(ree2.entity_table::TEXT, 'read')
    )
GROUP BY rf.function_name, rf.schema_name, rf.display_name, rf.description,
         rf.category, rf.parameters, rf.returns_type, rf.returns_description,
         rf.is_idempotent, rf.minimum_role;

COMMENT ON VIEW public.schema_functions IS
    'Permission-filtered view of registered RPC functions with entity effects.';


-- 8.2 schema_triggers: Permission-filtered trigger metadata
CREATE OR REPLACE VIEW public.schema_triggers
WITH (security_invoker = true) AS
SELECT
    dt.trigger_name,
    dt.table_name,
    dt.schema_name,
    dt.timing,
    dt.events,
    dt.function_name,
    dt.display_name,
    dt.description,
    dt.purpose,
    dt.is_enabled,

    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'table', tee.affected_table,
            'effect', tee.effect_type,
            'auto_detected', tee.is_auto_detected
        )) FILTER (
            WHERE tee.id IS NOT NULL
              AND public.has_permission(tee.affected_table::TEXT, 'read')
        ),
        '[]'::jsonb
    ) AS entity_effects,

    COUNT(*) FILTER (
        WHERE tee.id IS NOT NULL
          AND NOT public.has_permission(tee.affected_table::TEXT, 'read')
    )::INT AS hidden_effects_count

FROM metadata.database_triggers dt
LEFT JOIN metadata.trigger_entity_effects tee
    ON tee.trigger_name = dt.trigger_name
    AND tee.trigger_table = dt.table_name
    AND tee.trigger_schema = dt.schema_name
WHERE public.has_permission(dt.table_name::TEXT, 'read')
GROUP BY dt.trigger_name, dt.table_name, dt.schema_name, dt.timing, dt.events,
         dt.function_name, dt.display_name, dt.description, dt.purpose, dt.is_enabled;

COMMENT ON VIEW public.schema_triggers IS
    'Permission-filtered view of registered database triggers with entity effects.';


-- 8.3 schema_entity_dependencies: Unified dependency graph
-- NOTE: Uses pg_catalog instead of information_schema because the latter
-- filters results based on role privileges, hiding FK metadata from non-superusers.
CREATE OR REPLACE VIEW public.schema_entity_dependencies
WITH (security_invoker = true) AS
WITH
-- Foreign key relationships (structural)
-- Query pg_catalog directly to avoid information_schema's privilege filtering
fk_deps AS (
    SELECT DISTINCT
        source_class.relname::NAME AS source_entity,
        target_class.relname::NAME AS target_entity,
        'foreign_key'::TEXT AS relationship_type,
        a.attname::TEXT AS via_column,
        NULL::NAME AS via_object,
        'structural'::TEXT AS category
    FROM pg_constraint con
    JOIN pg_class source_class ON source_class.oid = con.conrelid
    JOIN pg_class target_class ON target_class.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = source_class.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'  -- foreign key constraint
      AND ns.nspname = 'public'
),
-- Many-to-many relationships (structural) - detected from junction tables
m2m_deps AS (
    WITH junction_candidates AS (
        SELECT
            sp.table_name AS junction_table,
            array_agg(sp.column_name ORDER BY sp.column_name) AS fk_columns,
            array_agg(sp.join_table ORDER BY sp.column_name) AS related_tables
        FROM public.schema_properties sp
        WHERE sp.join_table IS NOT NULL
          AND sp.join_schema = 'public'
        GROUP BY sp.table_name
        HAVING COUNT(*) = 2
    ),
    validated_junctions AS (
        SELECT jc.*
        FROM junction_candidates jc
        WHERE NOT EXISTS (
            SELECT 1 FROM public.schema_properties sp
            WHERE sp.table_name = jc.junction_table
              AND sp.column_name NOT IN (
                  'id', 'created_at', 'updated_at',
                  jc.fk_columns[1], jc.fk_columns[2]
              )
        )
    )
    -- Direction 1: table[1] -> table[2]
    SELECT
        vj.related_tables[1]::NAME AS source_entity,
        vj.related_tables[2]::NAME AS target_entity,
        'many_to_many'::TEXT AS relationship_type,
        vj.fk_columns[1]::TEXT AS via_column,
        vj.junction_table::NAME AS via_object,
        'structural'::TEXT AS category
    FROM validated_junctions vj
    UNION ALL
    -- Direction 2: table[2] -> table[1] (bidirectional)
    SELECT
        vj.related_tables[2]::NAME AS source_entity,
        vj.related_tables[1]::NAME AS target_entity,
        'many_to_many'::TEXT AS relationship_type,
        vj.fk_columns[2]::TEXT AS via_column,
        vj.junction_table::NAME AS via_object,
        'structural'::TEXT AS category
    FROM validated_junctions vj
),
-- RPC effects (behavioral)
rpc_deps AS (
    SELECT DISTINCT
        ea.table_name::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'rpc_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        rf.function_name::NAME AS via_object,
        'behavioral'::TEXT AS category
    FROM metadata.entity_actions ea
    JOIN metadata.rpc_functions rf ON rf.function_name = ea.rpc_function
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
    WHERE ree.entity_table != ea.table_name
      AND ree.effect_type != 'read'
),
-- Trigger effects (behavioral)
trigger_deps AS (
    SELECT DISTINCT
        dt.table_name::NAME AS source_entity,
        tee.affected_table::NAME AS target_entity,
        'trigger_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        dt.function_name::NAME AS via_object,
        'behavioral'::TEXT AS category
    FROM metadata.database_triggers dt
    JOIN metadata.trigger_entity_effects tee
        ON tee.trigger_name = dt.trigger_name
        AND tee.trigger_table = dt.table_name
        AND tee.trigger_schema = dt.schema_name
    WHERE tee.affected_table != dt.table_name
),
all_deps AS (
    SELECT * FROM fk_deps
    UNION ALL SELECT * FROM m2m_deps
    UNION ALL SELECT * FROM rpc_deps
    UNION ALL SELECT * FROM trigger_deps
)
SELECT *
FROM all_deps
WHERE public.has_permission(source_entity::TEXT, 'read')
  AND public.has_permission(target_entity::TEXT, 'read');

COMMENT ON VIEW public.schema_entity_dependencies IS
    'Unified view of all entity relationships: structural (FK, M:M) and behavioral (RPC, trigger effects).';


-- 8.4 schema_notifications: Notification trigger documentation
CREATE OR REPLACE VIEW public.schema_notifications
WITH (security_invoker = true) AS
SELECT
    nt.id,
    nt.trigger_type,
    nt.source_function,
    nt.source_table,
    t.name AS template_name,
    t.subject_template,
    t.entity_type AS template_entity_type,
    nt.trigger_condition,
    nt.recipient_description,
    nt.description
FROM metadata.notification_triggers nt
LEFT JOIN metadata.notification_templates t ON t.id = nt.template_id
WHERE nt.source_table IS NULL
   OR public.has_permission(nt.source_table::TEXT, 'read');

COMMENT ON VIEW public.schema_notifications IS
    'Permission-filtered view of notification trigger documentation.';


-- 8.5 schema_permissions_matrix: Admin-only RBAC overview
CREATE OR REPLACE VIEW public.schema_permissions_matrix
WITH (security_invoker = true) AS
SELECT
    e.table_name,
    e.display_name AS entity_name,
    r.id AS role_id,
    r.display_name AS role_name,
    COALESCE(bool_or(p.permission = 'create' AND pr.role_id IS NOT NULL), false) AS can_create,
    COALESCE(bool_or(p.permission = 'read' AND pr.role_id IS NOT NULL), false) AS can_read,
    COALESCE(bool_or(p.permission = 'update' AND pr.role_id IS NOT NULL), false) AS can_update,
    COALESCE(bool_or(p.permission = 'delete' AND pr.role_id IS NOT NULL), false) AS can_delete
FROM metadata.entities e
CROSS JOIN metadata.roles r
LEFT JOIN metadata.permissions p ON p.table_name = e.table_name
LEFT JOIN metadata.permission_roles pr ON pr.permission_id = p.id AND pr.role_id = r.id
WHERE public.is_admin()  -- Admin-only
GROUP BY e.table_name, e.display_name, e.sort_order, r.id, r.display_name
ORDER BY e.sort_order NULLS LAST, e.table_name, r.id;

COMMENT ON VIEW public.schema_permissions_matrix IS
    'Admin-only view showing CRUD permissions per entity per role.';


-- 8.6 schema_scheduled_functions: Admin-only scheduled job info
CREATE OR REPLACE VIEW public.schema_scheduled_functions
WITH (security_invoker = true) AS
SELECT
    rf.function_name,
    rf.display_name,
    rf.description,
    rf.category,
    sj.name AS job_name,
    sj.schedule AS cron_schedule,
    sj.timezone,
    sj.enabled AS schedule_enabled,
    sj.last_run_at,
    sjs.last_run_success,
    sjs.success_rate_percent
FROM metadata.rpc_functions rf
JOIN metadata.scheduled_jobs sj ON sj.function_name = rf.function_name::VARCHAR(200)
LEFT JOIN public.scheduled_job_status sjs ON sjs.id = sj.id
WHERE public.is_admin();  -- Admin-only for schedule details

COMMENT ON VIEW public.schema_scheduled_functions IS
    'Admin-only view showing RPC functions that run on a schedule with execution statistics.';


-- ============================================================================
-- 9. UPDATE SCHEMA_CACHE_VERSIONS
-- ============================================================================
-- Add introspection cache type for frontend cache invalidation.

DROP VIEW IF EXISTS public.schema_cache_versions;

CREATE VIEW public.schema_cache_versions AS
SELECT 'entities' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.entities),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permissions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.roles),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.permission_roles)
       ) AS version
UNION ALL
SELECT 'properties' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.properties),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.validations)
       ) AS version
UNION ALL
SELECT 'constraint_messages' AS cache_name,
       (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.constraint_messages) AS version
UNION ALL
-- NEW: Introspection cache
SELECT 'introspection' AS cache_name,
       GREATEST(
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_functions),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.database_triggers),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.rpc_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.trigger_entity_effects),
           (SELECT COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM metadata.notification_triggers)
       ) AS version;

COMMENT ON VIEW public.schema_cache_versions IS
    'Cache version timestamps for frontend cache invalidation. Includes entities, properties, constraint_messages, and introspection.';


-- ============================================================================
-- 10. PERMISSIONS
-- ============================================================================

-- Grant SELECT on new views to authenticated and anonymous users
GRANT SELECT ON public.schema_functions TO authenticated, web_anon;
GRANT SELECT ON public.schema_triggers TO authenticated, web_anon;
GRANT SELECT ON public.schema_entity_dependencies TO authenticated, web_anon;
GRANT SELECT ON public.schema_notifications TO authenticated, web_anon;
GRANT SELECT ON public.schema_permissions_matrix TO authenticated;  -- Admin check in view
GRANT SELECT ON public.schema_scheduled_functions TO authenticated;  -- Admin check in view
GRANT SELECT ON public.schema_cache_versions TO authenticated, web_anon;

-- Grant SELECT on metadata tables for view access
-- Both authenticated and web_anon need access since views use security_invoker
-- The views filter results based on has_permission() checks
GRANT SELECT ON metadata.rpc_functions TO authenticated, web_anon;
GRANT SELECT ON metadata.database_triggers TO authenticated, web_anon;
GRANT SELECT ON metadata.rpc_entity_effects TO authenticated, web_anon;
GRANT SELECT ON metadata.trigger_entity_effects TO authenticated, web_anon;
GRANT SELECT ON metadata.notification_triggers TO authenticated, web_anon;

-- schema_functions references scheduled_jobs for has_active_schedule
GRANT SELECT ON metadata.scheduled_jobs TO authenticated, web_anon;

-- schema_functions and schema_entity_dependencies reference entity_actions
GRANT SELECT ON metadata.entity_actions TO authenticated, web_anon;

-- schema_notifications references notification_templates
GRANT SELECT ON metadata.notification_templates TO authenticated, web_anon;

-- Grant sequence usage
GRANT USAGE, SELECT ON SEQUENCE metadata.rpc_entity_effects_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.trigger_entity_effects_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.notification_triggers_id_seq TO authenticated;

-- Grant EXECUTE on helper functions (admin only via RPC)
GRANT EXECUTE ON FUNCTION metadata.analyze_function_dependencies(NAME) TO authenticated;
GRANT EXECUTE ON FUNCTION metadata.auto_register_function(NAME, VARCHAR, TEXT, VARCHAR) TO authenticated;
GRANT EXECUTE ON FUNCTION metadata.auto_register_all_rpcs() TO authenticated;


-- ============================================================================
-- 11. INDEXES
-- ============================================================================

CREATE INDEX idx_rpc_functions_category ON metadata.rpc_functions(category);
CREATE INDEX idx_rpc_entity_effects_function ON metadata.rpc_entity_effects(function_name);
CREATE INDEX idx_rpc_entity_effects_table ON metadata.rpc_entity_effects(entity_table);
CREATE INDEX idx_trigger_entity_effects_trigger ON metadata.trigger_entity_effects(trigger_name, trigger_table, trigger_schema);
CREATE INDEX idx_trigger_entity_effects_table ON metadata.trigger_entity_effects(affected_table);
CREATE INDEX idx_notification_triggers_source ON metadata.notification_triggers(source_table);
CREATE INDEX idx_notification_triggers_template ON metadata.notification_triggers(template_id);


-- ============================================================================
-- 12. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
