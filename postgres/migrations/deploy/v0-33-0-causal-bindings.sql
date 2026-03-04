-- Deploy civic_os:v0-33-0-causal-bindings to pg
-- requires: v0-32-0-fix-database-search-path

BEGIN;

-- ============================================================================
-- CAUSAL BINDINGS: Event-to-Function Metadata
-- ============================================================================
-- Version: v0.33.0
-- Purpose: Create metadata infrastructure for formalized event-to-function
--          bindings, making causal relationships (what happens at runtime)
--          queryable from metadata instead of buried in PL/pgSQL function bodies.
--
-- Tables:
--   metadata.status_transitions        - Allowed transitions between statuses
--   metadata.property_change_triggers  - Property-level event-to-function bindings
--
-- Views:
--   schema_entity_dependencies (updated) - 'behavioral' → 'causal' rename,
--                                          new CTEs for property_trigger and
--                                          status_transition dependencies
--
-- Functions:
--   add_status_transition()            - Ergonomic helper using status_key
--   add_property_change_trigger()      - Helper for property change registration
-- ============================================================================


-- ============================================================================
-- 1. STATUS TRANSITIONS TABLE
-- ============================================================================
-- Declares allowed transitions between statuses for a given entity_type.
-- Optional on_transition_rpc binds a function to a specific transition.
-- Whether this table is purely declarative or also enforces allowed transitions
-- is deferred to a future session (the schema supports both approaches).

CREATE TABLE metadata.status_transitions (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL REFERENCES metadata.status_types(entity_type) ON DELETE CASCADE,
    from_status_id INT NOT NULL REFERENCES metadata.statuses(id) ON DELETE CASCADE,
    to_status_id INT NOT NULL REFERENCES metadata.statuses(id) ON DELETE CASCADE,
    on_transition_rpc NAME,
    display_name VARCHAR(100),
    description TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate transitions
    UNIQUE (entity_type, from_status_id, to_status_id),

    -- Cannot transition to self
    CHECK (from_status_id != to_status_id)
);

COMMENT ON TABLE metadata.status_transitions IS
    'Allowed status transitions for each entity_type. Declares the state machine '
    'graph for status workflows. Optional on_transition_rpc binds a function to '
    'a specific transition for automation.';

COMMENT ON COLUMN metadata.status_transitions.entity_type IS
    'Status category this transition belongs to. FK to status_types ensures validity.';

COMMENT ON COLUMN metadata.status_transitions.from_status_id IS
    'Source status ID. FK to metadata.statuses(id).';

COMMENT ON COLUMN metadata.status_transitions.to_status_id IS
    'Target status ID. FK to metadata.statuses(id).';

COMMENT ON COLUMN metadata.status_transitions.on_transition_rpc IS
    'Optional RPC function name to call when this transition occurs. '
    'Kept as NAME (not FK) to avoid ordering problems in init scripts.';

COMMENT ON COLUMN metadata.status_transitions.display_name IS
    'Human-readable label for this transition (e.g., "Approve", "Deny", "Reopen").';

COMMENT ON COLUMN metadata.status_transitions.description IS
    'Optional description of what this transition represents.';

COMMENT ON COLUMN metadata.status_transitions.sort_order IS
    'Display order for transitions from the same source status.';

COMMENT ON COLUMN metadata.status_transitions.is_enabled IS
    'Whether this transition is currently active. Allows soft-disabling without deletion.';

-- Indexes
CREATE INDEX idx_status_transitions_entity_type
    ON metadata.status_transitions(entity_type);
CREATE INDEX idx_status_transitions_from
    ON metadata.status_transitions(from_status_id);
CREATE INDEX idx_status_transitions_to
    ON metadata.status_transitions(to_status_id);
CREATE INDEX idx_status_transitions_rpc
    ON metadata.status_transitions(on_transition_rpc) WHERE on_transition_rpc IS NOT NULL;

-- Timestamp trigger (reuse existing introspection trigger function)
CREATE TRIGGER update_status_transitions_timestamp
    BEFORE UPDATE ON metadata.status_transitions
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();


-- ============================================================================
-- 2. PROPERTY CHANGE TRIGGERS TABLE
-- ============================================================================
-- Declares property-level event-to-function bindings. Formalizes which
-- property changes fire which functions, making these relationships queryable
-- without reading trigger source code.

