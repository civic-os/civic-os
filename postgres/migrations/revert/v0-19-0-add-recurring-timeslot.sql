-- Revert civic_os:v0-19-0-add-recurring-timeslot from pg

BEGIN;

-- ============================================================================
-- REVERT RECURRING TIMESLOT SYSTEM
-- ============================================================================
-- Version: v0.19.0
-- This script reverts all changes made by the deploy script.
-- Order matters: drop dependent objects first.
-- ============================================================================


-- ============================================================================
-- 1. DROP PUBLIC VIEW
-- ============================================================================

DROP VIEW IF EXISTS public.schema_series_groups;


-- ============================================================================
-- 2. DROP SUMMARY VIEW
-- ============================================================================

DROP VIEW IF EXISTS metadata.series_groups_summary;


-- ============================================================================
-- 3. DROP RPC FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_series_membership(NAME, BIGINT);
DROP FUNCTION IF EXISTS public.delete_series_group(BIGINT);
DROP FUNCTION IF EXISTS public.delete_series_with_instances(BIGINT);
DROP FUNCTION IF EXISTS public.update_series_template(BIGINT, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.split_series_from_date(BIGINT, DATE, TIMESTAMPTZ, INTERVAL, JSONB);
DROP FUNCTION IF EXISTS public.cancel_series_occurrence(NAME, BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.expand_series_instances(BIGINT, DATE);
DROP FUNCTION IF EXISTS public.create_recurring_series(TEXT, TEXT, TEXT, NAME, JSONB, TEXT, TIMESTAMPTZ, INTERVAL, TEXT, NAME, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.preview_recurring_conflicts(NAME, NAME, TEXT, NAME, TIMESTAMPTZ[][]);


-- ============================================================================
-- 4. DROP HELPER FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS metadata.prevent_direct_series_delete();
DROP FUNCTION IF EXISTS metadata.modify_rrule_until(TEXT, DATE);
DROP FUNCTION IF EXISTS metadata.validate_template_against_schema(NAME, JSONB);
DROP FUNCTION IF EXISTS metadata.validate_entity_template(NAME, JSONB);
DROP FUNCTION IF EXISTS metadata.validate_rrule(TEXT);


-- ============================================================================
-- 5. DROP TABLES (CASCADE handles triggers, indexes, policies)
-- ============================================================================

DROP TABLE IF EXISTS metadata.time_slot_instances CASCADE;
DROP TABLE IF EXISTS metadata.time_slot_series CASCADE;
DROP TABLE IF EXISTS metadata.time_slot_series_groups CASCADE;


-- ============================================================================
-- 6. REMOVE METADATA COLUMN
-- ============================================================================

ALTER TABLE metadata.properties
    DROP COLUMN IF EXISTS is_recurring;


-- ============================================================================
-- 7. REMOVE ENTITY REGISTRATIONS
-- ============================================================================

DELETE FROM metadata.permission_roles
WHERE table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances');

DELETE FROM metadata.entities
WHERE table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances');


-- ============================================================================
-- 8. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
