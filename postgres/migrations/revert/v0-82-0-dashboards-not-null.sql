-- Revert civic_os:v0-82-0-dashboards-not-null
--
-- Drops the NOT NULL constraints and restores get_dashboard() as v0-82-0-dashboard-show-in-selector left it. The
-- backfilled values stay: they are the values the code read the NULLs as, so behavior is unchanged.

BEGIN;

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
    'show_in_selector', COALESCE((v_dashboard->>'show_in_selector')::BOOLEAN, TRUE),
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

ALTER TABLE metadata.dashboards
  ALTER COLUMN is_default DROP NOT NULL,
  ALTER COLUMN is_public DROP NOT NULL,
  ALTER COLUMN sort_order DROP NOT NULL,
  ALTER COLUMN created_at DROP NOT NULL,
  ALTER COLUMN updated_at DROP NOT NULL;

COMMIT;
