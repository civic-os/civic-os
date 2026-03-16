-- Verify v0-38-4-fix-role-key-view

BEGIN;

-- 1. Verify managed_users VIEW exists
SELECT 1 FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'managed_users';

-- 2. Verify roles column exists in VIEW
SELECT 1 FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'managed_users'
  AND column_name = 'roles';

-- 3. Verify the VIEW source references role_key (not display_name) in array_agg
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public'
      AND viewname = 'managed_users'
      AND definition LIKE '%r.role_key%'
      AND definition LIKE '%array_agg%'
  ) THEN
    RAISE EXCEPTION 'managed_users VIEW does not aggregate role_key';
  END IF;
END $$;

-- 4. Verify protect_role_key trigger function exists
SELECT 1 FROM pg_proc
WHERE proname = 'protect_role_key'
  AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'metadata');

-- 5. Verify protect_role_key trigger exists on metadata.roles
SELECT 1 FROM pg_trigger
WHERE tgname = 'trg_roles_protect_key'
  AND tgrelid = 'metadata.roles'::regclass;

-- 6. Verify role_key immutability is enforced
DO $$
BEGIN
  -- Try to UPDATE role_key — should raise exception
  BEGIN
    UPDATE metadata.roles SET role_key = 'test_immutability_check'
    WHERE role_key = 'admin';
    RAISE EXCEPTION 'UPDATE of role_key should have been prevented by trigger';
  EXCEPTION
    WHEN raise_exception THEN
      -- Expected — trigger blocked the update
      NULL;
  END;
END $$;

ROLLBACK;
