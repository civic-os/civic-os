-- Deploy civic_os:v0-40-0-status-category-admin-rpcs to pg
-- requires: v0-39-0-add-file-admin

BEGIN;

-- ============================================================================
-- STATUS & CATEGORY ADMIN RPCs
-- ============================================================================
-- Version: v0.40.0
-- Purpose: Add CRUD RPCs for managing statuses, categories, and status transitions
--          from the browser UI. Also adds permission infrastructure for metadata
--          tables and a bulk permission loading RPC for frontend caching.
--
-- RPCs (all return JSONB {success, error?, id?}):
--   Status management:    upsert_status_type, delete_status_type,
--                         upsert_status, delete_status
--   Transition management: upsert_status_transition, delete_status_transition,
--                          get_status_transitions_for_entity
--   Category management:  upsert_category_group, delete_category_group,
--                         upsert_category, delete_category,
--                         get_category_entity_types
--   Permission loading:   get_current_user_permissions
--
-- Security: All mutation RPCs use SECURITY INVOKER — RLS on the metadata tables
--           controls access. The RLS policies are upgraded from is_admin() to
--           has_permission() for finer-grained control.
-- ============================================================================


-- ============================================================================
-- 0. ADD display_name COLUMN TO TYPE/GROUP TABLES
-- ============================================================================
-- Human-readable labels for the entity type selector dropdowns in admin pages.
-- Falls back to entity_type when NULL (for backwards compatibility).

ALTER TABLE metadata.status_types
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE metadata.category_groups
  ADD COLUMN IF NOT EXISTS display_name TEXT;


-- ============================================================================
-- 1. PERMISSION INFRASTRUCTURE FOR METADATA TABLES
-- ============================================================================
-- Seed CRUD permission rows for metadata tables so the Permissions UI can
-- control who can manage statuses, categories, and transitions.

INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('metadata.statuses', 'create'),
  ('metadata.statuses', 'read'),
  ('metadata.statuses', 'update'),
  ('metadata.statuses', 'delete'),
  ('metadata.categories', 'create'),
  ('metadata.categories', 'read'),
  ('metadata.categories', 'update'),
  ('metadata.categories', 'delete'),
  ('metadata.status_transitions', 'create'),
  ('metadata.status_transitions', 'read'),
  ('metadata.status_transitions', 'update'),
  ('metadata.status_transitions', 'delete'),
  ('metadata.status_types', 'create'),
  ('metadata.status_types', 'read'),
  ('metadata.status_types', 'update'),
  ('metadata.status_types', 'delete'),
  ('metadata.category_groups', 'create'),
  ('metadata.category_groups', 'read'),
  ('metadata.category_groups', 'update'),
  ('metadata.category_groups', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant all metadata CRUD permissions to admin role
DO $$
DECLARE
  v_admin_role_id SMALLINT;
  v_perm RECORD;
BEGIN
  SELECT id INTO v_admin_role_id FROM metadata.roles WHERE role_key = 'admin';
  IF v_admin_role_id IS NOT NULL THEN
    FOR v_perm IN
      SELECT id FROM metadata.permissions
      WHERE table_name IN (
        'metadata.statuses', 'metadata.categories', 'metadata.status_transitions',
        'metadata.status_types', 'metadata.category_groups'
      )
    LOOP
      INSERT INTO metadata.permission_roles (role_id, permission_id)
      VALUES (v_admin_role_id, v_perm.id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;


-- ============================================================================
-- 2. UPGRADE RLS POLICIES TO has_permission()
-- ============================================================================
-- Replace is_admin() checks with has_permission() for finer-grained control.
-- Keep SELECT TO PUBLIC USING (true) unchanged — everyone can read.

-- --- metadata.status_types ---
DROP POLICY IF EXISTS status_types_insert ON metadata.status_types;
DROP POLICY IF EXISTS status_types_update ON metadata.status_types;
DROP POLICY IF EXISTS status_types_delete ON metadata.status_types;

CREATE POLICY status_types_insert ON metadata.status_types
  FOR INSERT TO authenticated WITH CHECK (public.has_permission('metadata.status_types', 'create'));

CREATE POLICY status_types_update ON metadata.status_types
  FOR UPDATE TO authenticated
  USING (public.has_permission('metadata.status_types', 'update'))
  WITH CHECK (public.has_permission('metadata.status_types', 'update'));

CREATE POLICY status_types_delete ON metadata.status_types
  FOR DELETE TO authenticated USING (public.has_permission('metadata.status_types', 'delete'));

-- --- metadata.statuses ---
DROP POLICY IF EXISTS statuses_insert ON metadata.statuses;
DROP POLICY IF EXISTS statuses_update ON metadata.statuses;
DROP POLICY IF EXISTS statuses_delete ON metadata.statuses;

CREATE POLICY statuses_insert ON metadata.statuses
  FOR INSERT TO authenticated WITH CHECK (public.has_permission('metadata.statuses', 'create'));

CREATE POLICY statuses_update ON metadata.statuses
  FOR UPDATE TO authenticated
  USING (public.has_permission('metadata.statuses', 'update'))
  WITH CHECK (public.has_permission('metadata.statuses', 'update'));

CREATE POLICY statuses_delete ON metadata.statuses
  FOR DELETE TO authenticated USING (public.has_permission('metadata.statuses', 'delete'));

-- --- metadata.status_transitions ---
DROP POLICY IF EXISTS status_transitions_insert ON metadata.status_transitions;
DROP POLICY IF EXISTS status_transitions_update ON metadata.status_transitions;
DROP POLICY IF EXISTS status_transitions_delete ON metadata.status_transitions;

CREATE POLICY status_transitions_insert ON metadata.status_transitions
  FOR INSERT TO authenticated WITH CHECK (public.has_permission('metadata.status_transitions', 'create'));

CREATE POLICY status_transitions_update ON metadata.status_transitions
  FOR UPDATE TO authenticated
  USING (public.has_permission('metadata.status_transitions', 'update'))
  WITH CHECK (public.has_permission('metadata.status_transitions', 'update'));

CREATE POLICY status_transitions_delete ON metadata.status_transitions
  FOR DELETE TO authenticated USING (public.has_permission('metadata.status_transitions', 'delete'));

-- --- metadata.category_groups ---
DROP POLICY IF EXISTS category_groups_insert ON metadata.category_groups;
DROP POLICY IF EXISTS category_groups_update ON metadata.category_groups;
DROP POLICY IF EXISTS category_groups_delete ON metadata.category_groups;

CREATE POLICY category_groups_insert ON metadata.category_groups
  FOR INSERT TO authenticated WITH CHECK (public.has_permission('metadata.category_groups', 'create'));

CREATE POLICY category_groups_update ON metadata.category_groups
  FOR UPDATE TO authenticated
  USING (public.has_permission('metadata.category_groups', 'update'))
  WITH CHECK (public.has_permission('metadata.category_groups', 'update'));

CREATE POLICY category_groups_delete ON metadata.category_groups
  FOR DELETE TO authenticated USING (public.has_permission('metadata.category_groups', 'delete'));

-- --- metadata.categories ---
DROP POLICY IF EXISTS categories_insert ON metadata.categories;
DROP POLICY IF EXISTS categories_update ON metadata.categories;
DROP POLICY IF EXISTS categories_delete ON metadata.categories;

CREATE POLICY categories_insert ON metadata.categories
  FOR INSERT TO authenticated WITH CHECK (public.has_permission('metadata.categories', 'create'));

CREATE POLICY categories_update ON metadata.categories
  FOR UPDATE TO authenticated
  USING (public.has_permission('metadata.categories', 'update'))
  WITH CHECK (public.has_permission('metadata.categories', 'update'));

CREATE POLICY categories_delete ON metadata.categories
  FOR DELETE TO authenticated USING (public.has_permission('metadata.categories', 'delete'));


-- ============================================================================
-- 3. BULK PERMISSION LOADING RPC
-- ============================================================================
-- Returns all permission rows for the calling user across all their roles.
-- One call replaces N individual has_permission() calls from the frontend.

CREATE OR REPLACE FUNCTION public.get_current_user_permissions()
RETURNS TABLE(table_name NAME, permission TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
  SELECT DISTINCT p.table_name, p.permission::TEXT
  FROM metadata.permissions p
  JOIN metadata.permission_roles pr ON pr.permission_id = p.id
  JOIN metadata.roles r ON r.id = pr.role_id
  WHERE r.role_key = ANY(public.get_user_roles())
$$;

COMMENT ON FUNCTION public.get_current_user_permissions() IS
  'Returns all permission rows for the calling user across all their roles. '
  'Used by frontend to bulk-load permissions into a client-side cache, replacing '
  'individual has_permission() RPC calls. Returns (table_name, permission) pairs.';

REVOKE EXECUTE ON FUNCTION public.get_current_user_permissions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_user_permissions() TO authenticated, web_anon;


-- ============================================================================
-- 4. STATUS TYPE CRUD RPCs
-- ============================================================================

-- Upsert status type (create or update a status entity_type group)
CREATE OR REPLACE FUNCTION public.upsert_status_type(
  p_entity_type TEXT,
  p_description TEXT DEFAULT NULL,
  p_display_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  INSERT INTO metadata.status_types (entity_type, description, display_name)
  VALUES (p_entity_type, p_description, p_display_name)
  ON CONFLICT (entity_type) DO UPDATE SET
    description = COALESCE(EXCLUDED.description, metadata.status_types.description),
    display_name = COALESCE(EXCLUDED.display_name, metadata.status_types.display_name);

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.upsert_status_type(TEXT, TEXT, TEXT) IS
  'Create or update a status entity type group. SECURITY INVOKER — RLS controls access.';

REVOKE EXECUTE ON FUNCTION public.upsert_status_type(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_status_type(TEXT, TEXT, TEXT) TO authenticated;


-- Delete status type (cascades to statuses and transitions)
CREATE OR REPLACE FUNCTION public.delete_status_type(p_entity_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  DELETE FROM metadata.status_types WHERE entity_type = p_entity_type;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Status type not found');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.delete_status_type(TEXT) IS
  'Delete a status type and all its statuses/transitions (CASCADE). SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.delete_status_type(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_status_type(TEXT) TO authenticated;


-- ============================================================================
-- 5. STATUS CRUD RPCs
-- ============================================================================

-- Upsert status
CREATE OR REPLACE FUNCTION public.upsert_status(
  p_entity_type TEXT,
  p_display_name VARCHAR(50),
  p_description TEXT DEFAULT NULL,
  p_color TEXT DEFAULT '#3B82F6',
  p_sort_order INT DEFAULT 0,
  p_is_initial BOOLEAN DEFAULT FALSE,
  p_is_terminal BOOLEAN DEFAULT FALSE,
  p_status_id INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_id INT;
BEGIN
  -- If setting as initial, clear other initials in the same type first
  IF p_is_initial THEN
    UPDATE metadata.statuses
    SET is_initial = FALSE
    WHERE entity_type = p_entity_type
      AND is_initial = TRUE
      AND (p_status_id IS NULL OR id != p_status_id);
  END IF;

  IF p_status_id IS NOT NULL THEN
    -- UPDATE existing status (status_key is immutable — never updated)
    UPDATE metadata.statuses SET
      display_name = p_display_name,
      description = p_description,
      color = p_color::hex_color,
      sort_order = p_sort_order,
      is_initial = p_is_initial,
      is_terminal = p_is_terminal
    WHERE id = p_status_id AND entity_type = p_entity_type
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Status not found');
    END IF;
  ELSE
    -- INSERT new status (status_key auto-generated by trg_statuses_set_key trigger)
    INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal)
    VALUES (p_entity_type, p_display_name, p_description, p_color::hex_color, p_sort_order, p_is_initial, p_is_terminal)
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', format('A status named "%s" already exists in this type', p_display_name));
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.upsert_status IS
  'Create or update a status. status_key is immutable — auto-generated on INSERT, never changed. '
  'If p_is_initial=true, clears other initials in the same entity_type. SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.upsert_status(TEXT, VARCHAR, TEXT, TEXT, INT, BOOLEAN, BOOLEAN, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_status(TEXT, VARCHAR, TEXT, TEXT, INT, BOOLEAN, BOOLEAN, INT) TO authenticated;


-- Delete status (with reference check)
CREATE OR REPLACE FUNCTION public.delete_status(p_status_id INT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_entity_type TEXT;
  v_ref_count BIGINT := 0;
  v_table RECORD;
BEGIN
  -- Get the entity_type of the status
  SELECT entity_type INTO v_entity_type
  FROM metadata.statuses WHERE id = p_status_id;

  IF v_entity_type IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Status not found');
  END IF;

  -- Check for references in user tables:
  -- Find columns in public schema that FK to metadata.statuses and are configured
  -- for this entity_type via metadata.properties.status_entity_type
  FOR v_table IN
    SELECT DISTINCT sp.table_name, sp.column_name
    FROM public.schema_properties sp
    WHERE sp.status_entity_type = v_entity_type
      AND sp.join_table = 'statuses'
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM public.%I WHERE %I = $1',
      v_table.table_name, v_table.column_name
    ) INTO v_ref_count USING p_status_id;

    IF v_ref_count > 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Cannot delete: %s records in %s.%s reference this status',
                        v_ref_count, v_table.table_name, v_table.column_name)
      );
    END IF;
  END LOOP;

  -- Also check status_transitions references
  SELECT COUNT(*) INTO v_ref_count
  FROM metadata.status_transitions
  WHERE from_status_id = p_status_id OR to_status_id = p_status_id;

  IF v_ref_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Cannot delete: %s transition(s) reference this status. Delete transitions first.', v_ref_count)
    );
  END IF;

  DELETE FROM metadata.statuses WHERE id = p_status_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Status not found or permission denied');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.delete_status(INT) IS
  'Delete a status after checking for references in user tables and transitions. SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.delete_status(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_status(INT) TO authenticated;


-- ============================================================================
-- 6. STATUS TRANSITION CRUD RPCs
-- ============================================================================

-- Get transitions with JOINed status display names and colors
CREATE OR REPLACE FUNCTION public.get_status_transitions_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  entity_type TEXT,
  from_status_id INT,
  from_display_name VARCHAR(50),
  from_color TEXT,
  to_status_id INT,
  to_display_name VARCHAR(50),
  to_color TEXT,
  on_transition_rpc NAME,
  display_name VARCHAR(100),
  description TEXT,
  sort_order INT,
  is_enabled BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    st.id,
    st.entity_type,
    st.from_status_id,
    fs.display_name AS from_display_name,
    fs.color::TEXT AS from_color,
    st.to_status_id,
    ts.display_name AS to_display_name,
    ts.color::TEXT AS to_color,
    st.on_transition_rpc,
    st.display_name,
    st.description,
    st.sort_order,
    st.is_enabled
  FROM metadata.status_transitions st
  JOIN metadata.statuses fs ON fs.id = st.from_status_id
  JOIN metadata.statuses ts ON ts.id = st.to_status_id
  WHERE st.entity_type = p_entity_type
  ORDER BY st.sort_order, fs.sort_order, ts.sort_order;
$$;

COMMENT ON FUNCTION public.get_status_transitions_for_entity(TEXT) IS
  'Returns transitions for an entity_type with JOINed from/to status display names and colors.';

GRANT EXECUTE ON FUNCTION public.get_status_transitions_for_entity(TEXT) TO web_anon, authenticated;


-- Upsert transition
CREATE OR REPLACE FUNCTION public.upsert_status_transition(
  p_entity_type TEXT,
  p_from_status_id INT,
  p_to_status_id INT,
  p_on_transition_rpc NAME DEFAULT NULL,
  p_display_name VARCHAR(100) DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_sort_order INT DEFAULT 0,
  p_is_enabled BOOLEAN DEFAULT TRUE,
  p_transition_id INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_id INT;
BEGIN
  IF p_transition_id IS NOT NULL THEN
    -- UPDATE existing transition
    UPDATE metadata.status_transitions SET
      from_status_id = p_from_status_id,
      to_status_id = p_to_status_id,
      on_transition_rpc = p_on_transition_rpc,
      display_name = p_display_name,
      description = p_description,
      sort_order = p_sort_order,
      is_enabled = p_is_enabled
    WHERE id = p_transition_id AND entity_type = p_entity_type
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Transition not found');
    END IF;
  ELSE
    -- INSERT new transition
    INSERT INTO metadata.status_transitions (
      entity_type, from_status_id, to_status_id, on_transition_rpc,
      display_name, description, sort_order, is_enabled
    ) VALUES (
      p_entity_type, p_from_status_id, p_to_status_id, p_on_transition_rpc,
      p_display_name, p_description, p_sort_order, p_is_enabled
    )
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'This transition already exists');
  WHEN check_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'A status cannot transition to itself');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.upsert_status_transition IS
  'Create or update a status transition. SECURITY INVOKER — RLS controls access.';

REVOKE EXECUTE ON FUNCTION public.upsert_status_transition(TEXT, INT, INT, NAME, VARCHAR, TEXT, INT, BOOLEAN, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_status_transition(TEXT, INT, INT, NAME, VARCHAR, TEXT, INT, BOOLEAN, INT) TO authenticated;


-- Delete transition
CREATE OR REPLACE FUNCTION public.delete_status_transition(p_transition_id INT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  DELETE FROM metadata.status_transitions WHERE id = p_transition_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transition not found or permission denied');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.delete_status_transition(INT) IS
  'Delete a status transition. SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.delete_status_transition(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_status_transition(INT) TO authenticated;


-- ============================================================================
-- 7. CATEGORY CRUD RPCs
-- ============================================================================

-- Re-expose get_status_entity_types in public schema
-- (v0-24-0 moved it to metadata; StatusAdminService needs PostgREST access)
CREATE OR REPLACE FUNCTION public.get_status_entity_types()
RETURNS TABLE (
  entity_type TEXT,
  display_name TEXT,
  description TEXT,
  status_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    st.entity_type,
    st.display_name,
    st.description,
    COUNT(s.id) AS status_count
  FROM metadata.status_types st
  LEFT JOIN metadata.statuses s ON s.entity_type = st.entity_type
  GROUP BY st.entity_type, st.display_name, st.description
  ORDER BY st.entity_type;
$$;

COMMENT ON FUNCTION public.get_status_entity_types() IS
  'Returns all registered status entity types with their status counts. '
  'Re-exposed in public schema for PostgREST access.';

GRANT EXECUTE ON FUNCTION public.get_status_entity_types() TO web_anon, authenticated;


-- Get category entity types with counts (mirrors get_status_entity_types)
CREATE OR REPLACE FUNCTION public.get_category_entity_types()
RETURNS TABLE (
  entity_type TEXT,
  display_name TEXT,
  description TEXT,
  category_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    cg.entity_type,
    cg.display_name,
    cg.description,
    COUNT(c.id) AS category_count
  FROM metadata.category_groups cg
  LEFT JOIN metadata.categories c ON c.entity_type = cg.entity_type
  GROUP BY cg.entity_type, cg.display_name, cg.description
  ORDER BY cg.entity_type;
$$;

COMMENT ON FUNCTION public.get_category_entity_types() IS
  'Returns all registered category groups with their category counts. '
  'Mirrors get_status_entity_types() for the category system.';

GRANT EXECUTE ON FUNCTION public.get_category_entity_types() TO web_anon, authenticated;


-- Upsert category group
CREATE OR REPLACE FUNCTION public.upsert_category_group(
  p_entity_type TEXT,
  p_description TEXT DEFAULT NULL,
  p_display_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  INSERT INTO metadata.category_groups (entity_type, description, display_name)
  VALUES (p_entity_type, p_description, p_display_name)
  ON CONFLICT (entity_type) DO UPDATE SET
    description = COALESCE(EXCLUDED.description, metadata.category_groups.description),
    display_name = COALESCE(EXCLUDED.display_name, metadata.category_groups.display_name);

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.upsert_category_group(TEXT, TEXT, TEXT) IS
  'Create or update a category group. SECURITY INVOKER — RLS controls access.';

REVOKE EXECUTE ON FUNCTION public.upsert_category_group(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_category_group(TEXT, TEXT, TEXT) TO authenticated;


-- Delete category group (cascades to categories)
CREATE OR REPLACE FUNCTION public.delete_category_group(p_entity_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  DELETE FROM metadata.category_groups WHERE entity_type = p_entity_type;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Category group not found');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.delete_category_group(TEXT) IS
  'Delete a category group and all its categories (CASCADE). SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.delete_category_group(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_category_group(TEXT) TO authenticated;


-- Upsert category
CREATE OR REPLACE FUNCTION public.upsert_category(
  p_entity_type TEXT,
  p_display_name VARCHAR(50),
  p_description TEXT DEFAULT NULL,
  p_color TEXT DEFAULT '#3B82F6',
  p_sort_order INT DEFAULT 0,
  p_category_id INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_id INT;
BEGIN
  IF p_category_id IS NOT NULL THEN
    -- UPDATE existing category (category_key is immutable — never updated)
    UPDATE metadata.categories SET
      display_name = p_display_name,
      description = p_description,
      color = p_color::hex_color,
      sort_order = p_sort_order
    WHERE id = p_category_id AND entity_type = p_entity_type
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Category not found');
    END IF;
  ELSE
    -- INSERT new category (category_key auto-generated by trg_categories_set_key trigger)
    INSERT INTO metadata.categories (entity_type, display_name, description, color, sort_order)
    VALUES (p_entity_type, p_display_name, p_description, p_color::hex_color, p_sort_order)
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', format('A category named "%s" already exists in this group', p_display_name));
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.upsert_category IS
  'Create or update a category. category_key is immutable — auto-generated on INSERT, never changed. SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.upsert_category(TEXT, VARCHAR, TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_category(TEXT, VARCHAR, TEXT, TEXT, INT, INT) TO authenticated;


-- Delete category (with reference check)
CREATE OR REPLACE FUNCTION public.delete_category(p_category_id INT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_entity_type TEXT;
  v_ref_count BIGINT := 0;
  v_table RECORD;
BEGIN
  -- Get the entity_type of the category
  SELECT entity_type INTO v_entity_type
  FROM metadata.categories WHERE id = p_category_id;

  IF v_entity_type IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Category not found');
  END IF;

  -- Check for references in user tables
  FOR v_table IN
    SELECT DISTINCT sp.table_name, sp.column_name
    FROM public.schema_properties sp
    WHERE sp.category_entity_type = v_entity_type
      AND sp.join_table = 'categories'
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM public.%I WHERE %I = $1',
      v_table.table_name, v_table.column_name
    ) INTO v_ref_count USING p_category_id;

    IF v_ref_count > 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Cannot delete: %s records in %s.%s reference this category',
                        v_ref_count, v_table.table_name, v_table.column_name)
      );
    END IF;
  END LOOP;

  DELETE FROM metadata.categories WHERE id = p_category_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Category not found or permission denied');
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permission denied');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.delete_category(INT) IS
  'Delete a category after checking for references in user tables. SECURITY INVOKER.';

REVOKE EXECUTE ON FUNCTION public.delete_category(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_category(INT) TO authenticated;


-- ============================================================================
-- 8. SCHEMA DECISION
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, property_names, migration_id, title, status,
    context, decision, decided_date
) VALUES (
    ARRAY['statuses', 'categories']::NAME[],
    ARRAY[]::NAME[],
    'v0-40-0-status-category-admin-rpcs',
    'CRUD RPCs for browser-based status and category administration',
    'accepted',
    'Statuses and categories could only be managed via SQL. Status transitions (v0.33.0) '
        'also lacked UI management. Integrators needed browser-based admin pages to manage '
        'these core metadata types without database access.',
    'Added CRUD RPCs for statuses, categories, and transitions following the admin pattern '
        '(VIEWs for reads, RPCs for writes). All mutation RPCs use SECURITY INVOKER so RLS '
        'controls access. Upgraded RLS policies from is_admin() to has_permission() for '
        'finer-grained control. Added get_current_user_permissions() bulk-loading RPC '
        'to replace N individual has_permission() calls from the frontend with a single '
        'cached lookup. status_key and category_key remain immutable (auto-generated on INSERT).',
    CURRENT_DATE
);


-- ============================================================================
-- 9. NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