CREATE TABLE metadata.property_change_triggers (
    id SERIAL PRIMARY KEY,
    table_name NAME NOT NULL,
    property_name NAME NOT NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('any', 'set', 'cleared', 'changed_to')),
    change_value TEXT,
    function_name NAME NOT NULL,
    display_name VARCHAR(100),
    description TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- change_value only meaningful for 'changed_to' type
    CHECK (
        (change_type = 'changed_to' AND change_value IS NOT NULL) OR
        (change_type != 'changed_to' AND change_value IS NULL)
    )
);

COMMENT ON TABLE metadata.property_change_triggers IS
    'Declares property-level event-to-function bindings. Records which property '
    'changes fire which functions, making causal relationships queryable from metadata.';

COMMENT ON COLUMN metadata.property_change_triggers.table_name IS
    'The public schema table containing the property.';

COMMENT ON COLUMN metadata.property_change_triggers.property_name IS
    'The column name whose changes trigger the function.';

COMMENT ON COLUMN metadata.property_change_triggers.change_type IS
    'Type of change that triggers the function: '
    '''any'' = any modification, '
    '''set'' = value set from NULL to non-NULL, '
    '''cleared'' = value set from non-NULL to NULL, '
    '''changed_to'' = value changed to specific change_value.';

COMMENT ON COLUMN metadata.property_change_triggers.change_value IS
    'Required when change_type = ''changed_to''. The specific value that triggers the function. '
    'Stored as TEXT for flexibility (cast as needed in the function).';

COMMENT ON COLUMN metadata.property_change_triggers.function_name IS
    'PostgreSQL function to invoke when the property change occurs. '
    'Kept as NAME (not FK) to avoid ordering problems in init scripts.';

COMMENT ON COLUMN metadata.property_change_triggers.display_name IS
    'Human-readable label for this binding (e.g., "Notify reviewer on assignment").';

COMMENT ON COLUMN metadata.property_change_triggers.description IS
    'Optional description of what this binding does and why.';

COMMENT ON COLUMN metadata.property_change_triggers.is_enabled IS
    'Whether this binding is currently active. Allows soft-disabling without deletion.';

-- Unique binding per table/property/change_type/value/function
-- Must be a CREATE UNIQUE INDEX (not inline UNIQUE) because COALESCE is an expression
CREATE UNIQUE INDEX idx_property_change_triggers_unique
    ON metadata.property_change_triggers(table_name, property_name, change_type, COALESCE(change_value, ''), function_name);

-- Indexes
CREATE INDEX idx_property_change_triggers_table
    ON metadata.property_change_triggers(table_name);
CREATE INDEX idx_property_change_triggers_table_property
    ON metadata.property_change_triggers(table_name, property_name);
CREATE INDEX idx_property_change_triggers_function
    ON metadata.property_change_triggers(function_name);

-- Timestamp trigger
CREATE TRIGGER update_property_change_triggers_timestamp
    BEFORE UPDATE ON metadata.property_change_triggers
    FOR EACH ROW EXECUTE FUNCTION metadata.update_introspection_timestamp();


-- ============================================================================
-- 3. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- status_transitions: everyone reads, admins modify
ALTER TABLE metadata.status_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY status_transitions_select ON metadata.status_transitions
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY status_transitions_insert ON metadata.status_transitions
    FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY status_transitions_update ON metadata.status_transitions
    FOR UPDATE TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY status_transitions_delete ON metadata.status_transitions
    FOR DELETE TO authenticated USING (public.is_admin());

-- property_change_triggers: everyone reads, admins modify
ALTER TABLE metadata.property_change_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY property_change_triggers_select ON metadata.property_change_triggers
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY property_change_triggers_insert ON metadata.property_change_triggers
    FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY property_change_triggers_update ON metadata.property_change_triggers
    FOR UPDATE TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY property_change_triggers_delete ON metadata.property_change_triggers
    FOR DELETE TO authenticated USING (public.is_admin());


-- ============================================================================
-- 4. GRANTS
-- ============================================================================

-- status_transitions
GRANT SELECT ON metadata.status_transitions TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.status_transitions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.status_transitions_id_seq TO authenticated;

-- property_change_triggers
GRANT SELECT ON metadata.property_change_triggers TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.property_change_triggers TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.property_change_triggers_id_seq TO authenticated;


-- ============================================================================
-- 5. HELPER FUNCTIONS
-- ============================================================================

