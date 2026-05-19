-- Verify civic_os:v0-55-0-photo-gallery-action-param on pg

BEGIN;

-- Verify column exists
SELECT target_column
FROM metadata.entity_action_params
WHERE FALSE;

-- Verify VIEW includes target_column in parameters JSON
SELECT parameters
FROM public.schema_entity_actions
WHERE FALSE;

-- Verify constraints exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_action_params_gallery_requires_target'
    ) THEN
        RAISE EXCEPTION 'Missing constraint: entity_action_params_gallery_requires_target';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'entity_action_params_target_only_gallery'
    ) THEN
        RAISE EXCEPTION 'Missing constraint: entity_action_params_target_only_gallery';
    END IF;
END $$;

-- Verify CHECK constraint includes photo_gallery
DO $$
DECLARE
    v_def TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
    WHERE conrelid = 'metadata.entity_action_params'::regclass
      AND conname = 'entity_action_params_valid_type';

    IF v_def NOT LIKE '%photo_gallery%' THEN
        RAISE EXCEPTION 'CHECK constraint entity_action_params_valid_type does not include photo_gallery';
    END IF;
END $$;

ROLLBACK;
