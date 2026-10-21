-- Verify civic_os:v0-18-0-entity-actions on pg

BEGIN;

-- ============================================================================
-- Verify Action Permission Tables Exist
-- ============================================================================
-- This change created metadata.protected_rpcs and metadata.protected_rpc_roles.
-- v0-18-1-refactor-entity-action-permissions dropped them in favor of
-- metadata.entity_action_roles, so accept either generation. Checks run both
-- right after this change deploys and again on a fully deployed database.

DO $$
BEGIN
  ASSERT (to_regclass('metadata.protected_rpcs') IS NOT NULL
          AND to_regclass('metadata.protected_rpc_roles') IS NOT NULL)
      OR to_regclass('metadata.entity_action_roles') IS NOT NULL,
    'neither metadata.protected_rpc_roles nor metadata.entity_action_roles exists';
END $$;


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

-- has_rpc_permission() was replaced by has_entity_action_permission() in v0-18-1
SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname IN ('has_rpc_permission', 'has_entity_action_permission')
  AND pronamespace = 'public'::regnamespace;


-- ============================================================================
-- Verify Indexes Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND indexname = 'idx_entity_actions_table';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND indexname = 'idx_entity_actions_sort';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata'
  AND indexname IN ('idx_protected_rpc_roles_role', 'idx_entity_action_roles_role');


-- ============================================================================
-- Verify Row Level Security is Enabled
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata'
  AND tablename IN ('protected_rpc_roles', 'entity_action_roles')
  AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'entity_actions' AND rowsecurity = true;


-- ============================================================================
-- Verify RLS Policies Exist
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata'
  AND policyname IN ('protected_rpc_roles_select', 'entity_action_roles_select');

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
