-- Verify civic_os:v0-36-0-add-role-key on pg

BEGIN;

-- ============================================================================
-- 1. Verify role_key Column Exists with Correct Properties
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'roles'
  AND column_name = 'role_key'
  AND is_nullable = 'NO';


-- ============================================================================
-- 2. Verify Unique Constraint Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_constraint
WHERE conname = 'roles_role_key_unique'
  AND conrelid = 'metadata.roles'::regclass;


-- ============================================================================
-- 3. Verify All Existing Roles Have role_key Populated
-- ============================================================================

DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM metadata.roles
  WHERE role_key IS NULL OR TRIM(role_key) = '';

  ASSERT null_count = 0,
    format('Found %s roles with NULL or empty role_key', null_count);
END $$;


-- ============================================================================
-- 4. Verify Trigger Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'trg_roles_set_key'
  AND tgrelid = 'metadata.roles'::regclass;


-- ============================================================================
-- 5. Verify Trigger Function Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata'
  AND p.proname = 'set_role_key';


-- ============================================================================
-- 6. Verify Helper Function Exists
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'get_role_id';


-- ============================================================================
-- 7. Test get_role_id() Returns Non-NULL for Known Role
-- ============================================================================

DO $$
DECLARE
  result SMALLINT;
BEGIN
  SELECT get_role_id('admin') INTO result;
  ASSERT result IS NOT NULL, 'get_role_id(''admin'') should return non-NULL';
END $$;


-- ============================================================================
-- 8. Test get_role_id() Returns NULL for Nonexistent Role
-- ============================================================================

DO $$
DECLARE
  result SMALLINT;
BEGIN
  SELECT get_role_id('nonexistent_role_xyz') INTO result;
  ASSERT result IS NULL, 'get_role_id should return NULL for nonexistent role';
END $$;


-- ============================================================================
-- 9. Test Trigger Auto-Generates role_key from display_name
-- ============================================================================

DO $$
DECLARE
  v_generated_key TEXT;
  v_test_id SMALLINT;
BEGIN
  -- Insert without role_key - trigger should auto-generate
  INSERT INTO metadata.roles (display_name)
  VALUES ('Test Content Editor')
  RETURNING id, role_key INTO v_test_id, v_generated_key;

  ASSERT v_generated_key = 'test_content_editor',
    format('Expected role_key "test_content_editor", got "%s"', v_generated_key);

  -- Cleanup
  DELETE FROM metadata.roles WHERE id = v_test_id;
END $$;


-- ============================================================================
-- 10. Test get_roles() Returns role_key Column
-- ============================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify get_roles includes role_key by checking the function signature
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname = 'get_roles'
    AND pg_get_function_result(p.oid) LIKE '%role_key%';

  ASSERT v_count > 0, 'get_roles() should include role_key in return type';
END $$;


-- ============================================================================
-- 11. Test get_manageable_roles() Returns role_key Column
-- ============================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname = 'get_manageable_roles'
    AND pg_get_function_result(p.oid) LIKE '%role_key%';

  ASSERT v_count > 0, 'get_manageable_roles() should include role_key in return type';
END $$;


-- ============================================================================
-- 12. Test get_role_can_manage() Returns managed_role_key Column
-- ============================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname = 'get_role_can_manage'
    AND pg_get_function_result(p.oid) LIKE '%managed_role_key%';

  ASSERT v_count > 0, 'get_role_can_manage() should include managed_role_key in return type';
END $$;


-- ============================================================================
-- 13. Verify has_permission uses role_key (check function body)
-- ============================================================================

DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'metadata' AND p.proname = 'has_permission';

  ASSERT v_source LIKE '%role_key%',
    'metadata.has_permission() should reference role_key';
END $$;


-- ============================================================================
-- 14. Verify has_role uses role_key (check function body)
-- ============================================================================

DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'metadata' AND p.proname = 'has_role';

  ASSERT v_source LIKE '%role_key%',
    'metadata.has_role() should reference role_key';
END $$;


ROLLBACK;
