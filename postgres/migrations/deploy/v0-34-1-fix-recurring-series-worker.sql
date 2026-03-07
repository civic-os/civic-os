-- Deploy civic_os:v0-34-1-fix-recurring-series-worker to pg
-- requires: v0-34-0-add-category-system

BEGIN;

-- ============================================================================
-- FIX RECURRING SERIES WORKER: Accurate Error Classification
-- ============================================================================
-- Version: v0.34.1
-- Purpose: Fix three stacked bugs causing all recurring series instances to
--          be silently skipped as "conflict_skipped" when the real errors
--          were missing columns and NULL JWT context.
--
-- Changes:
--   1. Add 'insert_failed' to time_slot_instances.exception_type CHECK
--   2. Update validate_template_against_schema() to warn about NOT NULL
--      columns with current_user_id() defaults
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Expand exception_type CHECK constraint to include 'insert_failed'
-- ----------------------------------------------------------------------------
-- The worker now classifies INSERT errors properly: only GIST exclusion
-- violations (23P01) are "conflict_skipped"; everything else is "insert_failed".

ALTER TABLE metadata.time_slot_instances
    DROP CONSTRAINT IF EXISTS time_slot_instances_exception_type_check;

ALTER TABLE metadata.time_slot_instances
    ADD CONSTRAINT time_slot_instances_exception_type_check
    CHECK (exception_type IS NULL OR exception_type IN (
        'modified',
        'rescheduled',
        'cancelled',
        'conflict_skipped',
        'insert_failed'
    ));


-- ----------------------------------------------------------------------------
-- 2. Update validate_template_against_schema() with JWT default warning
-- ----------------------------------------------------------------------------
-- Adds a third check: warn about NOT NULL columns that have
-- current_user_id() defaults but aren't in the template. These columns
-- will work fine when the worker sets the JWT GUC, but the warning
-- lets operators know the column depends on runtime JWT context.

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
    -- Check 1: Required fields missing from template (NOT NULL, no default)
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

    -- Check 2: Fields that no longer exist in entity schema
    RETURN QUERY
    SELECT t.key::TEXT, 'Field no longer exists in entity schema'::TEXT
    FROM jsonb_object_keys(p_template) t(key)
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = p_entity_table AND c.column_name = t.key
    );

    -- Check 3: NOT NULL columns with current_user_id() defaults not in template
    -- These depend on JWT context at runtime. The worker sets the JWT GUC,
    -- so this is a warning (not a hard error) to aid debugging.
    RETURN QUERY
    SELECT c.column_name::TEXT,
           ('NOT NULL column with current_user_id() default — requires JWT context at runtime')::TEXT
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = p_entity_table
      AND c.is_nullable = 'NO'
      AND c.column_default LIKE '%current_user_id()%'
      AND c.column_name NOT IN ('created_by', 'updated_by')  -- Standard exclusions
      AND NOT p_template ? c.column_name;
END;
$$;

COMMENT ON FUNCTION metadata.validate_template_against_schema(NAME, JSONB) IS
    'Checks for schema drift between series template and current entity schema.
     Returns table of issues (empty if valid).
     v0.34.1: Added JWT-dependent column warning for NOT NULL + current_user_id() defaults.';


COMMIT;
