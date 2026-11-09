-- Revert civic_os:v0-81-3-widget-empty-message-translation-defaults
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- Restore the v0.81.1 body (no filtered_list emptyMessage branch).
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

  UNION ALL

  -- Menu node labels (headings, and entity nodes that override the entity name)
  SELECT 'menu_node'::TEXT, n.node_key || '.display_name', n.display_name
  FROM metadata.menu_nodes n
  WHERE n.display_name IS NOT NULL

  UNION ALL

  -- Instance config key labels (RLS on metadata.instance_config: anonymous callers see public keys only)
  SELECT 'instance_config'::TEXT, ic.config_key || '.display_name', ic.display_name
  FROM metadata.instance_config ic

  UNION ALL

  -- Instance config key descriptions
  SELECT 'instance_config'::TEXT, ic.config_key || '.description', ic.description
  FROM metadata.instance_config ic
  WHERE ic.description IS NOT NULL

  UNION ALL

  -- Instance config group labels
  SELECT 'instance_config_group'::TEXT, icg.group_key || '.display_name', icg.display_name
  FROM metadata.instance_config_groups icg

  UNION ALL

  -- Instance config group descriptions
  SELECT 'instance_config_group'::TEXT, icg.group_key || '.description', icg.description
  FROM metadata.instance_config_groups icg
  WHERE icg.description IS NOT NULL
  ;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION public.get_translation_defaults() IS
  'Returns English default text for all translatable keys. UI strings from metadata.translations, instance metadata from source tables. Used by Translation Admin page.';

GRANT EXECUTE ON FUNCTION public.get_translation_defaults() TO web_anon, authenticated;

COMMIT;
