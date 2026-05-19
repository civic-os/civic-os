-- Deploy civic_os:v0-54-0-action-param-options-rpc to pg
-- requires: v0-53-0-options-filter-column

BEGIN;

-- ============================================================================
-- ACTION PARAM OPTIONS SOURCE RPC + CASCADING DEPENDENCIES
-- ============================================================================
-- Version: v0.54.0
-- Purpose: Allow entity action FK params to use custom RPCs for filtered
--          option lists, mirroring the options_source_rpc + depends_on_columns
--          pattern from metadata.properties. Enables cascading dropdowns in
--          action confirmation modals.
--
-- New columns:
--   options_source_rpc  - RPC function returning [{id, display_name}]
--   depends_on_params   - Sibling param names that trigger RPC re-fetch
--
-- RPC signature convention:
--   function_name(p_id BIGINT, p_depends_on JSONB DEFAULT '{}')
--   RETURNS TABLE(id ..., display_name TEXT)
-- ============================================================================


-- ============================================================================
-- 1. ADD COLUMNS
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    ADD COLUMN options_source_rpc NAME;

ALTER TABLE metadata.entity_action_params
    ADD COLUMN depends_on_params TEXT[];

COMMENT ON COLUMN metadata.entity_action_params.options_source_rpc IS
    'RPC function returning [{id, display_name}] for filtered FK options.
     Called with (p_id, p_depends_on) where p_id is the entity ID and
     p_depends_on is a JSONB object with sibling param values.
     When set, replaces the default join_table query. Added in v0.54.0.';

COMMENT ON COLUMN metadata.entity_action_params.depends_on_params IS
    'Array of sibling param_names whose values trigger RPC re-fetch.
     When a dependency value changes, the RPC is called with updated
     p_depends_on payload. Requires options_source_rpc. Added in v0.54.0.';


-- ============================================================================
-- 2. CONSTRAINTS
-- ============================================================================

-- depends_on_params requires options_source_rpc
ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_depends_requires_rpc CHECK (
        depends_on_params IS NULL OR options_source_rpc IS NOT NULL
    );

-- options_source_rpc only for foreign_key param type
ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_rpc_only_fk CHECK (
        options_source_rpc IS NULL OR param_type = 'foreign_key'
    );


-- ============================================================================
-- 3. UPDATE schema_entity_actions VIEW
-- ============================================================================
-- Adds options_source_rpc and depends_on_params to the embedded parameters
-- JSON array.

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
    -- Embedded parameters (v0.32.0, updated v0.41.1, v0.54.0)
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
                'category_entity_type', p.category_entity_type,
                'file_type', p.file_type,
                'options_source_rpc', p.options_source_rpc,
                'depends_on_params', p.depends_on_params
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
-- 4. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
