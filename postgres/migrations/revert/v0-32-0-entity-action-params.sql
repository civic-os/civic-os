-- Revert civic_os:v0-32-0-entity-action-params from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE PREVIOUS schema_entity_actions VIEW (without parameters column)
-- ============================================================================
-- Must DROP first because CREATE OR REPLACE cannot remove columns from a view.

DROP VIEW IF EXISTS public.schema_entity_actions;

CREATE VIEW public.schema_entity_actions
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
    public.has_entity_action_permission(ea.id) AS can_execute
FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;


-- ============================================================================
-- 2. DROP ENTITY ACTION PARAMS TABLE (cascades policies, indexes, triggers)
-- ============================================================================

DROP TABLE IF EXISTS metadata.entity_action_params CASCADE;


-- ============================================================================
-- 3. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
