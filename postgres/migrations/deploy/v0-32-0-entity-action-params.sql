-- Deploy civic_os:v0-32-0-entity-action-params to pg
-- requires: v0-31-0-edit-user-info

BEGIN;

-- ============================================================================
-- ENTITY ACTION PARAMETERS
-- ============================================================================
-- Version: v0.32.0
-- Purpose: Allow entity actions to accept user-provided parameters (text,
--          number, boolean, status dropdown, FK dropdown, file upload, etc.)
--          rendered as form fields in the confirmation modal.
--
-- Tables:
--   metadata.entity_action_params - Parameter definitions per action
--
-- Views:
--   public.schema_entity_actions - Updated to embed parameters JSON array
--
-- Design:
--   Actions with parameters always show the confirmation modal.
--   Parameters are passed alongside p_entity_id to the RPC function.
--   Supported param_types mirror EntityPropertyType where applicable.
-- ============================================================================


-- ============================================================================
-- 1. ENTITY ACTION PARAMS TABLE
-- ============================================================================

CREATE TABLE metadata.entity_action_params (
    id SERIAL PRIMARY KEY,

    -- Parent action
    entity_action_id INT NOT NULL
        REFERENCES metadata.entity_actions(id) ON DELETE CASCADE,

    -- Parameter definition
    param_name VARCHAR(100) NOT NULL,    -- RPC parameter name (e.g., 'p_reason')
    display_name TEXT NOT NULL,          -- Label in modal form
    param_type VARCHAR(20) NOT NULL,     -- Input type (see CHECK below)
    required BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,

    -- Optional UI hints
    placeholder TEXT,
    default_value TEXT,                  -- Cast by frontend based on param_type

    -- Foreign key type configuration
    join_table NAME,                     -- For 'foreign_key' type: source table
    join_column NAME,                    -- For 'foreign_key' type: display column

    -- Status type configuration
    status_entity_type NAME,             -- For 'status' type: entity_type discriminator

    -- File type configuration
    file_type VARCHAR(20),               -- For 'file' type: 'image', 'pdf', 'any'

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ========================================================================
    -- CONSTRAINTS
    -- ========================================================================

    -- Unique param name per action
    CONSTRAINT entity_action_params_unique
        UNIQUE(entity_action_id, param_name),

    -- Valid param_type values
    CONSTRAINT entity_action_params_valid_type CHECK (
        param_type IN (
            'text', 'text_short', 'number', 'boolean',
            'money', 'date', 'datetime', 'datetime_local',
            'color', 'email', 'telephone',
            'status', 'foreign_key', 'user', 'file',
            'geo_point', 'time_slot'
        )
    ),

    -- file requires file_type
    CONSTRAINT entity_action_params_file_requires_file_type CHECK (
        NOT (param_type = 'file') OR file_type IS NOT NULL
    ),

    -- file_type must be valid
    CONSTRAINT entity_action_params_valid_file_type CHECK (
        file_type IS NULL OR file_type IN ('image', 'pdf', 'any')
    ),

    -- file_type only for file type
    CONSTRAINT entity_action_params_file_type_only_file CHECK (
        param_type = 'file' OR file_type IS NULL
    ),

    -- foreign_key requires both join_table and join_column
    CONSTRAINT entity_action_params_fk_requires_join CHECK (
        NOT (param_type = 'foreign_key') OR (join_table IS NOT NULL AND join_column IS NOT NULL)
    ),

    -- join_table and join_column are both set or both NULL
    CONSTRAINT entity_action_params_join_pair CHECK (
        (join_table IS NULL) = (join_column IS NULL)
    ),

    -- join fields only for foreign_key type
    CONSTRAINT entity_action_params_join_only_fk CHECK (
        param_type IN ('foreign_key') OR (join_table IS NULL AND join_column IS NULL)
    ),

    -- status requires status_entity_type
    CONSTRAINT entity_action_params_status_requires_entity_type CHECK (
        NOT (param_type = 'status') OR status_entity_type IS NOT NULL
    ),

    -- status_entity_type only for status type
    CONSTRAINT entity_action_params_status_entity_type_only CHECK (
        param_type = 'status' OR status_entity_type IS NULL
    )
);

