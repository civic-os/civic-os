-- Revert civic_os:v0-80-3-dashboard-role-visibility
--
-- Rebuilds dashboard_role_defaults from the 'default' rows (show grants are lost: a dashboard that is not
-- public returns to creator-only), restores the v0.62.0 / v0.37.0 function bodies and the baseline read policies,
-- drops the new objects, and deletes only the translation rows still holding the seeded text.

BEGIN;

-- 1. Stop syncing, then rebuild the legacy table from the default rows.
DROP TRIGGER sync_dashboard_role_default ON metadata.dashboard_role_defaults;
DROP FUNCTION metadata.sync_dashboard_role_default();

INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
SELECT role_id, dashboard_id, priority
FROM metadata.dashboard_roles
WHERE mode = 'default'
ON CONFLICT (role_id) DO UPDATE
  SET dashboard_id = EXCLUDED.dashboard_id,
      priority = EXCLUDED.priority;

DELETE FROM metadata.dashboard_role_defaults
WHERE role_id NOT IN (SELECT role_id FROM metadata.dashboard_roles WHERE mode = 'default');

COMMENT ON TABLE metadata.dashboard_role_defaults IS
  'Maps roles to their default dashboard. When a user has multiple roles,
   the role default with the highest priority wins.';

-- 2. Baseline read policies back (v0-4-0-baseline).
DROP POLICY "Dashboards visible by role" ON metadata.dashboards;
DROP POLICY "Widgets visible with their dashboard" ON metadata.dashboard_widgets;

CREATE POLICY "Everyone can read public dashboards"
  ON metadata.dashboards
  FOR SELECT
  TO PUBLIC
  USING (is_public = TRUE);

CREATE POLICY "Users can read own private dashboards"
  ON metadata.dashboards
  FOR SELECT
  TO authenticated
  USING (created_by = public.current_user_id());

CREATE POLICY "Everyone can read public dashboard widgets"
  ON metadata.dashboard_widgets
  FOR SELECT
  TO PUBLIC
  USING (
    dashboard_id IN (
      SELECT id FROM metadata.dashboards WHERE is_public = TRUE
    )
  );

CREATE POLICY "Users can read own dashboard widgets"
  ON metadata.dashboard_widgets
  FOR SELECT
  TO authenticated
  USING (
    dashboard_id IN (
      SELECT id FROM metadata.dashboards
      WHERE created_by = public.current_user_id()
    )
  );

-- 3. Function bodies as of v0.62.0 (get_dashboard, get_dashboards) and v0.37.0 (get_user_default_dashboard).
--    CREATE OR REPLACE also clears the SET search_path this migration added.
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
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;


CREATE OR REPLACE FUNCTION public.get_dashboards()
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


COMMENT ON FUNCTION public.get_dashboards() IS
  'Returns all dashboards visible to the current user (public + private). display_name and description are translated via metadata.t().';

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


-- 4. Drop the new objects.
DROP FUNCTION public.set_dashboard_roles(INT, TEXT[], TEXT, INT);
DROP FUNCTION metadata.can_see_dashboard(INT);
DROP FUNCTION metadata.dashboard_visible(INT, BOOLEAN, UUID);
DROP TABLE metadata.dashboard_roles;

-- 5. Seeded translations that still hold the seeded text.
DELETE FROM metadata.translations t
USING (VALUES
  ('dashboard.error.not_found', 'en', 'Dashboard not found'),
  ('dashboard.error.not_found', 'es', 'Tablero no encontrado'),
  ('dashboard.error.not_found', 'ar', 'لوحة المعلومات غير موجودة'),
  ('dashboard.error.not_found', 'fr', 'Tableau de bord introuvable'),
  ('dashboard.error.not_found', 'de', 'Dashboard nicht gefunden'),
  ('dashboard.error.not_found', 'ps', 'ډشبورډ ونه موندل شو'),
  ('dashboard.error.load_failed', 'en', 'Failed to load dashboard'),
  ('dashboard.error.load_failed', 'es', 'Error al cargar el tablero'),
  ('dashboard.error.load_failed', 'ar', 'فشل تحميل لوحة المعلومات'),
  ('dashboard.error.load_failed', 'fr', 'Échec du chargement du tableau de bord'),
  ('dashboard.error.load_failed', 'de', 'Dashboard konnte nicht geladen werden'),
  ('dashboard.error.load_failed', 'ps', 'ډشبورډ پورته کول ناکام شو'),
  ('dashboard.error.load_default_failed', 'en', 'Failed to load default dashboard'),
  ('dashboard.error.load_default_failed', 'es', 'Error al cargar el tablero predeterminado'),
  ('dashboard.error.load_default_failed', 'ar', 'فشل تحميل لوحة المعلومات الافتراضية'),
  ('dashboard.error.load_default_failed', 'fr', 'Échec du chargement du tableau de bord par défaut'),
  ('dashboard.error.load_default_failed', 'de', 'Standard-Dashboard konnte nicht geladen werden'),
  ('dashboard.error.load_default_failed', 'ps', 'اصلي ډشبورډ پورته کول ناکام شو'),
  ('dashboard.error.no_default', 'en', 'No default dashboard found. Please contact an administrator.'),
  ('dashboard.error.no_default', 'es', 'No se encontró un tablero predeterminado. Comuníquese con un administrador.'),
  ('dashboard.error.no_default', 'ar', 'لم يتم العثور على لوحة معلومات افتراضية. يرجى الاتصال بالمسؤول.'),
  ('dashboard.error.no_default', 'fr', 'Aucun tableau de bord par défaut trouvé. Veuillez contacter un administrateur.'),
  ('dashboard.error.no_default', 'de', 'Kein Standard-Dashboard gefunden. Bitte wenden Sie sich an einen Administrator.'),
  ('dashboard.error.no_default', 'ps', 'اصلي ډشبورډ ونه موندل شو. مهرباني وکړئ له یو اډمین سره اړیکه ونیسئ.'),
  ('dashboard.error.title', 'en', 'Failed to Load Dashboard'),
  ('dashboard.error.title', 'es', 'Error al cargar el tablero'),
  ('dashboard.error.title', 'ar', 'فشل تحميل لوحة المعلومات'),
  ('dashboard.error.title', 'fr', 'Échec du chargement du tableau de bord'),
  ('dashboard.error.title', 'de', 'Dashboard konnte nicht geladen werden'),
  ('dashboard.error.title', 'ps', 'ډشبورډ پورته کول ناکام شو')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

NOTIFY pgrst, 'reload schema';

COMMIT;
