-- Revert civic_os:v0-65-6-fix-entity-action-role-key from pg

BEGIN;

-- Restore the buggy version that uses display_name instead of role_key
CREATE OR REPLACE FUNCTION metadata.has_entity_action_permission(p_action_id INT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        public.is_admin()
        OR
        EXISTS (
            SELECT 1
            FROM metadata.entity_action_roles ear
            JOIN metadata.roles r ON r.id = ear.role_id
            WHERE ear.entity_action_id = p_action_id
            AND r.display_name = ANY(public.get_user_roles())
        )
$$;

COMMIT;
