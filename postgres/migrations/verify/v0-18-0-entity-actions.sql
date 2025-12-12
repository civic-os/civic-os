-- Verify civic_os:v0-18-0-entity-actions on pg

BEGIN;

-- ============================================================================
-- Verify Protected RPCs Table Exists
-- ============================================================================

SELECT rpc_function, description, created_at
FROM metadata.protected_rpcs
WHERE FALSE;


-- ============================================================================
-- Verify Protected RPC Roles Table Exists
-- ============================================================================

SELECT rpc_function, role_id, created_at
FROM metadata.protected_rpc_roles
WHERE FALSE;


-- ============================================================================
-- Verify Entity Actions Table Exists with Correct Structure
-- ============================================================================

SELECT id, table_name, action_name, display_name, description,
       icon, button_style, sort_order, rpc_function,
       requires_confirmation, confirmation_message,
       visibility_condition, enabled_condition, disabled_tooltip,
       default_success_message, default_navigate_to, refresh_after_action,
       show_on_detail, created_at, updated_at
FROM metadata.entity_actions
WHERE FALSE;


-- ============================================================================
-- Verify Function Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'has_rpc_permission'
  AND pronamespace = 'public'::regnamespace;


-- ============================================================================
-- Verify Indexes Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND indexname = 'idx_entity_actions_table';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND indexname = 'idx_entity_actions_sort';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'protected_rpc_roles' AND indexname = 'idx_protected_rpc_roles_role';


-- ============================================================================
-- Verify Row Level Security is Enabled
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'protected_rpcs' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'protected_rpc_roles' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND rowsecurity = true;


-- ============================================================================
-- Verify RLS Policies Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'protected_rpcs' AND policyname = 'protected_rpcs_select';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'protected_rpc_roles' AND policyname = 'protected_rpc_roles_select';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND policyname = 'entity_actions_select';


-- ============================================================================
-- Verify Public View Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'schema_entity_actions';


-- ============================================================================
-- Verify View Has Correct Columns
-- ============================================================================

SELECT id, table_name, action_name, display_name, description,
       icon, button_style, sort_order, rpc_function,
       requires_confirmation, confirmation_message,
       visibility_condition, enabled_condition, disabled_tooltip,
       default_success_message, default_navigate_to, refresh_after_action,
       show_on_detail, can_execute
FROM public.schema_entity_actions
WHERE FALSE;


-- ============================================================================
-- Verify Constraints Exist
-- ============================================================================

DO $$
BEGIN
    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_actions_unique_action'
          AND conrelid = 'metadata.entity_actions'::regclass
    ), 'entity_actions_unique_action constraint missing';

    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_actions_valid_style'
          AND conrelid = 'metadata.entity_actions'::regclass
    ), 'entity_actions_valid_style constraint missing';

    ASSERT EXISTS(
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_actions_confirmation_message'
          AND conrelid = 'metadata.entity_actions'::regclass
    ), 'entity_actions_confirmation_message constraint missing';
END $$;


ROLLBACK;
