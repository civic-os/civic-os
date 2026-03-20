-- Revert civic_os:v0-40-0-status-category-admin-rpcs from pg

BEGIN;

-- ============================================================================
-- 1. REMOVE SCHEMA DECISION
-- ============================================================================

DELETE FROM metadata.schema_decisions
WHERE migration_id = 'v0-40-0-status-category-admin-rpcs';


-- ============================================================================
-- 2. DROP CATEGORY CRUD RPCs
-- ============================================================================

DROP FUNCTION IF EXISTS public.delete_category(INT);
DROP FUNCTION IF EXISTS public.upsert_category(TEXT, VARCHAR, TEXT, TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.delete_category_group(TEXT);
DROP FUNCTION IF EXISTS public.upsert_category_group(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_category_entity_types();


-- ============================================================================
-- 3. DROP STATUS TRANSITION RPCs
-- ============================================================================

DROP FUNCTION IF EXISTS public.delete_status_transition(INT);
DROP FUNCTION IF EXISTS public.upsert_status_transition(TEXT, INT, INT, NAME, VARCHAR, TEXT, INT, BOOLEAN, INT);
DROP FUNCTION IF EXISTS public.get_status_transitions_for_entity(TEXT);


-- ============================================================================
-- 4. DROP STATUS CRUD RPCs
-- ============================================================================

DROP FUNCTION IF EXISTS public.delete_status(INT);
DROP FUNCTION IF EXISTS public.upsert_status(TEXT, VARCHAR, TEXT, TEXT, INT, BOOLEAN, BOOLEAN, INT);
DROP FUNCTION IF EXISTS public.delete_status_type(TEXT);
DROP FUNCTION IF EXISTS public.upsert_status_type(TEXT, TEXT, TEXT);


-- ============================================================================
-- 5. DROP BULK PERMISSION LOADING RPC
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_current_user_permissions();


-- ============================================================================
-- 6. RESTORE ORIGINAL RLS POLICIES (is_admin())
-- ============================================================================

-- --- metadata.categories ---
DROP POLICY IF EXISTS categories_insert ON metadata.categories;
DROP POLICY IF EXISTS categories_update ON metadata.categories;
DROP POLICY IF EXISTS categories_delete ON metadata.categories;

CREATE POLICY categories_insert ON metadata.categories
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY categories_update ON metadata.categories
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY categories_delete ON metadata.categories
  FOR DELETE TO authenticated USING (public.is_admin());

-- --- metadata.category_groups ---
DROP POLICY IF EXISTS category_groups_insert ON metadata.category_groups;
DROP POLICY IF EXISTS category_groups_update ON metadata.category_groups;
DROP POLICY IF EXISTS category_groups_delete ON metadata.category_groups;

CREATE POLICY category_groups_insert ON metadata.category_groups
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY category_groups_update ON metadata.category_groups
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY category_groups_delete ON metadata.category_groups
  FOR DELETE TO authenticated USING (public.is_admin());

-- --- metadata.status_transitions ---
DROP POLICY IF EXISTS status_transitions_insert ON metadata.status_transitions;
DROP POLICY IF EXISTS status_transitions_update ON metadata.status_transitions;
DROP POLICY IF EXISTS status_transitions_delete ON metadata.status_transitions;

CREATE POLICY status_transitions_insert ON metadata.status_transitions
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY status_transitions_update ON metadata.status_transitions
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY status_transitions_delete ON metadata.status_transitions
  FOR DELETE TO authenticated USING (public.is_admin());

-- --- metadata.statuses ---
DROP POLICY IF EXISTS statuses_insert ON metadata.statuses;
DROP POLICY IF EXISTS statuses_update ON metadata.statuses;
DROP POLICY IF EXISTS statuses_delete ON metadata.statuses;

CREATE POLICY statuses_insert ON metadata.statuses
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY statuses_update ON metadata.statuses
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY statuses_delete ON metadata.statuses
  FOR DELETE TO authenticated USING (public.is_admin());

-- --- metadata.status_types ---
DROP POLICY IF EXISTS status_types_insert ON metadata.status_types;
DROP POLICY IF EXISTS status_types_update ON metadata.status_types;
DROP POLICY IF EXISTS status_types_delete ON metadata.status_types;

CREATE POLICY status_types_insert ON metadata.status_types
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY status_types_update ON metadata.status_types
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY status_types_delete ON metadata.status_types
  FOR DELETE TO authenticated USING (public.is_admin());


-- ============================================================================
-- 7. REMOVE PERMISSION ROWS AND ROLE ASSIGNMENTS
-- ============================================================================

-- Remove role assignments first (FK to permissions)
DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT id FROM metadata.permissions
  WHERE table_name IN (
    'metadata.statuses', 'metadata.categories', 'metadata.status_transitions',
    'metadata.status_types', 'metadata.category_groups'
  )
);

-- Remove permission rows
DELETE FROM metadata.permissions
WHERE table_name IN (
  'metadata.statuses', 'metadata.categories', 'metadata.status_transitions',
  'metadata.status_types', 'metadata.category_groups'
);


-- ============================================================================
-- 8. DROP display_name COLUMNS ADDED TO EXISTING TABLES
-- ============================================================================

ALTER TABLE metadata.status_types DROP COLUMN IF EXISTS display_name;
ALTER TABLE metadata.category_groups DROP COLUMN IF EXISTS display_name;


-- ============================================================================
-- 9. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