-- add_status_transition: Ergonomic helper that accepts status_key strings
-- instead of raw IDs, resolving them via get_status_id().
CREATE OR REPLACE FUNCTION public.add_status_transition(
    p_entity_type TEXT,
    p_from_key TEXT,
    p_to_key TEXT,
    p_on_transition_rpc NAME DEFAULT NULL,
    p_display_name VARCHAR(100) DEFAULT NULL,
    p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_from_id INT;
    v_to_id INT;
    v_result_id INT;
BEGIN
    -- Require admin
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only admins can add status transitions';
    END IF;

    -- Resolve status keys to IDs
    v_from_id := public.get_status_id(p_entity_type, p_from_key);
    v_to_id := public.get_status_id(p_entity_type, p_to_key);

    IF v_from_id IS NULL THEN
        RAISE EXCEPTION 'Status key "%" not found for entity_type "%"', p_from_key, p_entity_type;
    END IF;

    IF v_to_id IS NULL THEN
        RAISE EXCEPTION 'Status key "%" not found for entity_type "%"', p_to_key, p_entity_type;
    END IF;

    INSERT INTO metadata.status_transitions (
        entity_type, from_status_id, to_status_id,
        on_transition_rpc, display_name, description
    ) VALUES (
        p_entity_type, v_from_id, v_to_id,
        p_on_transition_rpc, p_display_name, p_description
    )
    ON CONFLICT (entity_type, from_status_id, to_status_id) DO UPDATE SET
        on_transition_rpc = COALESCE(EXCLUDED.on_transition_rpc, metadata.status_transitions.on_transition_rpc),
        display_name = COALESCE(EXCLUDED.display_name, metadata.status_transitions.display_name),
        description = COALESCE(EXCLUDED.description, metadata.status_transitions.description)
    RETURNING id INTO v_result_id;

    RETURN v_result_id;
END;
$$;

COMMENT ON FUNCTION public.add_status_transition IS
    'Add an allowed status transition using status_key strings. '
    'Resolves keys via get_status_id() for ergonomic init script usage. '
    'Upserts on conflict to allow idempotent re-runs.';

GRANT EXECUTE ON FUNCTION public.add_status_transition(TEXT, TEXT, TEXT, NAME, VARCHAR, TEXT) TO authenticated;


-- add_property_change_trigger: Helper for registering property change bindings
CREATE OR REPLACE FUNCTION public.add_property_change_trigger(
    p_table_name NAME,
    p_property_name NAME,
    p_change_type TEXT,
    p_function_name NAME,
    p_display_name VARCHAR(100) DEFAULT NULL,
    p_change_value TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_result_id INT;
BEGIN
    -- Require admin
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only admins can add property change triggers';
    END IF;

    -- Validate change_type
    IF p_change_type NOT IN ('any', 'set', 'cleared', 'changed_to') THEN
        RAISE EXCEPTION 'Invalid change_type "%". Must be: any, set, cleared, changed_to', p_change_type;
    END IF;

    -- Validate change_value consistency
    IF p_change_type = 'changed_to' AND p_change_value IS NULL THEN
        RAISE EXCEPTION 'change_value is required when change_type = ''changed_to''';
    END IF;
    IF p_change_type != 'changed_to' AND p_change_value IS NOT NULL THEN
        RAISE EXCEPTION 'change_value must be NULL when change_type != ''changed_to''';
    END IF;

    INSERT INTO metadata.property_change_triggers (
        table_name, property_name, change_type, change_value,
        function_name, display_name, description
    ) VALUES (
        p_table_name, p_property_name, p_change_type, p_change_value,
        p_function_name, p_display_name, p_description
    )
    ON CONFLICT (table_name, property_name, change_type, COALESCE(change_value, ''), function_name) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, metadata.property_change_triggers.display_name),
        description = COALESCE(EXCLUDED.description, metadata.property_change_triggers.description)
    RETURNING id INTO v_result_id;

    RETURN v_result_id;
END;
$$;

COMMENT ON FUNCTION public.add_property_change_trigger IS
    'Register a property change binding that declares which function runs when '
    'a specific property change occurs. Upserts on conflict for idempotent init scripts.';

GRANT EXECUTE ON FUNCTION public.add_property_change_trigger(NAME, NAME, TEXT, NAME, VARCHAR, TEXT, TEXT) TO authenticated;


-- ============================================================================
-- 6. UPDATED schema_entity_dependencies VIEW
-- ============================================================================
-- Replace 'behavioral' category with 'causal' and add new CTEs for
-- property_trigger and status_transition dependencies.
-- Column set is unchanged (source_entity, target_entity, relationship_type,
-- via_column, via_object, category), so CREATE OR REPLACE works in-place.

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
    WHERE con.contype = 'f'
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
-- RPC effects (causal) — renamed from 'behavioral' per Introspection UX Design
rpc_deps AS (
    SELECT DISTINCT
        ea.table_name::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'rpc_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        rf.function_name::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.entity_actions ea
    JOIN metadata.rpc_functions rf ON rf.function_name = ea.rpc_function
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = rf.function_name
    WHERE ree.entity_table != ea.table_name
      AND ree.effect_type != 'read'
),
-- Trigger effects (causal) — renamed from 'behavioral'
trigger_deps AS (
    SELECT DISTINCT
        dt.table_name::NAME AS source_entity,
        tee.affected_table::NAME AS target_entity,
        'trigger_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        dt.function_name::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.database_triggers dt
    JOIN metadata.trigger_entity_effects tee
        ON tee.trigger_name = dt.trigger_name
        AND tee.trigger_table = dt.table_name
        AND tee.trigger_schema = dt.schema_name
    WHERE tee.affected_table != dt.table_name
),
-- Property change trigger effects (causal) — NEW
-- Links property change declarations to their target entities via rpc_entity_effects
property_trigger_deps AS (
    SELECT DISTINCT
        pct.table_name::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'property_trigger_modifies'::TEXT AS relationship_type,
        pct.property_name::TEXT AS via_column,
        pct.function_name::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.property_change_triggers pct
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = pct.function_name
    WHERE ree.entity_table != pct.table_name
      AND ree.effect_type != 'read'
      AND pct.is_enabled = true
),
-- Status transition RPC effects (causal) — NEW
-- Links status transition RPCs to their target entities via rpc_entity_effects
status_transition_deps AS (
    SELECT DISTINCT
        -- The source entity is the table that has statuses of this entity_type.
        -- We derive it from the entity_type convention (entity_type often matches table name
        -- but may not; use the transition's entity_type as source_entity for consistency).
        st.entity_type::NAME AS source_entity,
        ree.entity_table::NAME AS target_entity,
        'status_transition_modifies'::TEXT AS relationship_type,
        NULL::TEXT AS via_column,
        st.on_transition_rpc::NAME AS via_object,
        'causal'::TEXT AS category
    FROM metadata.status_transitions st
    JOIN metadata.rpc_entity_effects ree ON ree.function_name = st.on_transition_rpc
    WHERE st.on_transition_rpc IS NOT NULL
      AND st.is_enabled = true
      AND ree.effect_type != 'read'
),
all_deps AS (
    SELECT * FROM fk_deps
    UNION ALL SELECT * FROM m2m_deps
    UNION ALL SELECT * FROM rpc_deps
    UNION ALL SELECT * FROM trigger_deps
    UNION ALL SELECT * FROM property_trigger_deps
    UNION ALL SELECT * FROM status_transition_deps
)
SELECT *
FROM all_deps
WHERE public.has_permission(source_entity::TEXT, 'read')
  AND public.has_permission(target_entity::TEXT, 'read');

COMMENT ON VIEW public.schema_entity_dependencies IS
    'Unified view of all entity relationships: structural (FK, M:M) and causal (RPC, trigger, property change, status transition effects).';


-- ============================================================================
-- 7. SCHEMA DECISION
-- ============================================================================

-- Direct INSERT (not create_schema_decision RPC) because migrations run as
-- postgres superuser which doesn't have JWT claims for is_admin() check.
INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id, title, status,
    context, decision, decided_date
) VALUES (
    ARRAY['statuses']::NAME[],
    ARRAY[]::NAME[],
    'v0-33-0-causal-bindings',
    'Formalized event-to-function bindings for causal chain queryability',
    'accepted',
    'Causal relationships (what happens at runtime) were buried in PL/pgSQL function bodies. '
        'To answer "what function runs when a permit goes from Pending to Approved?" required reading trigger source code. '
        'The Introspection UX Design (docs/design/INTROSPECTION_UX_DESIGN.md) established that causal chains need '
        'to be queryable from metadata to enable statechart visualization and context diagrams.',
    'Created metadata.status_transitions table for allowed status transitions with optional RPC binding, '
        'and metadata.property_change_triggers table for property-level event-to-function bindings. '
        'Updated schema_entity_dependencies view to rename ''behavioral'' category to ''causal'' and add new '
        'CTEs for property_trigger_modifies and status_transition_modifies relationship types. '
        'Both tables use NAME for function references (not FK to rpc_functions) to avoid ordering problems in init scripts. '
        'Whether status_transitions enforces allowed transitions (vs purely declarative) is deferred to a future session.',
    CURRENT_DATE
);


-- ============================================================================
-- 8. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
