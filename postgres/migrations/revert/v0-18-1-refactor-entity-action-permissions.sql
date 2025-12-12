-- Revert civic_os:v0-18-1-refactor-entity-action-permissions from pg

BEGIN;

-- ============================================================================
-- REVERT: Restore original protected_rpcs permission model
-- ============================================================================

-- 1. Recreate old tables
CREATE TABLE metadata.protected_rpcs (
    rpc_function NAME PRIMARY KEY,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE metadata.protected_rpc_roles (
    rpc_function NAME NOT NULL REFERENCES metadata.protected_rpcs(rpc_function) ON DELETE CASCADE,
    role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rpc_function, role_id)
);

CREATE INDEX idx_protected_rpc_roles_role ON metadata.protected_rpc_roles(role_id);

-- 2. Migrate data back (best effort - may lose some mappings if RPCs were renamed)
INSERT INTO metadata.protected_rpcs (rpc_function, description)
SELECT DISTINCT ea.rpc_function, 'Migrated from entity_action_roles'
FROM metadata.entity_actions ea
JOIN metadata.entity_action_roles ear ON ear.entity_action_id = ea.id
ON CONFLICT DO NOTHING;

INSERT INTO metadata.protected_rpc_roles (rpc_function, role_id, created_at)
SELECT DISTINCT ea.rpc_function, ear.role_id, ear.created_at
FROM metadata.entity_action_roles ear
JOIN metadata.entity_actions ea ON ea.id = ear.entity_action_id
ON CONFLICT DO NOTHING;

-- 3. Restore old permission function
CREATE OR REPLACE FUNCTION public.has_rpc_permission(p_rpc_function NAME)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT
        public.is_admin()
        OR
        EXISTS (
            SELECT 1
            FROM metadata.protected_rpc_roles prr
            JOIN metadata.roles r ON r.id = prr.role_id
            WHERE prr.rpc_function = p_rpc_function
            AND r.display_name = ANY(public.get_user_roles())
        )
$$;

-- 4. Restore old view
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
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM metadata.protected_rpcs
            WHERE rpc_function = ea.rpc_function
        )
        THEN true
        ELSE public.has_rpc_permission(ea.rpc_function)
    END AS can_execute
FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

-- 5. RLS for restored tables
ALTER TABLE metadata.protected_rpcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.protected_rpc_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY protected_rpcs_select ON metadata.protected_rpcs
    FOR SELECT TO PUBLIC USING (true);
CREATE POLICY protected_rpcs_admin ON metadata.protected_rpcs
    FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY protected_rpc_roles_select ON metadata.protected_rpc_roles
    FOR SELECT TO PUBLIC USING (true);
CREATE POLICY protected_rpc_roles_admin ON metadata.protected_rpc_roles
    FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 6. Grants
GRANT SELECT ON metadata.protected_rpcs TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.protected_rpcs TO authenticated;
GRANT SELECT ON metadata.protected_rpc_roles TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.protected_rpc_roles TO authenticated;

-- 7. Drop new functions and table
DROP FUNCTION IF EXISTS public.has_entity_action_permission(INT);
DROP FUNCTION IF EXISTS public.get_entity_action_roles(INT);
DROP FUNCTION IF EXISTS public.grant_entity_action_permission(INT, INT);
DROP FUNCTION IF EXISTS public.revoke_entity_action_permission(INT, INT);
DROP TABLE IF EXISTS metadata.entity_action_roles;

NOTIFY pgrst, 'reload schema';

COMMIT;
