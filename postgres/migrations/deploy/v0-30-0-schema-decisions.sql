-- Deploy civic_os:v0-30-0-schema-decisions to pg
-- requires: v0-29-0-source-code-visibility

BEGIN;

-- ============================================================================
-- SCHEMA DECISIONS (ADR) SYSTEM
-- ============================================================================
-- Version: v0.30.0
-- Purpose: Database-native architectural decision records for tracking schema
--          evolution rationale. Decisions link to entity types and/or properties,
--          enabling integrators to document WHY a schema is designed the way it is.
--
-- Key Concepts:
--   - Decisions attach to schema objects (tables/columns), not data records
--   - Append-only with supersession model (no edits, only new decisions)
--   - Admin-only write access, authenticated read access
--   - Usable via SQL immediately; UI browse page planned for Phase 2
--
-- Pattern:
--   1. Call create_schema_decision() in init scripts alongside schema changes
--   2. Query via public.schema_decisions view through PostgREST
--   3. Supersede old decisions by referencing their ID
-- ============================================================================


-- ============================================================================
-- 1. SCHEMA_DECISIONS TABLE
-- ============================================================================

CREATE TABLE metadata.schema_decisions (
    id SERIAL PRIMARY KEY,

    -- What this decision is about (linking — arrays for cross-entity decisions)
    entity_types NAME[],                 -- Table names (NULL for system-level decisions)
    property_names NAME[],               -- Column names (NULL for entity-level decisions)
    migration_id TEXT,                   -- Sqitch migration ref (e.g. 'v0-28-0-virtual-entities')

    -- ADR content
    title VARCHAR(200) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'accepted',  -- proposed, accepted, deprecated, superseded
    context TEXT,                         -- Problem statement / current situation
    decision TEXT NOT NULL,              -- What was decided
    rationale TEXT,                       -- Why this approach over alternatives
    consequences TEXT,                   -- Expected effects, tradeoffs

    -- Lifecycle
    superseded_by_id INT REFERENCES metadata.schema_decisions(id),
    author_id UUID REFERENCES metadata.civic_os_users(id),
    decided_date DATE NOT NULL DEFAULT CURRENT_DATE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_status CHECK (status IN ('proposed', 'accepted', 'deprecated', 'superseded')),
    CONSTRAINT title_not_empty CHECK (trim(title) != ''),
    CONSTRAINT decision_not_empty CHECK (trim(decision) != '')
);

COMMENT ON TABLE metadata.schema_decisions IS
    'Database-native architectural decision records for tracking schema evolution
     rationale. Decisions link to arrays of entity types (tables) and/or property names
     (columns), supporting cross-entity decisions. Uses append-only supersession model.
     Added in v0.30.0.';

COMMENT ON COLUMN metadata.schema_decisions.entity_types IS
    'Array of table names this decision is about (NULL for system-level decisions). Supports cross-entity decisions.';

COMMENT ON COLUMN metadata.schema_decisions.property_names IS
    'Array of column names this decision is about (NULL for entity-level decisions). Requires entity_types to be set.';

COMMENT ON COLUMN metadata.schema_decisions.migration_id IS
    'Sqitch migration reference (e.g. ''v0-28-0-virtual-entities'') for traceability';

COMMENT ON COLUMN metadata.schema_decisions.status IS
    'Decision lifecycle: proposed → accepted → deprecated/superseded';

COMMENT ON COLUMN metadata.schema_decisions.superseded_by_id IS
    'Points to the newer decision that replaces this one';

COMMENT ON COLUMN metadata.schema_decisions.decided_date IS
    'Date the decision was made (not necessarily when it was recorded)';

-- Timestamps trigger (reuse existing set_updated_at)
CREATE TRIGGER set_schema_decisions_updated_at
    BEFORE UPDATE ON metadata.schema_decisions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Lookup decisions for a specific entity (GIN for array containment: WHERE 'x' = ANY(entity_types))
CREATE INDEX idx_schema_decisions_entities ON metadata.schema_decisions USING GIN(entity_types);

-- Lookup decisions for a specific property (GIN for array containment)
CREATE INDEX idx_schema_decisions_properties ON metadata.schema_decisions USING GIN(property_names);

-- Filter by status (e.g. only active decisions)
CREATE INDEX idx_schema_decisions_status ON metadata.schema_decisions(status);

-- Chronological listing
CREATE INDEX idx_schema_decisions_decided ON metadata.schema_decisions(decided_date DESC);


-- ============================================================================
-- 3. ROW LEVEL SECURITY POLICIES
-- ============================================================================

ALTER TABLE metadata.schema_decisions ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read decisions
CREATE POLICY schema_decisions_select ON metadata.schema_decisions
    FOR SELECT TO authenticated
    USING (true);

-- Only admins can create decisions
CREATE POLICY schema_decisions_insert ON metadata.schema_decisions
    FOR INSERT TO authenticated
    WITH CHECK (is_admin());

-- Only admins can update decisions (for supersession status changes)
CREATE POLICY schema_decisions_update ON metadata.schema_decisions
    FOR UPDATE TO authenticated
    USING (is_admin());


-- ============================================================================
-- 4. GRANTS
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON metadata.schema_decisions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.schema_decisions_id_seq TO authenticated;


