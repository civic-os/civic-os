-- Deploy civic_os:v0-65-6-fix-entity-action-role-key to pg
-- requires: v0-65-2-profile-i18n-fixes

BEGIN;

-- ============================================================================
-- FIX: has_entity_action_permission() — use role_key instead of display_name
-- ============================================================================
-- Version: v0.65.6
-- Bug: v0-18-1 originally compared JWT roles against r.display_name.
--      v0-36-0 introduced role_key and updated has_permission(), has_role(),
--      and other RBAC functions to use role_key for JWT matching — but missed
--      this function. Any instance with custom roles where role_key differs
--      from display_name (e.g., "IC Staff" vs "ic_staff") silently fails
--      all entity action permission checks for those roles.
-- Fix: r.display_name → r.role_key (one-line change)
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.has_entity_action_permission(p_action_id INT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        -- Admin bypass: admins can execute any entity action
        public.is_admin()
        OR
        -- Check if user has a role that grants permission
        EXISTS (
            SELECT 1
            FROM metadata.entity_action_roles ear
            JOIN metadata.roles r ON r.id = ear.role_id
            WHERE ear.entity_action_id = p_action_id
            AND r.role_key = ANY(public.get_user_roles())
        )
$$;

COMMIT;
