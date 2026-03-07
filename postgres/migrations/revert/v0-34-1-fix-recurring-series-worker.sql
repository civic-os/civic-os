-- Revert civic_os:v0-34-1-fix-recurring-series-worker from pg

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Restore original exception_type CHECK (without 'insert_failed')
-- ----------------------------------------------------------------------------

ALTER TABLE metadata.time_slot_instances
    DROP CONSTRAINT IF EXISTS time_slot_instances_exception_type_check;

ALTER TABLE metadata.time_slot_instances
    ADD CONSTRAINT time_slot_instances_exception_type_check
    CHECK (exception_type IS NULL OR exception_type IN (
        'modified',
        'rescheduled',
        'cancelled',
        'conflict_skipped'
    ));


-- ----------------------------------------------------------------------------
-- 2. Restore original validate_template_against_schema() (v0.19.0)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION metadata.validate_template_against_schema(
    p_entity_table NAME,
    p_template JSONB
)
RETURNS TABLE(field TEXT, issue TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    -- Check for missing required fields (join with information_schema for nullability info)
    RETURN QUERY
    SELECT c.column_name::TEXT, 'Required field missing from template'::TEXT
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = p_entity_table
      AND c.is_nullable = 'NO'
      AND c.column_default IS NULL
      AND c.column_name NOT IN ('id', 'created_at', 'created_by', 'updated_at', 'updated_by')
      AND c.column_name NOT IN ('time_slot')  -- Handled by expansion
      AND NOT p_template ? c.column_name;

    -- Check for fields that no longer exist
    RETURN QUERY
    SELECT t.key::TEXT, 'Field no longer exists in entity schema'::TEXT
    FROM jsonb_object_keys(p_template) t(key)
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = p_entity_table AND c.column_name = t.key
    );
END;
$$;

COMMENT ON FUNCTION metadata.validate_template_against_schema(NAME, JSONB) IS
    'Checks for schema drift between series template and current entity schema.
     Returns table of issues (empty if valid).
     Added in v0.19.0.';


COMMIT;
