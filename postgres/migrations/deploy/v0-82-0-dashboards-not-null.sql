-- Deploy civic_os:v0-82-0-dashboards-not-null
-- Requires: v0-82-0-dashboard-show-in-selector
--
-- v0.82.0 -- metadata.dashboards columns that every reader already treats as always set become NOT NULL, so the
-- table matches @civic-os/core's Dashboard type (is_default, is_public, sort_order, created_at and updated_at are
-- non-null there).
--   1. Backfill, only on rows that hold a NULL, with the value the code already reads a NULL as, so no instance
--      changes behavior:
--        is_public  NULL -> FALSE  metadata.dashboard_visible() reads COALESCE(is_public, FALSE): a NULL dashboard
--                                  is private today (so was the baseline policy, is_public = true). Not the column
--                                  default (TRUE), which would expose it.
--        is_default NULL -> FALSE  tier 3 of get_user_default_dashboard() matches is_default = TRUE only.
--        sort_order NULL -> one past the largest sort_order (+10). NULLs sort last in ascending order and tie
--                                  with each other, so they stay last and keep their tie-break (display_name in
--                                  get_dashboards(), id in the landing fallback). Not the default (0), which would
--                                  move them to the top of the selector.
--        created_at NULL -> updated_at, else now(). updated_at is set by set_updated_at_trigger on the backfill.
--      This is a shape fix (the NOT NULL needs it), not instance content: a row without NULLs is not touched.
--   2. SET NOT NULL on the five columns. created_at and updated_at are set by BEFORE INSERT/UPDATE triggers anyway.
--   3. get_dashboard() drops the COALESCE on show_title and show_in_selector, both NOT NULL.

BEGIN;

-- ============================================================================
-- 1. Backfill NULLs with what readers already take them to mean
-- ============================================================================

UPDATE metadata.dashboards
SET is_public = COALESCE(is_public, FALSE),
    is_default = COALESCE(is_default, FALSE),
    sort_order = COALESCE(sort_order, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM metadata.dashboards)),
    created_at = COALESCE(created_at, updated_at, NOW())
WHERE is_public IS NULL
   OR is_default IS NULL
   OR sort_order IS NULL
   OR created_at IS NULL
   OR updated_at IS NULL;

-- ============================================================================
-- 2. NOT NULL
-- ============================================================================

ALTER TABLE metadata.dashboards
  ALTER COLUMN is_default SET NOT NULL,
  ALTER COLUMN is_public SET NOT NULL,
  ALTER COLUMN sort_order SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- ============================================================================
-- 3. get_dashboard(): no COALESCE on NOT NULL columns
-- ============================================================================

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
    'show_title', (v_dashboard->>'show_title')::BOOLEAN,
    'show_in_selector', (v_dashboard->>'show_in_selector')::BOOLEAN,
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

COMMIT;
