-- Deploy civic_os:v0-18-0-entity-actions to pg
-- requires: v0-17-0-add-static-text

BEGIN;

-- ============================================================================
-- ENTITY ACTION BUTTONS SYSTEM
-- ============================================================================
-- Version: v0.18.0
-- Purpose: Metadata-driven action buttons on Detail pages that execute
--          PostgreSQL RPC functions with conditional visibility/enablement,
--          confirmation modals, and permission-based access control.
--
-- Tables:
--   metadata.protected_rpcs - Registry of RPCs requiring permission checks
--   metadata.protected_rpc_roles - Junction table for RPC role permissions
--   metadata.entity_actions - Action button configuration per entity
--
-- Functions:
--   public.has_rpc_permission(NAME) - Check if current user can execute RPC
--
-- Views:
--   public.schema_entity_actions - Filtered view with permission check results
--
-- Features:
--   - Admin users bypass permission checks automatically
--   - Conditional visibility based on record data
--   - Conditional enablement (disabled with tooltip)
--   - Confirmation modals with custom messages
--   - RPC response handling (success/error messages, navigation, refresh)
-- ============================================================================


-- ============================================================================
-- 1. RPC PERMISSIONS TABLES
-- ============================================================================
-- Registry of protected RPCs and which roles can execute them.
-- Unprotected RPCs (not in protected_rpcs) are accessible to all authenticated.

CREATE TABLE metadata.protected_rpcs (
    rpc_function NAME PRIMARY KEY,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE metadata.protected_rpcs IS
    'Registry of RPC functions that require explicit role permissions.
     RPCs not in this table are accessible to all authenticated users.';

COMMENT ON COLUMN metadata.protected_rpcs.rpc_function IS
    'PostgreSQL function name (must exist in public schema)';

COMMENT ON COLUMN metadata.protected_rpcs.description IS
    'Human-readable description of what this RPC does';


CREATE TABLE metadata.protected_rpc_roles (
    rpc_function NAME NOT NULL REFERENCES metadata.protected_rpcs(rpc_function) ON DELETE CASCADE,
    role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rpc_function, role_id)
);

COMMENT ON TABLE metadata.protected_rpc_roles IS
    'Junction table mapping protected RPCs to roles that can execute them.
     Admins always have access regardless of this table.';

-- Index for reverse lookup (which RPCs can a role execute)
CREATE INDEX idx_protected_rpc_roles_role ON metadata.protected_rpc_roles(role_id);


-- ============================================================================
-- 2. RPC PERMISSION CHECK FUNCTION
-- ============================================================================
-- Checks if the current user can execute a protected RPC.
-- Admin users always have access (bypass).

CREATE OR REPLACE FUNCTION public.has_rpc_permission(p_rpc_function NAME)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT
        -- Admin bypass: admins can execute any protected RPC
        public.is_admin()
        OR
        -- Check if user has a role that grants permission
        EXISTS (
            SELECT 1
            FROM metadata.protected_rpc_roles prr
            JOIN metadata.roles r ON r.id = prr.role_id
            WHERE prr.rpc_function = p_rpc_function
            AND r.display_name = ANY(public.get_user_roles())
        )
$$;

COMMENT ON FUNCTION public.has_rpc_permission(NAME) IS
    'Check if current user can execute a protected RPC.
     Returns true if: (1) user is admin, or (2) user has a role with permission.
     Unprotected RPCs (not in protected_rpcs table) should not use this check.';


-- ============================================================================
-- 3. ENTITY ACTIONS TABLE
-- ============================================================================
-- Configuration for action buttons on Detail pages.

CREATE TABLE metadata.entity_actions (
    id SERIAL PRIMARY KEY,

    -- Target entity
    table_name NAME NOT NULL,
    action_name VARCHAR(100) NOT NULL,

    -- Display
    display_name TEXT NOT NULL,
    description TEXT,
    icon VARCHAR(50),                    -- Material icon name
    button_style VARCHAR(20) NOT NULL DEFAULT 'primary',  -- DaisyUI style: primary, secondary, accent, success, warning, error
    sort_order INT NOT NULL DEFAULT 0,   -- Lower = appears earlier

    -- RPC configuration
    rpc_function NAME NOT NULL,          -- PostgreSQL function to call

    -- Confirmation modal
    requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
    confirmation_message TEXT,

    -- Conditional visibility/enablement (JSONB conditions)
    -- visibility_condition: null = always visible, otherwise evaluated against record data
    -- enabled_condition: null = always enabled, otherwise true = enabled (clickable)
    visibility_condition JSONB,
    enabled_condition JSONB,
    disabled_tooltip TEXT,               -- Shown when disabled

    -- Response handling
    default_success_message TEXT,        -- Shown on success (RPC can override)
    default_navigate_to TEXT,            -- Navigate to path (RPC can override)
    refresh_after_action BOOLEAN NOT NULL DEFAULT TRUE,

    -- Page visibility
    show_on_detail BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT entity_actions_unique_action UNIQUE(table_name, action_name),
    CONSTRAINT entity_actions_valid_style CHECK (
        button_style IN ('primary', 'secondary', 'accent', 'success', 'warning', 'error', 'ghost')
    ),
    CONSTRAINT entity_actions_confirmation_message CHECK (
        NOT requires_confirmation OR confirmation_message IS NOT NULL
    )
);

