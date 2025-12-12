-- Deploy civic_os:v0-18-1-refactor-entity-action-permissions to pg
-- requires: v0-18-0-entity-actions

BEGIN;

-- ============================================================================
-- REFACTOR: ENTITY ACTION PERMISSIONS
-- ============================================================================
-- Version: v0.18.1
-- Purpose: Simplify permission model - entity_actions is the source of truth,
--          permissions attach directly to actions (not RPCs).
--
-- Changes:
--   - NEW: metadata.entity_action_roles - junction table for action permissions
--   - UPDATED: has_entity_action_permission() - check by action ID
--   - UPDATED: schema_entity_actions view - use new permission check
--   - REMOVED: metadata.protected_rpcs (entity_actions is the registry)
--   - REMOVED: metadata.protected_rpc_roles (replaced by entity_action_roles)
--
-- Model:
--   entity_actions (source of truth) → entity_action_roles (role grants)
-- ============================================================================


-- ============================================================================
-- 1. CREATE NEW ENTITY ACTION ROLES TABLE
-- ============================================================================

CREATE TABLE metadata.entity_action_roles (
    entity_action_id INT NOT NULL REFERENCES metadata.entity_actions(id) ON DELETE CASCADE,
    role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity_action_id, role_id)
);

COMMENT ON TABLE metadata.entity_action_roles IS
    'Junction table mapping entity actions to roles that can execute them.
     Admins always have access regardless of this table.
     Actions without any role grants are inaccessible to non-admins.';

-- Index for reverse lookup (which actions can a role execute)
CREATE INDEX idx_entity_action_roles_role ON metadata.entity_action_roles(role_id);


-- ============================================================================
-- 2. MIGRATE EXISTING DATA
-- ============================================================================
-- Transfer permissions from protected_rpc_roles to entity_action_roles
-- by matching rpc_function names.

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id, created_at)
SELECT DISTINCT ea.id, prr.role_id, prr.created_at
FROM metadata.protected_rpc_roles prr
JOIN metadata.entity_actions ea ON ea.rpc_function = prr.rpc_function
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 3. NEW PERMISSION CHECK FUNCTION
-- ============================================================================
-- Check if current user can execute an entity action by ID.

CREATE OR REPLACE FUNCTION public.has_entity_action_permission(p_action_id INT)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
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
            AND r.display_name = ANY(public.get_user_roles())
        )
$$;

COMMENT ON FUNCTION public.has_entity_action_permission(INT) IS
    'Check if current user can execute an entity action.
     Returns true if: (1) user is admin, or (2) user has a role with permission.
     Actions without role grants are only accessible to admins.';


-- ============================================================================
-- 4. UPDATE VIEW TO USE NEW PERMISSION CHECK
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
    -- Permission check using new function
    public.has_entity_action_permission(ea.id) AS can_execute
FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

COMMENT ON VIEW public.schema_entity_actions IS
    'Read-only view of entity actions with permission check results.
     can_execute indicates whether the current user can execute the action.
     Uses security_invoker to evaluate permissions as the calling user.';


-- ============================================================================
-- 5. ROW LEVEL SECURITY FOR NEW TABLE
-- ============================================================================

ALTER TABLE metadata.entity_action_roles ENABLE ROW LEVEL SECURITY;

-- Everyone can read, admins can modify
CREATE POLICY entity_action_roles_select ON metadata.entity_action_roles
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY entity_action_roles_admin ON metadata.entity_action_roles
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());


-- ============================================================================
-- 6. GRANTS FOR NEW TABLE
-- ============================================================================

GRANT SELECT ON metadata.entity_action_roles TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.entity_action_roles TO authenticated;


-- ============================================================================
-- 7. DROP OLD TABLES AND FUNCTION
-- ============================================================================

-- Drop old permission check function
DROP FUNCTION IF EXISTS public.has_rpc_permission(NAME);

-- Drop old tables (order matters due to FK)
DROP TABLE IF EXISTS metadata.protected_rpc_roles;
DROP TABLE IF EXISTS metadata.protected_rpcs;


-- ============================================================================
-- 8. RPC FUNCTIONS FOR ADMIN UI
-- ============================================================================
-- These functions allow the Permissions management page to read/write
-- entity action role assignments.

-- Get entity action IDs that a role has permission to execute
CREATE OR REPLACE FUNCTION public.get_entity_action_roles(p_role_id INT)
RETURNS TABLE(entity_action_id INT)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT ear.entity_action_id
    FROM metadata.entity_action_roles ear
    WHERE ear.role_id = p_role_id
$$;

COMMENT ON FUNCTION public.get_entity_action_roles(INT) IS
    'Get entity action IDs that a specific role has permission to execute.
     Used by Permissions management UI.';

-- Grant entity action permission to a role (admin only)
CREATE OR REPLACE FUNCTION public.grant_entity_action_permission(
    p_action_id INT,
    p_role_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Admin check
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Admin access required');
    END IF;

    -- Insert permission (ignore duplicates)
    INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
    VALUES (p_action_id, p_role_id)
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.grant_entity_action_permission(INT, INT) IS
    'Grant permission for a role to execute an entity action.
     Admin only. Idempotent - ignores duplicate grants.';

-- Revoke entity action permission from a role (admin only)
CREATE OR REPLACE FUNCTION public.revoke_entity_action_permission(
    p_action_id INT,
    p_role_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Admin check
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Admin access required');
    END IF;

    -- Delete permission
    DELETE FROM metadata.entity_action_roles
    WHERE entity_action_id = p_action_id AND role_id = p_role_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.revoke_entity_action_permission(INT, INT) IS
    'Revoke permission for a role to execute an entity action.
     Admin only. Idempotent - safe to call if permission does not exist.';

-- Grant execute permissions on RPCs
GRANT EXECUTE ON FUNCTION public.get_entity_action_roles(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_entity_action_permission(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_entity_action_permission(INT, INT) TO authenticated;


-- ============================================================================
-- 9. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
