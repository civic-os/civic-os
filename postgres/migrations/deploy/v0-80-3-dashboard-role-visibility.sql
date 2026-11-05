-- Deploy civic_os:v0-80-3-dashboard-role-visibility
-- Requires: v0-80-2-widget-empty-message
--
-- v0.80.3 -- Let a dashboard be visible to specific roles (issue #55).
--   1. metadata.dashboard_roles(dashboard_id, role_id, mode, priority): mode 'show' restricts a dashboard to
--      the listed roles, mode 'default' makes it that role's landing dashboard (and lets the role see it).
--      Existing metadata.dashboard_role_defaults rows are copied in as 'default' rows.
--   2. dashboard_role_defaults stays as a table, so seeds that upsert into it (ON CONFLICT (role_id)) keep
--      working; AFTER triggers copy its writes into dashboard_roles (one way, legacy to new). It is a
--      deprecated write path: use set_dashboard_roles().
--   3. One rule, metadata.dashboard_visible(), shared by get_dashboards(), get_dashboard(),
--      get_user_default_dashboard() and RLS on metadata.dashboards and metadata.dashboard_widgets:
--      admin, or creator, or (no 'show' rows AND is_public), or the caller holds a role with a row.
--      Roles come from get_user_roles() (JWT roles, honors impersonation, 'anonymous' when signed out).
--   4. public.set_dashboard_roles(dashboard_id, role_keys, mode, priority), admin only.
--   5. Seeds the dashboard page error strings for the six core locales (ON CONFLICT DO NOTHING).

BEGIN;

-- ============================================================================
-- 1. dashboard_roles
-- ============================================================================

CREATE TABLE metadata.dashboard_roles (
  dashboard_id INT NOT NULL REFERENCES metadata.dashboards(id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES metadata.roles(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('show', 'default')),
  priority INT NOT NULL DEFAULT 0,
  PRIMARY KEY (dashboard_id, role_id)
);

COMMENT ON TABLE metadata.dashboard_roles IS
  'Roles that can see a dashboard (mode show) or land on it by default (mode default, which also grants visibility). A dashboard with any show row is restricted to the roles listed; a default row never restricts. Write through set_dashboard_roles().';
COMMENT ON COLUMN metadata.dashboard_roles.priority IS
  'For mode default: higher wins when a user holds several roles that have a default dashboard.';

-- The primary key covers dashboard_id; the role_id FK needs its own index.
CREATE INDEX idx_dashboard_roles_role_id ON metadata.dashboard_roles(role_id);

-- A role has at most one default dashboard.
CREATE UNIQUE INDEX idx_dashboard_roles_one_default_per_role
  ON metadata.dashboard_roles(role_id) WHERE mode = 'default';

ALTER TABLE metadata.dashboard_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_dashboard_roles ON metadata.dashboard_roles
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY insert_dashboard_roles ON metadata.dashboard_roles
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY update_dashboard_roles ON metadata.dashboard_roles
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY delete_dashboard_roles ON metadata.dashboard_roles
  FOR DELETE TO authenticated USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.dashboard_roles TO authenticated;

-- Structural move: every legacy default keeps its meaning as a 'default' row.
INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode, priority)
SELECT dashboard_id, role_id, 'default', priority
FROM metadata.dashboard_role_defaults;

-- ============================================================================
-- 2. Legacy compatibility: dashboard_role_defaults writes flow into dashboard_roles
-- ============================================================================

CREATE FUNCTION metadata.sync_dashboard_role_default()
RETURNS TRIGGER AS $$
BEGIN
  -- A role has one default; drop the old one (and any diverged one) before writing the new one.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM metadata.dashboard_roles WHERE mode = 'default' AND role_id = OLD.role_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    DELETE FROM metadata.dashboard_roles WHERE mode = 'default' AND role_id = NEW.role_id;
    INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode, priority)
    VALUES (NEW.dashboard_id, NEW.role_id, 'default', NEW.priority)
    ON CONFLICT (dashboard_id, role_id) DO UPDATE SET mode = 'default', priority = EXCLUDED.priority;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, metadata;

REVOKE EXECUTE ON FUNCTION metadata.sync_dashboard_role_default() FROM PUBLIC;

CREATE TRIGGER sync_dashboard_role_default
  AFTER INSERT OR UPDATE OR DELETE ON metadata.dashboard_role_defaults
  FOR EACH ROW EXECUTE FUNCTION metadata.sync_dashboard_role_default();

COMMENT ON TABLE metadata.dashboard_role_defaults IS
  'Deprecated write path (v0.80.3): writes are copied into metadata.dashboard_roles, which the dashboard functions read. Use set_dashboard_roles(). Rows are not updated when set_dashboard_roles() writes defaults.';

