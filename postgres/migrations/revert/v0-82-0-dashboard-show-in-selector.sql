-- Revert civic_os:v0-82-0-dashboard-show-in-selector
--
-- Restores get_dashboards(), get_dashboard() and get_user_default_dashboard() as v0-80-3-dashboard-role-visibility
-- left them (bodies copied verbatim), then drops the column.

BEGIN;

-- get_dashboards(): back to the v0.80.3 return type. The old function predates v0-76-5-revoke-public-execute and
-- kept its PUBLIC grant; the default privileges from that change would otherwise leave the re-created function
-- without it.
DROP FUNCTION public.get_dashboards();

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
  v_roles TEXT[];
BEGIN
  v_roles := public.get_user_roles();

  RETURN QUERY
  SELECT
    d.id,
    metadata.t('dashboard', 'dashboard.' || d.id::text || '.display_name', d.display_name::text)::VARCHAR(100) AS display_name,
    metadata.t('dashboard', 'dashboard.' || d.id::text || '.description', d.description) AS description,
    d.is_default,
    d.is_public,
    d.show_title,
    d.sort_order,
    d.created_by,
    d.created_at,
    d.updated_at,
    EXISTS (
      SELECT 1
      FROM metadata.dashboard_roles dr
      JOIN metadata.roles r ON r.id = dr.role_id
      WHERE dr.dashboard_id = d.id
        AND dr.mode = 'default'
        AND r.role_key = ANY(v_roles)
    ) AS is_role_default
  FROM metadata.dashboards d
  WHERE metadata.dashboard_visible(d.id, d.is_public, d.created_by)
  ORDER BY d.sort_order ASC, d.display_name ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, metadata;

COMMENT ON FUNCTION public.get_dashboards() IS
  'Returns the dashboards the current user can see (see metadata.dashboard_visible). display_name and description are translated via metadata.t(). is_role_default marks the default of one of the caller''s roles.';

GRANT EXECUTE ON FUNCTION public.get_dashboards() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboards() TO web_anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_dashboard(p_dashboard_id INT)
RETURNS JSON AS $$
DECLARE
  v_dashboard JSON;
  v_widgets JSON;
  v_result JSON;
BEGIN
  
  IF NOT metadata.can_see_dashboard(p_dashboard_id) THEN
    RETURN NULL;
  END IF;

  -- Get dashboard data
  SELECT row_to_json(d.*) INTO v_dashboard
  FROM metadata.dashboards d
  WHERE d.id = p_dashboard_id;

  -- Get widgets with translated title and config
  SELECT json_agg(widget_row ORDER BY widget_row.sort_order) INTO v_widgets
  FROM (
    SELECT
      w.id,
      w.dashboard_id,
      w.widget_type,
      metadata.t('dashboard', 'dashboard.' || p_dashboard_id || '.widget.' || w.id || '.title', w.title) AS title,
      w.entity_key,
      w.refresh_interval_seconds,
      w.sort_order,
      w.width,
      w.height,
      metadata.translate_widget_config(w.widget_type, p_dashboard_id, w.id, w.config) AS config,
      w.created_at,
      w.updated_at
    FROM metadata.dashboard_widgets w
    WHERE w.dashboard_id = p_dashboard_id
  ) widget_row;

  -- Combine into single JSON object with translated dashboard fields
  v_result := jsonb_build_object(
    'id', (v_dashboard->>'id')::INT,
    'display_name', metadata.t('dashboard', 'dashboard.' || p_dashboard_id::text || '.display_name',
      v_dashboard->>'display_name'),
    'description', metadata.t('dashboard', 'dashboard.' || p_dashboard_id::text || '.description',
      v_dashboard->>'description'),
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
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, metadata;

CREATE OR REPLACE FUNCTION public.get_user_default_dashboard()
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_dashboard_id INT;
  v_roles TEXT[];
BEGIN
  v_user_id := public.current_user_id();
  v_roles := public.get_user_roles();

  -- Tier 1: user preference, unless the user can no longer see that dashboard
  IF v_user_id IS NOT NULL THEN
    SELECT default_dashboard_id INTO v_dashboard_id
    FROM metadata.user_dashboard_preferences
    WHERE user_id = v_user_id;

    IF v_dashboard_id IS NOT NULL AND metadata.can_see_dashboard(v_dashboard_id) THEN
      RETURN v_dashboard_id;
    END IF;
  END IF;

  -- Tier 2: role default (highest priority among the caller's roles; anonymous callers use the anonymous role)
  SELECT dr.dashboard_id INTO v_dashboard_id
  FROM metadata.dashboard_roles dr
  JOIN metadata.roles r ON r.id = dr.role_id
  WHERE dr.mode = 'default'
    AND r.role_key = ANY(v_roles)
    AND metadata.can_see_dashboard(dr.dashboard_id)
  ORDER BY dr.priority DESC, dr.dashboard_id
  LIMIT 1;

  IF v_dashboard_id IS NOT NULL THEN
    RETURN v_dashboard_id;
  END IF;

  -- Tier 3: system default, if the caller can see it (tiers 2 and 3 check too, like tier 1)
  SELECT d.id INTO v_dashboard_id
  FROM metadata.dashboards d
  WHERE d.is_default = TRUE
    AND d.is_public = TRUE
    AND metadata.dashboard_visible(d.id, d.is_public, d.created_by)
  LIMIT 1;

  IF v_dashboard_id IS NOT NULL THEN
    RETURN v_dashboard_id;
  END IF;

  -- Tier 4: nothing above applied, so the first dashboard the caller can see
  SELECT d.id INTO v_dashboard_id
  FROM metadata.dashboards d
  WHERE metadata.dashboard_visible(d.id, d.is_public, d.created_by)
  ORDER BY d.sort_order, d.id
  LIMIT 1;

  RETURN v_dashboard_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, metadata;

ALTER TABLE metadata.dashboards DROP COLUMN show_in_selector;

COMMIT;
