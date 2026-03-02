-- Verify civic_os:v0-32-0-entity-action-params on pg

BEGIN;

-- Verify table exists with expected columns
SELECT id, entity_action_id, param_name, display_name, param_type,
       required, sort_order, placeholder, default_value,
       join_table, join_column, status_entity_type, file_type,
       created_at, updated_at
FROM metadata.entity_action_params
WHERE FALSE;

-- Verify view includes parameters column
SELECT parameters
FROM public.schema_entity_actions
WHERE FALSE;

-- Verify RLS is enabled
SELECT 1
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'metadata'
  AND c.relname = 'entity_action_params'
  AND c.relrowsecurity = true;

ROLLBACK;