-- ============================================================================
-- 3. The visibility rule
-- ============================================================================
-- SECURITY DEFINER so it can read dashboard_roles (admin-only) from RLS policies and RPCs. It takes the
-- dashboard's own columns and never reads metadata.dashboards, so the dashboards policy cannot recurse.

CREATE FUNCTION metadata.dashboard_visible(p_id INT, p_is_public BOOLEAN, p_created_by UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_roles TEXT[];
BEGIN
  IF public.is_admin() THEN
    RETURN TRUE;
  END IF;

  IF p_created_by IS NOT NULL AND p_created_by = public.current_user_id() THEN
    RETURN TRUE;
  END IF;

  v_roles := public.get_user_roles();

  IF EXISTS (
    SELECT 1
    FROM metadata.dashboard_roles dr
    JOIN metadata.roles r ON r.id = dr.role_id
    WHERE dr.dashboard_id = p_id
      AND r.role_key = ANY(v_roles)
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN COALESCE(p_is_public, FALSE)
    AND NOT EXISTS (
      SELECT 1 FROM metadata.dashboard_roles dr
      WHERE dr.dashboard_id = p_id AND dr.mode = 'show'
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, metadata;

CREATE FUNCTION metadata.can_see_dashboard(p_id INT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM metadata.dashboards d
    WHERE d.id = p_id
      AND metadata.dashboard_visible(d.id, d.is_public, d.created_by)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, metadata;

REVOKE EXECUTE ON FUNCTION metadata.dashboard_visible(INT, BOOLEAN, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION metadata.can_see_dashboard(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.dashboard_visible(INT, BOOLEAN, UUID) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata.can_see_dashboard(INT) TO web_anon, authenticated;

COMMENT ON FUNCTION metadata.dashboard_visible(INT, BOOLEAN, UUID) IS
  'Dashboard visibility rule: admin, or creator, or (no show rows and is_public), or the caller holds a role with a dashboard_roles row. Roles come from get_user_roles().';

-- ============================================================================
-- 4. RLS on dashboards and dashboard_widgets
-- ============================================================================

DROP POLICY "Everyone can read public dashboards" ON metadata.dashboards;
DROP POLICY "Users can read own private dashboards" ON metadata.dashboards;

CREATE POLICY "Dashboards visible by role" ON metadata.dashboards
  FOR SELECT TO web_anon, authenticated
  USING (metadata.dashboard_visible(id, is_public, created_by));

DROP POLICY "Everyone can read public dashboard widgets" ON metadata.dashboard_widgets;
DROP POLICY "Users can read own dashboard widgets" ON metadata.dashboard_widgets;

-- The subquery runs under the caller's dashboards policy, so the rule lives in one place.
CREATE POLICY "Widgets visible with their dashboard" ON metadata.dashboard_widgets
  FOR SELECT TO web_anon, authenticated
  USING (dashboard_id IN (SELECT id FROM metadata.dashboards));

-- ============================================================================
-- 5. RPCs (same signatures, so CREATE OR REPLACE keeps the grants)
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
  ORDER BY dr.priority DESC, dr.dashboard_id
  LIMIT 1;

  IF v_dashboard_id IS NOT NULL THEN
    RETURN v_dashboard_id;
  END IF;

  -- Tier 3: system default, if the caller can see it
  SELECT d.id INTO v_dashboard_id
  FROM metadata.dashboards d
  WHERE d.is_default = TRUE
    AND d.is_public = TRUE
    AND metadata.dashboard_visible(d.id, d.is_public, d.created_by)
  LIMIT 1;

  RETURN v_dashboard_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, metadata;

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

-- ============================================================================
-- 6. set_dashboard_roles()
-- ============================================================================
-- SECURITY INVOKER: the dashboard_roles write policies are admin-only, and the explicit guard gives a clear error.

CREATE FUNCTION public.set_dashboard_roles(
  p_dashboard_id INT,
  p_role_keys TEXT[],
  p_mode TEXT DEFAULT 'show',
  p_priority INT DEFAULT 0
) RETURNS VOID AS $$
DECLARE
  v_key TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('show', 'default') THEN
    RAISE EXCEPTION 'Invalid mode %: use show or default', p_mode USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM metadata.dashboards WHERE id = p_dashboard_id) THEN
    RAISE EXCEPTION 'Dashboard % does not exist', p_dashboard_id USING ERRCODE = '22023';
  END IF;

  FOREACH v_key IN ARRAY COALESCE(p_role_keys, ARRAY[]::TEXT[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE role_key = v_key) THEN
      RAISE EXCEPTION 'Unknown role key: %', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Replace this dashboard's rows of this mode.
  DELETE FROM metadata.dashboard_roles WHERE dashboard_id = p_dashboard_id AND mode = p_mode;

  IF COALESCE(array_length(p_role_keys, 1), 0) = 0 THEN
    RETURN;
  END IF;

  IF p_mode = 'default' THEN
    -- A role has one default: move it here. A default also grants visibility, so it replaces a show row.
    DELETE FROM metadata.dashboard_roles dr
    USING metadata.roles r
    WHERE r.id = dr.role_id
      AND r.role_key = ANY(p_role_keys)
      AND (dr.mode = 'default' OR dr.dashboard_id = p_dashboard_id);

    INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode, priority)
    SELECT p_dashboard_id, r.id, 'default', p_priority
    FROM metadata.roles r
    WHERE r.role_key = ANY(p_role_keys);
  ELSE
    -- A role whose default is this dashboard already sees it: skip.
    INSERT INTO metadata.dashboard_roles (dashboard_id, role_id, mode, priority)
    SELECT p_dashboard_id, r.id, 'show', 0
    FROM metadata.roles r
    WHERE r.role_key = ANY(p_role_keys)
    ON CONFLICT (dashboard_id, role_id) DO NOTHING;
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = public, metadata;

REVOKE EXECUTE ON FUNCTION public.set_dashboard_roles(INT, TEXT[], TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_dashboard_roles(INT, TEXT[], TEXT, INT) TO authenticated;

COMMENT ON FUNCTION public.set_dashboard_roles(INT, TEXT[], TEXT, INT) IS
  'Admin only. Replaces a dashboard''s role rows of one mode: show restricts it to the listed roles, default makes it their landing dashboard (priority orders a user''s several roles). NULL or an empty array clears that mode.';

-- ============================================================================
-- 7. Dashboard page error strings (ui translations, six core locales)
-- ============================================================================

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.error.not_found', 'en', 'Dashboard not found'),
('ui', 'dashboard.error.not_found', 'es', 'Tablero no encontrado'),
('ui', 'dashboard.error.not_found', 'ar', 'لوحة المعلومات غير موجودة'),
('ui', 'dashboard.error.not_found', 'fr', 'Tableau de bord introuvable'),
('ui', 'dashboard.error.not_found', 'de', 'Dashboard nicht gefunden'),
('ui', 'dashboard.error.not_found', 'ps', 'ډشبورډ ونه موندل شو'),
('ui', 'dashboard.error.load_failed', 'en', 'Failed to load dashboard'),
('ui', 'dashboard.error.load_failed', 'es', 'Error al cargar el tablero'),
('ui', 'dashboard.error.load_failed', 'ar', 'فشل تحميل لوحة المعلومات'),
('ui', 'dashboard.error.load_failed', 'fr', 'Échec du chargement du tableau de bord'),
('ui', 'dashboard.error.load_failed', 'de', 'Dashboard konnte nicht geladen werden'),
('ui', 'dashboard.error.load_failed', 'ps', 'ډشبورډ پورته کول ناکام شو'),
('ui', 'dashboard.error.load_default_failed', 'en', 'Failed to load default dashboard'),
('ui', 'dashboard.error.load_default_failed', 'es', 'Error al cargar el tablero predeterminado'),
('ui', 'dashboard.error.load_default_failed', 'ar', 'فشل تحميل لوحة المعلومات الافتراضية'),
('ui', 'dashboard.error.load_default_failed', 'fr', 'Échec du chargement du tableau de bord par défaut'),
('ui', 'dashboard.error.load_default_failed', 'de', 'Standard-Dashboard konnte nicht geladen werden'),
('ui', 'dashboard.error.load_default_failed', 'ps', 'اصلي ډشبورډ پورته کول ناکام شو'),
('ui', 'dashboard.error.no_default', 'en', 'No default dashboard found. Please contact an administrator.'),
('ui', 'dashboard.error.no_default', 'es', 'No se encontró un tablero predeterminado. Comuníquese con un administrador.'),
('ui', 'dashboard.error.no_default', 'ar', 'لم يتم العثور على لوحة معلومات افتراضية. يرجى الاتصال بالمسؤول.'),
('ui', 'dashboard.error.no_default', 'fr', 'Aucun tableau de bord par défaut trouvé. Veuillez contacter un administrateur.'),
('ui', 'dashboard.error.no_default', 'de', 'Kein Standard-Dashboard gefunden. Bitte wenden Sie sich an einen Administrator.'),
('ui', 'dashboard.error.no_default', 'ps', 'اصلي ډشبورډ ونه موندل شو. مهرباني وکړئ له یو اډمین سره اړیکه ونیسئ.'),
('ui', 'dashboard.error.title', 'en', 'Failed to Load Dashboard'),
('ui', 'dashboard.error.title', 'es', 'Error al cargar el tablero'),
('ui', 'dashboard.error.title', 'ar', 'فشل تحميل لوحة المعلومات'),
('ui', 'dashboard.error.title', 'fr', 'Échec du chargement du tableau de bord'),
('ui', 'dashboard.error.title', 'de', 'Dashboard konnte nicht geladen werden'),
('ui', 'dashboard.error.title', 'ps', 'ډشبورډ پورته کول ناکام شو')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
