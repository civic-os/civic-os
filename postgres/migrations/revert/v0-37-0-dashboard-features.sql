-- Revert civic_os:v0-37-0-dashboard-features from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE get_dashboards() without is_role_default / show_title
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_dashboards()
RETURNS TABLE (
  id INT,
  display_name VARCHAR(100),
  description TEXT,
  is_default BOOLEAN,
  is_public BOOLEAN,
  sort_order INT,
  created_by UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.display_name,
    d.description,
    d.is_default,
    d.is_public,
    d.sort_order,
    d.created_by,
    d.created_at,
    d.updated_at
  FROM metadata.dashboards d
  WHERE d.is_public = TRUE
     OR d.created_by = public.current_user_id()
  ORDER BY d.sort_order ASC, d.display_name ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================================
-- 2. RESTORE get_user_default_dashboard() without role-default tier
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_user_default_dashboard()
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_dashboard_id INT;
BEGIN
  v_user_id := public.current_user_id();

  -- Try user preference first
  IF v_user_id IS NOT NULL THEN
    SELECT default_dashboard_id INTO v_dashboard_id
    FROM metadata.user_dashboard_preferences
    WHERE user_id = v_user_id;

    IF v_dashboard_id IS NOT NULL THEN
      RETURN v_dashboard_id;
    END IF;
  END IF;

  -- Fall back to system default
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE is_default = TRUE AND is_public = TRUE
  LIMIT 1;

  RETURN v_dashboard_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 3. RESTORE get_dashboard() without show_title
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_dashboard(p_dashboard_id INT)
RETURNS JSON AS $$
DECLARE
  v_dashboard JSON;
  v_widgets JSON;
  v_result JSON;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM metadata.dashboards
    WHERE id = p_dashboard_id
      AND (is_public = TRUE OR created_by = public.current_user_id())
  ) THEN
    RETURN NULL;
  END IF;

  SELECT row_to_json(d.*) INTO v_dashboard
  FROM metadata.dashboards d
  WHERE d.id = p_dashboard_id;

  SELECT json_agg(w.* ORDER BY w.sort_order) INTO v_widgets
  FROM metadata.dashboard_widgets w
  WHERE w.dashboard_id = p_dashboard_id;

  v_result := jsonb_build_object(
    'id', (v_dashboard->>'id')::INT,
    'display_name', v_dashboard->>'display_name',
    'description', v_dashboard->>'description',
    'is_default', (v_dashboard->>'is_default')::BOOLEAN,
    'is_public', (v_dashboard->>'is_public')::BOOLEAN,
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
-- 4. DROP dashboard_role_defaults TABLE
-- ============================================================================

DROP TABLE IF EXISTS metadata.dashboard_role_defaults;

-- ============================================================================
-- 5. DROP show_title COLUMN
-- ============================================================================

ALTER TABLE metadata.dashboards DROP COLUMN IF EXISTS show_title;

COMMIT;
