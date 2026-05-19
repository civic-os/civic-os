-- Revert civic_os:v0-54-0-action-param-options-rpc from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE schema_entity_actions VIEW (without options_source_rpc, depends_on_params)
-- ============================================================================

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
    public.has_entity_action_permission(ea.id) AS can_execute,
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


-- ============================================================================
-- 2. DROP CONSTRAINTS
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    DROP CONSTRAINT IF EXISTS entity_action_params_depends_requires_rpc;

ALTER TABLE metadata.entity_action_params
    DROP CONSTRAINT IF EXISTS entity_action_params_rpc_only_fk;


-- ============================================================================
-- 3. DROP COLUMNS
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    DROP COLUMN IF EXISTS depends_on_params;

ALTER TABLE metadata.entity_action_params
    DROP COLUMN IF EXISTS options_source_rpc;


-- ============================================================================
-- 4. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
