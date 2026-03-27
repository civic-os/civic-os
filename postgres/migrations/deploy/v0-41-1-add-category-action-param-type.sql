-- Deploy civic_os:v0-41-1-add-category-action-param-type to pg
-- requires: v0-41-0-schema-functions-perf

BEGIN;

-- ============================================================================
-- ADD CATEGORY AS ENTITY ACTION PARAM TYPE
-- ============================================================================
-- Version: v0.41.1
-- Purpose: Add 'category' as a supported param_type for entity action
--          parameters. This was missed when the Category system was added
--          in v0.34.0. The frontend already handles this type (detail.page.ts
--          line 1155, entity.ts line 616).
--
-- Changes:
--   1. Add category_entity_type column to entity_action_params
--   2. Update valid param_type constraint to include 'category'
--   3. Add cross-field constraints (same pattern as status_entity_type)
--   4. Update schema_entity_actions VIEW to embed category_entity_type
-- ============================================================================


-- ============================================================================
-- 1. ADD COLUMN
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    ADD COLUMN category_entity_type NAME;

COMMENT ON COLUMN metadata.entity_action_params.category_entity_type IS
    'For category type: entity_type discriminator for categories lookup.
     Must match a category_groups.entity_type value. Added in v0.41.1.';


-- ============================================================================
-- 2. UPDATE VALID PARAM_TYPE CONSTRAINT
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    DROP CONSTRAINT entity_action_params_valid_type;

ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_valid_type CHECK (
        param_type IN (
            'text', 'text_short', 'number', 'boolean',
            'money', 'date', 'datetime', 'datetime_local',
            'color', 'email', 'telephone',
            'status', 'category', 'foreign_key', 'user', 'file',
            'geo_point', 'time_slot'
        )
    );


-- ============================================================================
-- 3. ADD CROSS-FIELD CONSTRAINTS (mirrors status pattern)
-- ============================================================================

-- category requires category_entity_type
ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_category_requires_entity_type CHECK (
        NOT (param_type = 'category') OR category_entity_type IS NOT NULL
    );

-- category_entity_type only for category type
ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_category_entity_type_only CHECK (
        param_type = 'category' OR category_entity_type IS NULL
    );


-- ============================================================================
-- 4. UPDATE schema_entity_actions VIEW TO INCLUDE category_entity_type
-- ============================================================================
-- Must DROP and recreate because we're adding a new key to the JSON object.

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
    -- Embedded parameters (v0.32.0, updated v0.41.1 to add category_entity_type)
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

COMMENT ON VIEW public.schema_entity_actions IS
    'Read-only view of entity actions with permission check results and embedded parameters.
     can_execute indicates whether the current user can execute the action.
     parameters contains JSON array of action parameter definitions.
     Uses security_invoker to evaluate permissions as the calling user.';


-- ============================================================================
-- 5. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
