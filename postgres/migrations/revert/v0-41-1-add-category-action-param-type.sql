-- Revert civic_os:v0-41-1-add-category-action-param-type from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE schema_entity_actions VIEW (without category_entity_type)
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
-- 2. DROP CATEGORY CONSTRAINTS
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    DROP CONSTRAINT IF EXISTS entity_action_params_category_requires_entity_type;

ALTER TABLE metadata.entity_action_params
    DROP CONSTRAINT IF EXISTS entity_action_params_category_entity_type_only;


-- ============================================================================
-- 3. RESTORE ORIGINAL VALID TYPE CONSTRAINT (without 'category')
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    DROP CONSTRAINT entity_action_params_valid_type;

ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_valid_type CHECK (
        param_type IN (
            'text', 'text_short', 'number', 'boolean',
            'money', 'date', 'datetime', 'datetime_local',
            'color', 'email', 'telephone',
            'status', 'foreign_key', 'user', 'file',
            'geo_point', 'time_slot'
        )
    );


-- ============================================================================
-- 4. DROP COLUMN
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    DROP COLUMN IF EXISTS category_entity_type;


-- ============================================================================
-- 5. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
