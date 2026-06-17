-- Deploy civic_os:v0-62-0-dashboard-translations
-- Requires: v0-58-0-metadata-translations
--
-- Phase 3 i18n: Translate dashboard RPC output and widget config JSONB.

BEGIN;

-- ============================================================================
-- 1. CREATE metadata.translate_widget_config() HELPER
-- ============================================================================
-- Translates translatable text fields inside widget config JSONB based on
-- widget type. Only three widget types have translatable text in config:
--   markdown: content
--   nav_buttons: header, description, buttons[].text
--   dashboard_navigation: backward.text, forward.text, chips[].text
--
-- Source key convention: dashboard.{dashboard_id}.widget.{widget_id}.{path}

CREATE OR REPLACE FUNCTION metadata.translate_widget_config(
  p_widget_type TEXT,
  p_dashboard_id INT,
  p_widget_id INT,
  p_config JSONB
) RETURNS JSONB AS $$
DECLARE
  v_locale TEXT;
  v_key_prefix TEXT;
  v_result JSONB;
  v_buttons JSONB;
  v_chips JSONB;
  v_i INT;
BEGIN
  v_locale := metadata.current_locale();

  -- Short-circuit for English (zero overhead)
  IF v_locale = 'en' OR v_locale IS NULL THEN
    RETURN p_config;
  END IF;

  -- Null config returns null
  IF p_config IS NULL THEN
    RETURN NULL;
  END IF;

  v_key_prefix := 'dashboard.' || p_dashboard_id || '.widget.' || p_widget_id;
  v_result := p_config;

  CASE p_widget_type
    WHEN 'markdown' THEN
      IF v_result ? 'content' THEN
        v_result := jsonb_set(v_result, '{content}',
          to_jsonb(metadata.t('widget_config', v_key_prefix || '.content',
            v_result->>'content')));
      END IF;

    WHEN 'nav_buttons' THEN
      -- header and description
      IF v_result ? 'header' THEN
        v_result := jsonb_set(v_result, '{header}',
          to_jsonb(metadata.t('widget_config', v_key_prefix || '.header',
            v_result->>'header')));
      END IF;
      IF v_result ? 'description' THEN
        v_result := jsonb_set(v_result, '{description}',
          to_jsonb(metadata.t('widget_config', v_key_prefix || '.description',
            v_result->>'description')));
      END IF;
      -- buttons[].text
      IF v_result ? 'buttons' AND jsonb_array_length(v_result->'buttons') > 0 THEN
        v_buttons := v_result->'buttons';
        FOR v_i IN 0..jsonb_array_length(v_buttons) - 1 LOOP
          IF v_buttons->v_i ? 'text' THEN
            v_buttons := jsonb_set(v_buttons, ARRAY[v_i::text, 'text'],
              to_jsonb(metadata.t('widget_config',
                v_key_prefix || '.buttons.' || v_i || '.text',
                v_buttons->v_i->>'text')));
          END IF;
        END LOOP;
        v_result := jsonb_set(v_result, '{buttons}', v_buttons);
      END IF;

    WHEN 'dashboard_navigation' THEN
      -- backward.text
      IF v_result #> '{backward,text}' IS NOT NULL THEN
        v_result := jsonb_set(v_result, '{backward,text}',
          to_jsonb(metadata.t('widget_config', v_key_prefix || '.backward.text',
            v_result #>> '{backward,text}')));
      END IF;
      -- forward.text
      IF v_result #> '{forward,text}' IS NOT NULL THEN
        v_result := jsonb_set(v_result, '{forward,text}',
          to_jsonb(metadata.t('widget_config', v_key_prefix || '.forward.text',
            v_result #>> '{forward,text}')));
      END IF;
      -- chips[].text
      IF v_result ? 'chips' AND jsonb_array_length(v_result->'chips') > 0 THEN
        v_chips := v_result->'chips';
        FOR v_i IN 0..jsonb_array_length(v_chips) - 1 LOOP
          IF v_chips->v_i ? 'text' THEN
            v_chips := jsonb_set(v_chips, ARRAY[v_i::text, 'text'],
              to_jsonb(metadata.t('widget_config',
                v_key_prefix || '.chips.' || v_i || '.text',
                v_chips->v_i->>'text')));
          END IF;
        END LOOP;
        v_result := jsonb_set(v_result, '{chips}', v_chips);
      END IF;

    ELSE
      -- Other widget types (filtered_list, map, calendar, chart): no translatable config text
      NULL;
  END CASE;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION metadata.translate_widget_config(TEXT, INT, INT, JSONB) IS
  'Translates text fields in widget config JSONB based on widget type. Uses metadata.t() with source_type=widget_config.';

-- ============================================================================
-- 2. RECREATE get_dashboard() WITH metadata.t() WRAPPING
-- ============================================================================
-- Wraps: dashboard display_name, description, widget title, widget config
-- Uses CREATE OR REPLACE since return type (JSON) is unchanged.

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

-- ============================================================================
-- 3. RECREATE get_dashboards() WITH metadata.t() WRAPPING
-- ============================================================================
-- Must DROP first because RETURNS TABLE defines column types.
-- Wraps: display_name, description

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

GRANT EXECUTE ON FUNCTION public.get_dashboards() TO web_anon, authenticated;

COMMENT ON FUNCTION public.get_dashboards() IS
  'Returns all dashboards visible to the current user (public + private). display_name and description are translated via metadata.t().';

-- ============================================================================
-- 4. CREATE get_translation_defaults() RPC
-- ============================================================================
-- Returns English default text for ALL translatable keys across the system.
-- UI strings come from metadata.translations (locale='en'), while instance
-- metadata defaults come from their source tables (entities, properties,
-- statuses, etc.). The frontend uses this for the Translation Admin page to
-- show the "English Default" column.
--
-- Key formats mirror exactly what metadata.t() receives in each VIEW/RPC.

CREATE OR REPLACE FUNCTION public.get_translation_defaults()
RETURNS TABLE(source_type TEXT, source_key TEXT, default_text TEXT)
AS $$
BEGIN
  -- Force English locale so VIEWs (schema_entities, schema_properties, statuses,
  -- categories) return untranslated default text via metadata.t() short-circuit.
  -- Uses request.headers JSON blob (PostgREST 13+ format) that current_locale() reads.
  -- This is transaction-local and does not affect other concurrent requests.
  PERFORM set_config('request.headers', '{"accept-language":"en"}', true);

  RETURN QUERY
  -- UI strings from translations table
  SELECT t.source_type::TEXT, t.source_key, t.translated_text
  FROM metadata.translations t
  WHERE t.locale = 'en'

  UNION ALL

  -- Entity display names (from VIEW to include auto-detected entities)
  SELECT 'entity'::TEXT, se.table_name || '.display_name', se.display_name
  FROM public.schema_entities se

  UNION ALL

  -- Entity descriptions
  SELECT 'entity'::TEXT, se.table_name || '.description', se.description
  FROM public.schema_entities se
  WHERE se.description IS NOT NULL

  UNION ALL

  -- Property display names (from VIEW to include auto-detected properties)
  SELECT 'property'::TEXT, sp.table_name || '.' || sp.column_name || '.display_name',
    sp.display_name
  FROM public.schema_properties sp

  UNION ALL

  -- Property descriptions
  SELECT 'property'::TEXT, sp.table_name || '.' || sp.column_name || '.description',
    sp.description
  FROM public.schema_properties sp
  WHERE sp.description IS NOT NULL

  UNION ALL

  -- Status display names (from VIEW for translated defaults)
  SELECT 'status'::TEXT, s.entity_type || '.' || s.status_key || '.display_name',
    s.display_name
  FROM public.statuses s

  UNION ALL

  -- Status descriptions
  SELECT 'status'::TEXT, s.entity_type || '.' || s.status_key || '.description',
    s.description
  FROM public.statuses s
  WHERE s.description IS NOT NULL

  UNION ALL

  -- Category display names (from VIEW for translated defaults)
  SELECT 'category'::TEXT, c.entity_type || '.' || c.category_key || '.display_name',
    c.display_name
  FROM public.categories c

  UNION ALL

  -- Category descriptions
  SELECT 'category'::TEXT, c.entity_type || '.' || c.category_key || '.description',
    c.description
  FROM public.categories c
  WHERE c.description IS NOT NULL

  UNION ALL

  -- Entity action display names
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.display_name',
    ea.display_name
  FROM metadata.entity_actions ea

  UNION ALL

  -- Entity action descriptions
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.description',
    ea.description
  FROM metadata.entity_actions ea
  WHERE ea.description IS NOT NULL

  UNION ALL

  -- Entity action confirmation messages
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.confirmation_message',
    ea.confirmation_message
  FROM metadata.entity_actions ea
  WHERE ea.confirmation_message IS NOT NULL

  UNION ALL

  -- Entity action disabled tooltips
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.disabled_tooltip',
    ea.disabled_tooltip
  FROM metadata.entity_actions ea
  WHERE ea.disabled_tooltip IS NOT NULL

  UNION ALL

  -- Entity action success messages
  SELECT 'action'::TEXT, ea.table_name::TEXT || '.' || ea.action_name || '.success_message',
    ea.default_success_message
  FROM metadata.entity_actions ea
  WHERE ea.default_success_message IS NOT NULL

  UNION ALL

  -- Action param display names (JOIN to resolve table_name + action_name)
  SELECT 'action_param'::TEXT,
    ea.table_name::TEXT || '.' || ea.action_name || '.' || p.param_name || '.display_name',
    p.display_name
  FROM metadata.entity_action_params p
  JOIN metadata.entity_actions ea ON ea.id = p.entity_action_id

  UNION ALL

  -- Action param placeholders
  SELECT 'action_param'::TEXT,
    ea.table_name::TEXT || '.' || ea.action_name || '.' || p.param_name || '.placeholder',
    p.placeholder
  FROM metadata.entity_action_params p
  JOIN metadata.entity_actions ea ON ea.id = p.entity_action_id
  WHERE p.placeholder IS NOT NULL

  UNION ALL

  -- Guided form step display names
  SELECT 'guided_form_step'::TEXT,
    gfs.guided_form_key::TEXT || '.' || gfs.step_key::TEXT || '.display_name',
    gfs.display_name
  FROM metadata.guided_form_steps gfs

  UNION ALL

  -- Guided form step descriptions
  SELECT 'guided_form_step'::TEXT,
    gfs.guided_form_key::TEXT || '.' || gfs.step_key::TEXT || '.description',
    gfs.description
  FROM metadata.guided_form_steps gfs
  WHERE gfs.description IS NOT NULL

  UNION ALL

  -- Static text content
  SELECT 'static_text'::TEXT, st.table_name::TEXT || '.' || st.id::TEXT, st.content
  FROM metadata.static_text st

  UNION ALL

  -- Dashboard display names
  SELECT 'dashboard'::TEXT, 'dashboard.' || d.id::TEXT || '.display_name',
    d.display_name::TEXT
  FROM metadata.dashboards d

  UNION ALL

  -- Dashboard descriptions
  SELECT 'dashboard'::TEXT, 'dashboard.' || d.id::TEXT || '.description',
    d.description
  FROM metadata.dashboards d
  WHERE d.description IS NOT NULL

  UNION ALL

  -- Dashboard widget titles
  SELECT 'dashboard'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.title',
    w.title
  FROM metadata.dashboard_widgets w
  WHERE w.title IS NOT NULL

  UNION ALL

  -- Widget config: markdown content
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.content',
    w.config->>'content'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'markdown' AND w.config ? 'content'

  UNION ALL

  -- Widget config: nav_buttons header
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.header',
    w.config->>'header'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'nav_buttons' AND w.config ? 'header'

  UNION ALL

  -- Widget config: nav_buttons description
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.description',
    w.config->>'description'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'nav_buttons' AND w.config ? 'description'

  UNION ALL

  -- Widget config: nav_buttons button text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.buttons.' || (idx - 1)::TEXT || '.text',
    btn->>'text'
  FROM metadata.dashboard_widgets w,
    jsonb_array_elements(w.config->'buttons') WITH ORDINALITY AS t(btn, idx)
  WHERE w.widget_type = 'nav_buttons' AND w.config ? 'buttons' AND btn ? 'text'

  UNION ALL

  -- Widget config: dashboard_navigation backward text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.backward.text',
    w.config #>> '{backward,text}'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'dashboard_navigation' AND w.config #> '{backward,text}' IS NOT NULL

  UNION ALL

  -- Widget config: dashboard_navigation forward text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.forward.text',
    w.config #>> '{forward,text}'
  FROM metadata.dashboard_widgets w
  WHERE w.widget_type = 'dashboard_navigation' AND w.config #> '{forward,text}' IS NOT NULL

  UNION ALL

  -- Widget config: dashboard_navigation chips text
  SELECT 'widget_config'::TEXT,
    'dashboard.' || w.dashboard_id::TEXT || '.widget.' || w.id::TEXT || '.chips.' || (idx - 1)::TEXT || '.text',
    chip->>'text'
  FROM metadata.dashboard_widgets w,
    jsonb_array_elements(w.config->'chips') WITH ORDINALITY AS t(chip, idx)
  WHERE w.widget_type = 'dashboard_navigation' AND w.config ? 'chips' AND chip ? 'text'
  ;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION public.get_translation_defaults() IS
  'Returns English default text for all translatable keys. UI strings from metadata.translations, instance metadata from source tables. Used by Translation Admin page.';

GRANT EXECUTE ON FUNCTION public.get_translation_defaults() TO web_anon, authenticated;

-- ============================================================================
-- 5. UPDATE get_missing_translations() TO USE COMPREHENSIVE SOURCE
-- ============================================================================
-- Previously only found missing keys that had an English row in
-- metadata.translations. Now uses get_translation_defaults() to also
-- find metadata keys that were never added to the translations table.

CREATE OR REPLACE FUNCTION public.get_missing_translations(p_target_locale TEXT)
RETURNS TABLE(source_type TEXT, source_key TEXT, default_text TEXT)
AS $$
  SELECT d.source_type, d.source_key, d.default_text
  FROM public.get_translation_defaults() d
  WHERE d.default_text IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM metadata.translations t
      WHERE t.source_type::TEXT = d.source_type
        AND t.source_key = d.source_key
        AND t.locale = p_target_locale
    );
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- 6. SEED MISSING sidebar.translations UI TRANSLATIONS
-- ============================================================================
-- The sidebar.translations key was added in v0.62.0 but only to the bundled
-- en.translations.ts file. Seed both English and Spanish rows so the
-- Translations menu item translates properly.

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text)
VALUES
  ('ui', 'sidebar.translations', 'en', 'Translations'),
  ('ui', 'sidebar.translations', 'es', 'Traducciones'),
  ('ui', 'list.title_suffix', 'en', 'List'),
  ('ui', 'list.title_suffix', 'es', 'Lista')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

-- ============================================================================
-- 7. UPDATE STATUS/CATEGORY RPCs TO USE TRANSLATED VIEWs
-- ============================================================================
-- These RPCs previously queried raw metadata tables, bypassing the translated
-- public VIEWs. Now they query public.statuses / public.categories which wrap
-- display_name and description with metadata.t() for locale-aware output.

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
  SELECT id, display_name::VARCHAR(50), description, color, sort_order, is_initial, is_terminal, status_key
  FROM public.statuses
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

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
  SELECT id, display_name::VARCHAR(50), description, color, sort_order
  FROM public.categories
  WHERE entity_type = p_entity_type
  ORDER BY sort_order, display_name;
$$;

COMMIT;
