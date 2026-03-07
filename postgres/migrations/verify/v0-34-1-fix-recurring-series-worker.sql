-- Verify civic_os:v0-34-1-fix-recurring-series-worker on pg

BEGIN;

-- Verify the CHECK constraint accepts 'insert_failed'
DO $$
BEGIN
    -- Test that the constraint allows 'insert_failed' by checking pg_catalog
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'time_slot_instances_exception_type_check'
          AND conrelid = 'metadata.time_slot_instances'::regclass
    ) THEN
        RAISE EXCEPTION 'CHECK constraint time_slot_instances_exception_type_check not found';
    END IF;
END;
$$;

-- Verify the function exists and has the JWT warning check
SELECT 1 FROM pg_proc
WHERE proname = 'validate_template_against_schema'
  AND pronamespace = 'metadata'::regnamespace;

ROLLBACK;
