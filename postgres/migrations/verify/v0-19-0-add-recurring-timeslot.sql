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
-- Existence by schema and name only: later migrations changed signatures
-- (e.g. create_recurring_series gained p_expand_horizon_days), so exact
-- argument lists would fail on a fully deployed database.

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'preview_recurring_conflicts' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'create_recurring_series' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'expand_series_instances' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'cancel_series_occurrence' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'split_series_from_date' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'update_series_template' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'delete_series_with_instances' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'delete_series_group' AND pronamespace = 'public'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'get_series_membership' AND pronamespace = 'public'::regnamespace;


-- Validation functions
SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'validate_rrule' AND pronamespace = 'metadata'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'validate_entity_template' AND pronamespace = 'metadata'::regnamespace;

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'modify_rrule_until' AND pronamespace = 'metadata'::regnamespace;



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
