-- Verify civic_os:v0-28-1-filter-system-views on pg

BEGIN;

-- ============================================================================
-- Verify system views are filtered from schema_entities
-- ============================================================================

-- Create test view to verify filtering works
CREATE OR REPLACE VIEW public._test_schema_view AS
SELECT 1 AS id, 'test' AS name;

-- Test view should NOT appear (starts with schema_ pattern would match,
-- but this one starts with _test_ so it tests the general filter logic)

-- Verify time_slot_series is excluded (if it exists)
SELECT 1/(CASE
  WHEN NOT EXISTS (SELECT 1 FROM schema_entities WHERE table_name = 'time_slot_series')
  THEN 1 ELSE 0 END);

-- Verify time_slot_instances is excluded (if it exists)
SELECT 1/(CASE
  WHEN NOT EXISTS (SELECT 1 FROM schema_entities WHERE table_name = 'time_slot_instances')
  THEN 1 ELSE 0 END);

-- Verify schema_series_groups is excluded (if it exists)
SELECT 1/(CASE
  WHEN NOT EXISTS (SELECT 1 FROM schema_entities WHERE table_name = 'schema_series_groups')
  THEN 1 ELSE 0 END);

-- Clean up test view
DROP VIEW public._test_schema_view;

ROLLBACK;
