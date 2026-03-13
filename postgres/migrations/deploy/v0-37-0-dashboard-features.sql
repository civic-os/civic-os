-- Deploy civic_os:v0-37-0-dashboard-features to pg
-- requires: v0-36-0-keycloak-sync-triggers

BEGIN;

-- ============================================================================
-- DASHBOARD FEATURES
-- ============================================================================
-- Version: v0.37.0
-- Purpose: Add show_title toggle for dashboards and role-based default dashboards
--
-- Changes:
--   1. Add show_title column to metadata.dashboards
--   2. Create metadata.dashboard_role_defaults table
--   3. Update get_dashboard() to include show_title
--   4. Update get_user_default_dashboard() with role-default fallback
--   5. Update get_dashboards() to include is_role_default column
-- ============================================================================

-- ============================================================================
-- 1. ADD show_title COLUMN
-- ============================================================================

ALTER TABLE metadata.dashboards ADD COLUMN show_title BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN metadata.dashboards.show_title IS
  'Whether to display the dashboard header (title + description). Default TRUE.';

-- ============================================================================
-- 2. CREATE dashboard_role_defaults TABLE
-- ============================================================================

CREATE TABLE metadata.dashboard_role_defaults (
  id SERIAL PRIMARY KEY,
  role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
  dashboard_id INT NOT NULL REFERENCES metadata.dashboards(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  UNIQUE (role_id)
);

COMMENT ON TABLE metadata.dashboard_role_defaults IS
  'Maps roles to their default dashboard. When a user has multiple roles,
   the role default with the highest priority wins.';

COMMENT ON COLUMN metadata.dashboard_role_defaults.priority IS
  'Higher values take precedence when user has multiple roles with defaults.';

-- RLS: public read, admin write
ALTER TABLE metadata.dashboard_role_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_dashboard_role_defaults ON metadata.dashboard_role_defaults
  FOR SELECT TO web_anon, authenticated
  USING (TRUE);

CREATE POLICY insert_dashboard_role_defaults ON metadata.dashboard_role_defaults
  FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY update_dashboard_role_defaults ON metadata.dashboard_role_defaults
  FOR UPDATE TO authenticated
  USING (is_admin());

CREATE POLICY delete_dashboard_role_defaults ON metadata.dashboard_role_defaults
  FOR DELETE TO authenticated
  USING (is_admin());

GRANT SELECT ON metadata.dashboard_role_defaults TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.dashboard_role_defaults TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.dashboard_role_defaults_id_seq TO authenticated;

-- Index for join performance
CREATE INDEX idx_dashboard_role_defaults_dashboard_id
  ON metadata.dashboard_role_defaults(dashboard_id);

-- ============================================================================
-- 3. UPDATE get_dashboard() TO INCLUDE show_title
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_dashboard(p_dashboard_id INT)
RETURNS JSON AS $$
DECLARE
  v_dashboard JSON;
  v_widgets JSON;
  v_result JSON;
BEGIN
  -- Check if user can access this dashboard
  IF NOT EXISTS (
    SELECT 1 FROM metadata.dashboards
    WHERE id = p_dashboard_id
      AND (is_public = TRUE OR created_by = public.current_user_id())
  ) THEN
    RETURN NULL;
  END IF;

  -- Get dashboard data
  SELECT row_to_json(d.*) INTO v_dashboard
  FROM metadata.dashboards d
  WHERE d.id = p_dashboard_id;

  -- Get widgets data (sorted by sort_order)
  SELECT json_agg(w.* ORDER BY w.sort_order) INTO v_widgets
  FROM metadata.dashboard_widgets w
  WHERE w.dashboard_id = p_dashboard_id;

  -- Combine into single JSON object with widgets array
  v_result := jsonb_build_object(
    'id', (v_dashboard->>'id')::INT,
    'display_name', v_dashboard->>'display_name',
    'description', v_dashboard->>'description',
    'is_default', (v_dashboard->>'is_default')::BOOLEAN,
    'is_public', (v_dashboard->>'is_public')::BOOLEAN,
    'show_title', COALESCE((v_dashboard->>'show_title')::BOOLEAN, TRUE),
    'sort_order', (v_dashboard->>'sort_order')::INT,
    'created_by', (v_dashboard->>'created_by')::UUID,
    'created_at', v_dashboard->>'created_at',
    'updated_at', v_dashboard->>'updated_at',
    'widgets', COALESCE(v_widgets, '[]'::json)
  );

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================================
-- 4. UPDATE get_user_default_dashboard() WITH ROLE-DEFAULT FALLBACK
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_user_default_dashboard()
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_dashboard_id INT;
BEGIN
  v_user_id := public.current_user_id();

  -- Tier 1: User preference
  IF v_user_id IS NOT NULL THEN
    SELECT default_dashboard_id INTO v_dashboard_id
    FROM metadata.user_dashboard_preferences
    WHERE user_id = v_user_id;

    IF v_dashboard_id IS NOT NULL THEN
      RETURN v_dashboard_id;
    END IF;
  END IF;

  -- Tier 2: Role default (highest priority among user's roles)
  IF v_user_id IS NOT NULL THEN
    SELECT drd.dashboard_id INTO v_dashboard_id
    FROM metadata.dashboard_role_defaults drd
    JOIN metadata.user_roles ur ON ur.role_id = drd.role_id
    WHERE ur.user_id = v_user_id
    ORDER BY drd.priority DESC
    LIMIT 1;

    IF v_dashboard_id IS NOT NULL THEN
      RETURN v_dashboard_id;
    END IF;
  END IF;

  -- Tier 3: System default
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE is_default = TRUE AND is_public = TRUE
  LIMIT 1;

  RETURN v_dashboard_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 5. UPDATE get_dashboards() TO INCLUDE is_role_default
-- ============================================================================
-- Must DROP first because we're adding columns to RETURNS TABLE (changing return type)

DROP FUNCTION IF EXISTS public.get_dashboards();

CREATE FUNCTION public.get_dashboards()
RETURNS TABLE (
  id INT,
  display_name VARCHAR(100),
  description TEXT,
  is_default BOOLEAN,
  is_public BOOLEAN,
  show_title BOOLEAN,
  sort_order INT,
  created_by UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  is_role_default BOOLEAN
) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := public.current_user_id();

  RETURN QUERY
  SELECT
    d.id,
    d.display_name,
    d.description,
    d.is_default,
    d.is_public,
    d.show_title,
    d.sort_order,
    d.created_by,
    d.created_at,
    d.updated_at,
    EXISTS (
      SELECT 1
      FROM metadata.dashboard_role_defaults drd
      JOIN metadata.user_roles ur ON ur.role_id = drd.role_id
      WHERE drd.dashboard_id = d.id
        AND ur.user_id = v_user_id
    ) AS is_role_default
  FROM metadata.dashboards d
  WHERE d.is_public = TRUE
     OR d.created_by = v_user_id
  ORDER BY d.sort_order ASC, d.display_name ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.get_dashboards() TO web_anon, authenticated;

COMMENT ON FUNCTION public.get_dashboards() IS
  'Returns all dashboards visible to the current user (public dashboards + user''s private dashboards). Includes is_role_default flag.';

COMMIT;
