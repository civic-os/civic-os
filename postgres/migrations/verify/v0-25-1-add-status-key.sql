-- Verify civic_os:v0-25-1-add-status-key on pg

BEGIN;

-- ============================================================================
-- Verify status_key Column Exists with Correct Properties
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'statuses'
  AND column_name = 'status_key'
  AND is_nullable = 'NO';


-- ============================================================================
-- Verify Unique Constraint Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_constraint
WHERE conname = 'statuses_entity_type_status_key_unique'
  AND conrelid = 'metadata.statuses'::regclass;


-- ============================================================================
-- Verify All Existing Statuses Have status_key Populated
-- ============================================================================

DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM metadata.statuses
  WHERE status_key IS NULL OR TRIM(status_key) = '';

  ASSERT null_count = 0,
    format('Found %s statuses with NULL or empty status_key', null_count);
END $$;


-- ============================================================================
-- Verify Trigger Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'trg_statuses_set_key'
  AND tgrelid = 'metadata.statuses'::regclass;


-- ============================================================================
-- Verify Trigger Function Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata'
  AND p.proname = 'set_status_key';


-- ============================================================================
-- Verify Helper Function Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'get_status_id';


-- ============================================================================
-- Verify public.statuses View Includes status_key
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'statuses'
  AND column_name = 'status_key';


-- ============================================================================
-- Test get_status_id() Function Works
-- ============================================================================

DO $$
DECLARE
  result INT;
BEGIN
  -- Should return NULL for nonexistent status (not error)
  SELECT get_status_id('nonexistent_type', 'nonexistent_key') INTO result;
  ASSERT result IS NULL, 'get_status_id should return NULL for nonexistent status';
END $$;


-- ============================================================================
-- Test Trigger Auto-Generates status_key
-- ============================================================================

DO $$
DECLARE
  v_generated_key TEXT;
  v_test_id INT;
BEGIN
  -- First ensure we have a test status type
  INSERT INTO metadata.status_types (entity_type, description)
  VALUES ('__test_verify_status_key', 'Temporary test type for verification')
  ON CONFLICT (entity_type) DO NOTHING;

  -- Insert without status_key - trigger should auto-generate
  INSERT INTO metadata.statuses (entity_type, display_name, sort_order)
  VALUES ('__test_verify_status_key', 'Test In Progress', 1)
  RETURNING id, status_key INTO v_test_id, v_generated_key;

  ASSERT v_generated_key = 'test_in_progress',
    format('Expected status_key "test_in_progress", got "%s"', v_generated_key);

  -- Cleanup
  DELETE FROM metadata.statuses WHERE id = v_test_id;
  DELETE FROM metadata.status_types WHERE entity_type = '__test_verify_status_key';
END $$;


ROLLBACK;
