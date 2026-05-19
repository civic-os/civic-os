-- Deploy civic_os:v0-55-0-photo-gallery-action-param to pg
-- requires: v0-54-0-action-param-options-rpc

BEGIN;

-- ============================================================================
-- PHOTO GALLERY ACTION PARAM TYPE
-- ============================================================================
-- Version: v0.55.0
-- Purpose: Allow entity actions to include photo upload fields via the
--          photo_gallery param type. Embeds PhotoGalleryEditorComponent in
--          action modals, creating a fresh draft gallery on first upload.
--          The RPC receives the gallery UUID and links/merges as needed.
--
-- New column:
--   target_column  - Entity column name used to look up photo_gallery_config
--                    constraints (max_images, allowed_types)
--
-- Design: Gallery params always start blank. The RPC decides what to do with
--         the uploaded gallery (link, merge, replace).
-- ============================================================================


-- ============================================================================
-- 1. ADD COLUMN
-- ============================================================================

ALTER TABLE metadata.entity_action_params
    ADD COLUMN target_column NAME;

COMMENT ON COLUMN metadata.entity_action_params.target_column IS
    'Entity column name used to look up photo_gallery_config constraints
     (max_images, allowed_types). Required for photo_gallery param type.
     Added in v0.55.0.';


-- ============================================================================
-- 2. UPDATE CHECK CONSTRAINT (add photo_gallery to valid types)
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
            'geo_point', 'time_slot', 'photo_gallery'
        )
    );


-- ============================================================================
-- 3. CROSS-FIELD CONSTRAINTS
-- ============================================================================

-- photo_gallery requires target_column
ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_gallery_requires_target CHECK (
        param_type != 'photo_gallery' OR target_column IS NOT NULL
    );

-- target_column only allowed on photo_gallery type
ALTER TABLE metadata.entity_action_params
    ADD CONSTRAINT entity_action_params_target_only_gallery CHECK (
        target_column IS NULL OR param_type = 'photo_gallery'
    );


-- ============================================================================
-- 4. UPDATE schema_entity_actions VIEW
-- ============================================================================
-- Adds target_column to the embedded parameters JSON array.

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
    -- Embedded parameters (v0.32.0, updated v0.41.1, v0.54.0, v0.55.0)
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
                'depends_on_params', p.depends_on_params,
                'target_column', p.target_column
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
