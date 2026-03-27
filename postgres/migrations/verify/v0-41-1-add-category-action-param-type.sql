-- Verify civic_os:v0-41-1-add-category-action-param-type on pg

BEGIN;

-- Verify category_entity_type column exists
SELECT category_entity_type
FROM metadata.entity_action_params
WHERE FALSE;

-- Verify VIEW includes category_entity_type in parameters JSON
SELECT parameters
FROM public.schema_entity_actions
WHERE FALSE;

-- Verify category is in the valid type constraint
-- (will fail if constraint doesn't allow 'category')
DO $$
BEGIN
    -- Test that the constraint name exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_action_params_category_requires_entity_type'
    ) THEN
        RAISE EXCEPTION 'Missing constraint: entity_action_params_category_requires_entity_type';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_action_params_category_entity_type_only'
    ) THEN
        RAISE EXCEPTION 'Missing constraint: entity_action_params_category_entity_type_only';
    END IF;
END $$;

ROLLBACK;
