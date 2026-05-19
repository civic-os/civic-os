-- Verify civic_os:v0-54-0-action-param-options-rpc on pg

BEGIN;

-- Verify columns exist
SELECT options_source_rpc, depends_on_params
FROM metadata.entity_action_params
WHERE FALSE;

-- Verify VIEW includes new fields in parameters JSON
SELECT parameters
FROM public.schema_entity_actions
WHERE FALSE;

-- Verify constraints exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_action_params_depends_requires_rpc'
    ) THEN
        RAISE EXCEPTION 'Missing constraint: entity_action_params_depends_requires_rpc';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_action_params_rpc_only_fk'
    ) THEN
        RAISE EXCEPTION 'Missing constraint: entity_action_params_rpc_only_fk';
    END IF;
END $$;

ROLLBACK;
