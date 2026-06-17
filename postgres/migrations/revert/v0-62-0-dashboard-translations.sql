-- Revert civic_os:v0-62-0-dashboard-translations from pg

BEGIN;

-- ============================================================================
-- 1. RESTORE get_dashboards() to pre-t() version (from v0-37-0)
-- ============================================================================

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

-- ============================================================================
-- 2. RESTORE get_dashboard() to pre-t() version (from v0-37-0)
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
-- 3. DROP translate_widget_config() HELPER
-- ============================================================================

DROP FUNCTION IF EXISTS metadata.translate_widget_config(TEXT, INT, INT, JSONB);

-- ============================================================================
-- 4. DROP get_translation_defaults() RPC
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_translation_defaults();

-- ============================================================================
-- 5. RESTORE get_missing_translations() to v0-58-0 version
-- ============================================================================
-- Original only checked UI strings with English rows, not metadata sources.

CREATE OR REPLACE FUNCTION public.get_missing_translations(p_target_locale TEXT)
RETURNS TABLE(source_type TEXT, source_key TEXT, default_text TEXT)
AS $$
  SELECT t.source_type::TEXT, t.source_key, t.translated_text
  FROM metadata.translations t
  WHERE t.locale = 'en'
    AND NOT EXISTS (
      SELECT 1 FROM metadata.translations t2
      WHERE t2.source_type = t.source_type
        AND t2.source_key = t.source_key
        AND t2.locale = p_target_locale
    );
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- 6. RESTORE get_statuses_for_entity() to pre-t() version (from v0-48-0)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_statuses_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT,
  is_initial BOOLEAN,
  is_terminal BOOLEAN,
  status_key VARCHAR(50)
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name, description, color, sort_order, is_initial, is_terminal, status_key
  FROM metadata.statuses
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

-- ============================================================================
-- 7. RESTORE get_categories_for_entity() to pre-t() version (from v0-34-0)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_categories_for_entity(p_entity_type TEXT)
RETURNS TABLE (
  id INT,
  display_name VARCHAR(50),
  description TEXT,
  color hex_color,
  sort_order INT
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, display_name, description, color, sort_order
  FROM metadata.categories
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

-- ============================================================================
-- 8. DELETE seeded translation rows added by this migration
-- ============================================================================

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key IN ('sidebar.translations', 'list.title_suffix');

COMMIT;