-- ============================================================================
-- 5. RPC: CREATE_SCHEMA_DECISION
-- ============================================================================
-- Unified function for creating schema decisions from init scripts or UI.
-- Validates entity_type if provided. Handles supersession automatically.

CREATE OR REPLACE FUNCTION public.create_schema_decision(
    p_title TEXT,
    p_decision TEXT,
    p_entity_types NAME[] DEFAULT NULL,
    p_property_names NAME[] DEFAULT NULL,
    p_context TEXT DEFAULT NULL,
    p_rationale TEXT DEFAULT NULL,
    p_consequences TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'accepted',
    p_migration_id TEXT DEFAULT NULL,
    p_supersedes_id INT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_decision_id INT;
    v_author UUID;
    v_entity NAME;
BEGIN
    -- Admin-only access (SECURITY DEFINER bypasses RLS, so check explicitly)
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Admin access required';
    END IF;

    -- Determine author from JWT
    v_author := current_user_id();

    -- Validate status value
    IF p_status NOT IN ('proposed', 'accepted', 'deprecated', 'superseded') THEN
        RAISE EXCEPTION 'Invalid status: %. Must be one of: proposed, accepted, deprecated, superseded', p_status;
    END IF;

    -- Validate each entity_type in the array exists
    IF p_entity_types IS NOT NULL THEN
        FOREACH v_entity IN ARRAY p_entity_types LOOP
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = v_entity::TEXT
            ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.views
                WHERE table_schema = 'public' AND table_name = v_entity::TEXT
            ) THEN
                RAISE EXCEPTION 'Entity type does not exist: %', v_entity;
            END IF;
        END LOOP;
    END IF;

    -- Validate property_names requires entity_types
    IF p_property_names IS NOT NULL AND p_entity_types IS NULL THEN
        RAISE EXCEPTION 'property_names requires entity_types to be specified';
    END IF;

    -- Validate supersedes_id exists if provided
    IF p_supersedes_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM metadata.schema_decisions WHERE id = p_supersedes_id
        ) THEN
            RAISE EXCEPTION 'Superseded decision does not exist: %', p_supersedes_id;
        END IF;
    END IF;

    -- Insert new decision
    INSERT INTO metadata.schema_decisions (
        entity_types, property_names, migration_id,
        title, status, context, decision, rationale, consequences,
        author_id, decided_date
    ) VALUES (
        p_entity_types, p_property_names, p_migration_id,
        p_title, p_status, p_context, p_decision, p_rationale, p_consequences,
        v_author, CURRENT_DATE
    )
    RETURNING id INTO v_decision_id;

    -- Handle supersession: mark old decision as superseded
    IF p_supersedes_id IS NOT NULL THEN
        UPDATE metadata.schema_decisions
        SET status = 'superseded',
            superseded_by_id = v_decision_id
        WHERE id = p_supersedes_id;
    END IF;

    RETURN v_decision_id;
END;
$$;

COMMENT ON FUNCTION public.create_schema_decision IS
    'Create a schema decision record (ADR). Accepts arrays of entity types and
     property names for cross-entity decisions. Validates each entity_type against
     information_schema. If p_supersedes_id is provided, marks the old decision
     as superseded. Returns the new decision ID. Added in v0.30.0.';

GRANT EXECUTE ON FUNCTION public.create_schema_decision TO authenticated;


-- ============================================================================
-- 6. PERMISSION ENTRIES
-- ============================================================================

INSERT INTO metadata.permissions (table_name, permission)
VALUES
    ('schema_decisions', 'read'),
    ('schema_decisions', 'create')
ON CONFLICT DO NOTHING;

-- Grant both permissions to admin role
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'schema_decisions'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Grant read permission to editor role (can see decisions but not create)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'schema_decisions'
  AND p.permission = 'read'
  AND r.display_name = 'editor'
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 7. PUBLIC VIEW FOR POSTGREST ACCESS
-- ============================================================================

CREATE VIEW public.schema_decisions AS
SELECT
    id,
    entity_types,
    property_names,
    migration_id,
    title,
    status,
    context,
    decision,
    rationale,
    consequences,
    superseded_by_id,
    author_id,
    decided_date,
    created_at,
    updated_at
FROM metadata.schema_decisions;

COMMENT ON VIEW public.schema_decisions IS
    'Read-only view of schema decisions for PostgREST access.
     RLS on underlying table handles permissions. Added in v0.30.0.';

GRANT SELECT ON public.schema_decisions TO authenticated;


-- ============================================================================
-- 8. ADD create_schema_decision TO FRAMEWORK FUNCTION EXCLUSION LIST
-- ============================================================================
-- The schema_functions view (v0.29.0) excludes framework functions from the
-- introspection listing. We need to update the view to exclude our new RPC.
-- parsed_source_code depends on schema_functions, so drop it first and recreate after.

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
      -- v0.29.0: Exclude source code RPC itself
      'get_entity_source_code',
      -- v0.30.0: Exclude schema decisions RPC
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
-- 9. RECREATE parsed_source_code VIEW (depends on schema_functions)
-- ============================================================================
-- This view was dropped in section 8 because it depends on schema_functions.
-- Recreate it with the same definition from v0.29.0.

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
-- 10. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
