-- Verify civic_os:v0-36-0-keycloak-sync-triggers on pg

BEGIN;

-- ============================================================================
-- 1. Verify trigger functions exist in metadata schema
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata'
  AND p.proname = 'trg_roles_sync_keycloak';

SELECT 1/(COUNT(*))::int FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'metadata'
  AND p.proname = 'trg_user_roles_sync_keycloak';


-- ============================================================================
-- 2. Verify trigger functions are NOT in public schema
-- ============================================================================

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN ('trg_roles_sync_keycloak', 'trg_user_roles_sync_keycloak');

  ASSERT v_count = 0,
    'Trigger functions should NOT be in public schema (would be exposed via PostgREST)';
END $$;


-- ============================================================================
-- 3. Verify triggers exist on their respective tables
-- ============================================================================

SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'trg_roles_sync_keycloak'
  AND tgrelid = 'metadata.roles'::regclass;

SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'trg_user_roles_sync_keycloak'
  AND tgrelid = 'metadata.user_roles'::regclass;


-- ============================================================================
-- 4. Verify trigger functions are SECURITY DEFINER
-- ============================================================================

DO $$
DECLARE
  v_security TEXT;
BEGIN
  SELECT CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END INTO v_security
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'metadata' AND p.proname = 'trg_roles_sync_keycloak';

  ASSERT v_security = 'DEFINER',
    format('trg_roles_sync_keycloak should be SECURITY DEFINER, got %s', v_security);

  SELECT CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END INTO v_security
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'metadata' AND p.proname = 'trg_user_roles_sync_keycloak';

  ASSERT v_security = 'DEFINER',
    format('trg_user_roles_sync_keycloak should be SECURITY DEFINER, got %s', v_security);
END $$;


-- ============================================================================
-- 5. Verify refresh_current_user no longer does bulk DELETE
-- ============================================================================
-- The diff-based version should use "role_id NOT IN" for targeted deletes
-- instead of "DELETE FROM metadata.user_roles WHERE user_id ="

DO $$
DECLARE
  v_source TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'refresh_current_user';

  -- Should contain "v_filtered_roles" (diff-based approach)
  ASSERT v_source LIKE '%v_filtered_roles%',
    'refresh_current_user should use v_filtered_roles for diff-based sync';

  -- Should contain "role_id NOT IN" (targeted delete)
  ASSERT v_source LIKE '%role_id NOT IN%',
    'refresh_current_user should use targeted DELETE with NOT IN';
END $$;


-- ============================================================================
-- 6. Verify RPCs no longer contain manual River job INSERTs
-- ============================================================================

DO $$
DECLARE
  v_source TEXT;
BEGIN
  -- Check assign_user_role doesn't have river_job INSERT
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'assign_user_role';

  ASSERT v_source NOT LIKE '%river_job%',
    'assign_user_role should not contain river_job INSERT (trigger handles it)';

  -- Check revoke_user_role
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'revoke_user_role';

  ASSERT v_source NOT LIKE '%river_job%',
    'revoke_user_role should not contain river_job INSERT (trigger handles it)';

  -- Check delete_role
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'delete_role';

  ASSERT v_source NOT LIKE '%river_job%',
    'delete_role should not contain river_job INSERT (trigger handles it)';

  -- Check create_role
  SELECT pg_get_functiondef(p.oid) INTO v_source
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'create_role';

  ASSERT v_source NOT LIKE '%river_job%',
    'create_role should not contain river_job INSERT (trigger handles it)';
END $$;


ROLLBACK;
