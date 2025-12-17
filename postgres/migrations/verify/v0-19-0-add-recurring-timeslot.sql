-- Verify civic_os:v0-19-0-add-recurring-timeslot on pg

BEGIN;

-- ============================================================================
-- VERIFY RECURRING TIMESLOT SYSTEM
-- ============================================================================
-- Version: v0.19.0
-- This script verifies all objects were created successfully.
-- Uses SELECT 1/0 trick: if object doesn't exist, query fails.
-- ============================================================================


-- ============================================================================
-- 1. VERIFY TABLES
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name = 'time_slot_series_groups';

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name = 'time_slot_series';

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name = 'time_slot_instances';


-- ============================================================================
-- 2. VERIFY COLUMNS
-- ============================================================================

-- is_recurring column on properties
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'properties' AND column_name = 'is_recurring';

-- Key columns on series_groups
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'time_slot_series_groups' AND column_name = 'display_name';

-- Key columns on series
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'time_slot_series' AND column_name = 'rrule';

SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'time_slot_series' AND column_name = 'entity_template';

-- Key columns on instances
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'time_slot_instances' AND column_name = 'is_exception';


-- ============================================================================
-- 3. VERIFY VIEWS
-- ============================================================================

SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'metadata' AND table_name = 'series_groups_summary';

SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'schema_series_groups';


-- ============================================================================
-- 4. VERIFY FUNCTIONS
-- ============================================================================

SELECT has_function_privilege('public.preview_recurring_conflicts(NAME, NAME, TEXT, NAME, TIMESTAMPTZ[][])', 'execute');
SELECT has_function_privilege('public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN)', 'execute');
SELECT has_function_privilege('public.expand_series_instances(BIGINT, DATE)', 'execute');
SELECT has_function_privilege('public.cancel_series_occurrence(NAME, BIGINT, TEXT)', 'execute');
SELECT has_function_privilege('public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB)', 'execute');
SELECT has_function_privilege('public.update_series_template(BIGINT, JSONB, BOOLEAN)', 'execute');
SELECT has_function_privilege('public.delete_series_with_instances(BIGINT)', 'execute');
SELECT has_function_privilege('public.delete_series_group(BIGINT)', 'execute');
SELECT has_function_privilege('public.get_series_membership(NAME, BIGINT)', 'execute');

-- Validation functions
SELECT has_function_privilege('metadata.validate_rrule(TEXT)', 'execute');
SELECT has_function_privilege('metadata.validate_entity_template(NAME, JSONB)', 'execute');
SELECT has_function_privilege('metadata.modify_rrule_until(TEXT, DATE)', 'execute');


-- ============================================================================
-- 5. VERIFY RLS POLICIES
-- ============================================================================

SELECT 1/COUNT(*) FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'time_slot_series_groups';

SELECT 1/COUNT(*) FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'time_slot_series';

SELECT 1/COUNT(*) FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'time_slot_instances';


-- ============================================================================
-- 6. VERIFY ENTITY REGISTRATIONS
-- ============================================================================

SELECT 1/COUNT(*) FROM metadata.entities
WHERE table_name = 'time_slot_series_groups';

SELECT 1/COUNT(*) FROM metadata.entities
WHERE table_name = 'time_slot_series';

SELECT 1/COUNT(*) FROM metadata.entities
WHERE table_name = 'time_slot_instances';


ROLLBACK;