COMMENT ON TABLE metadata.entity_actions IS
    'Metadata-driven action buttons displayed on Detail pages.
     Each action calls a PostgreSQL RPC with the entity ID.
     Added in v0.18.0.';

COMMENT ON COLUMN metadata.entity_actions.table_name IS
    'Target entity table name (e.g., ''reservation_requests'')';

COMMENT ON COLUMN metadata.entity_actions.action_name IS
    'Unique identifier for the action within the entity (e.g., ''approve'')';

COMMENT ON COLUMN metadata.entity_actions.rpc_function IS
    'PostgreSQL function to call. Must accept p_entity_id parameter.
     Return JSONB with: success (bool), message (string), navigate_to (string), refresh (bool).';

COMMENT ON COLUMN metadata.entity_actions.visibility_condition IS
    'JSONB condition evaluated against record data to determine visibility.
     Format: {"field": "status_id", "operator": "eq", "value": 1}
     Operators: eq, ne, gt, lt, gte, lte, in, is_null, is_not_null
     null = always visible';

COMMENT ON COLUMN metadata.entity_actions.enabled_condition IS
    'JSONB condition evaluated against record data to determine if button is enabled.
     Format: {"field": "status_id", "operator": "eq", "value": 1}
     true result = button is ENABLED (clickable)
     null = always enabled';

COMMENT ON COLUMN metadata.entity_actions.disabled_tooltip IS
    'Tooltip shown when button is disabled (explains why action is unavailable)';

-- Timestamps trigger
CREATE TRIGGER set_entity_actions_updated_at
    BEFORE UPDATE ON metadata.entity_actions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 4. INDEXES
-- ============================================================================

-- Primary lookup: actions for an entity
CREATE INDEX idx_entity_actions_table ON metadata.entity_actions(table_name);

-- Sorted listing
CREATE INDEX idx_entity_actions_sort ON metadata.entity_actions(table_name, sort_order);


-- ============================================================================
-- 5. ROW LEVEL SECURITY POLICIES
-- ============================================================================
-- Entity actions are configuration - everyone can read, only admins can modify.

ALTER TABLE metadata.protected_rpcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.protected_rpc_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.entity_actions ENABLE ROW LEVEL SECURITY;

-- Protected RPCs: everyone reads, admins modify
CREATE POLICY protected_rpcs_select ON metadata.protected_rpcs
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY protected_rpcs_admin ON metadata.protected_rpcs
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- Protected RPC Roles: everyone reads, admins modify
CREATE POLICY protected_rpc_roles_select ON metadata.protected_rpc_roles
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY protected_rpc_roles_admin ON metadata.protected_rpc_roles
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- Entity Actions: everyone reads, admins modify
CREATE POLICY entity_actions_select ON metadata.entity_actions
    FOR SELECT TO PUBLIC USING (true);

CREATE POLICY entity_actions_admin ON metadata.entity_actions
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());


-- ============================================================================
-- 6. GRANTS
-- ============================================================================

-- Protected RPCs table
GRANT SELECT ON metadata.protected_rpcs TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.protected_rpcs TO authenticated;

-- Protected RPC Roles table
GRANT SELECT ON metadata.protected_rpc_roles TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.protected_rpc_roles TO authenticated;

-- Entity Actions table
GRANT SELECT ON metadata.entity_actions TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.entity_actions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.entity_actions_id_seq TO authenticated;


-- ============================================================================
-- 7. PUBLIC VIEW FOR POSTGREST ACCESS
-- ============================================================================
-- Expose entity actions with permission filtering.
-- Uses security_invoker to run has_rpc_permission() as the calling user.

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
    -- Permission check: true if RPC is unprotected OR user has permission
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM metadata.protected_rpcs
            WHERE rpc_function = ea.rpc_function
        )
        THEN true  -- Unprotected RPC, everyone can execute
        ELSE public.has_rpc_permission(ea.rpc_function)
    END AS can_execute
FROM metadata.entity_actions ea
WHERE ea.show_on_detail = true
ORDER BY ea.table_name, ea.sort_order;

COMMENT ON VIEW public.schema_entity_actions IS
    'Read-only view of entity actions with permission check results.
     can_execute indicates whether the current user can execute the RPC.
     Uses security_invoker to evaluate permissions as the calling user.';

-- Grant read access (view is read-only)
GRANT SELECT ON public.schema_entity_actions TO web_anon, authenticated;


-- ============================================================================
-- 8. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