COMMENT ON TABLE metadata.entity_action_params IS
    'Parameter definitions for entity action buttons.
     Parameters are rendered as form fields in the action confirmation modal.
     Values are passed alongside p_entity_id to the RPC function.
     Added in v0.32.0.

     MAINTENANCE NOTE: When adding a new EntityPropertyType, check if it
     should also be added as an entity_action_params.param_type.';

COMMENT ON COLUMN metadata.entity_action_params.param_name IS
    'RPC parameter name (e.g., ''p_reason''). Must match the function signature.';

COMMENT ON COLUMN metadata.entity_action_params.param_type IS
    'Input control type. Mirrors EntityPropertyType where applicable:
     text (TextLong), text_short (TextShort), number, boolean, money,
     date, datetime (no TZ), datetime_local (UTC), color, email, telephone,
     status (dropdown), foreign_key (dropdown), user (dropdown), file (upload),
     geo_point (map picker), time_slot (range picker).';


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Primary lookup: params for an action
CREATE INDEX idx_entity_action_params_action
    ON metadata.entity_action_params(entity_action_id);

-- Sorted listing
CREATE INDEX idx_entity_action_params_sort
    ON metadata.entity_action_params(entity_action_id, sort_order);


-- ============================================================================
-- 3. TIMESTAMPS TRIGGER
-- ============================================================================

CREATE TRIGGER set_entity_action_params_updated_at
    BEFORE UPDATE ON metadata.entity_action_params
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================================
-- Same pattern as entity_actions: everyone reads, admins modify.

ALTER TABLE metadata.entity_action_params ENABLE ROW LEVEL SECURITY;

CREATE POLICY entity_action_params_select ON metadata.entity_action_params
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY entity_action_params_admin ON metadata.entity_action_params
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());


-- ============================================================================
-- 5. GRANTS
-- ============================================================================

GRANT SELECT ON metadata.entity_action_params TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.entity_action_params TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.entity_action_params_id_seq TO authenticated;


-- ============================================================================
-- 6. UPDATE schema_entity_actions VIEW TO EMBED PARAMS
-- ============================================================================
-- Replaces the existing view to add a 'parameters' column containing
-- the action's params as a JSON array, sorted by sort_order.

CREATE OR REPLACE VIEW public.schema_entity_actions
WITH (security_invoker = true)
AS
SELECT
    ea.id,
    ea.table_name,
    ea.action_name,
    ea.display_name,
    ea.description,
    ea.icon,
    ea.button_style,
    ea.sort_order,
    ea.rpc_function,
    ea.requires_confirmation,
    ea.confirmation_message,
    ea.visibility_condition,
    ea.enabled_condition,
    ea.disabled_tooltip,
    ea.default_success_message,
    ea.default_navigate_to,
    ea.refresh_after_action,
    ea.show_on_detail,
    -- Permission check using entity_action_roles
    public.has_entity_action_permission(ea.id) AS can_execute,
    -- Embedded parameters (v0.32.0)
    COALESCE(
        (SELECT json_agg(
            json_build_object(
                'id', p.id,
                'param_name', p.param_name,
                'display_name', p.display_name,
                'param_type', p.param_type,
                'required', p.required,
                'sort_order', p.sort_order,
                'placeholder', p.placeholder,
                'default_value', p.default_value,
                'join_table', p.join_table,
                'join_column', p.join_column,
                'status_entity_type', p.status_entity_type,
                'file_type', p.file_type
            ) ORDER BY p.sort_order
        )
        FROM metadata.entity_action_params p
        WHERE p.entity_action_id = ea.id),
        '[]'::json
    ) AS parameters
FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

COMMENT ON VIEW public.schema_entity_actions IS
    'Read-only view of entity actions with permission check results and embedded parameters.
     can_execute indicates whether the current user can execute the action.
     parameters contains JSON array of action parameter definitions.
     Uses security_invoker to evaluate permissions as the calling user.';


-- ============================================================================
-- 7. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
