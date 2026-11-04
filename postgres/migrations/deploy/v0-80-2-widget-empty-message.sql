-- Deploy civic_os:v0-80-2-widget-empty-message
-- Requires: v0-80-2-instance-config-label-i18n
--
-- v0.80.2 -- Translatable empty state for filtered_list dashboard widgets (issue #54) and the framework
-- strings the widgets show.
--   1. metadata.translate_widget_config() gains a filtered_list branch that translates config.emptyMessage
--      (source_type widget_config, key dashboard.{dashboard_id}.widget.{widget_id}.emptyMessage). It was
--      sending filtered_list to its ELSE NULL branch. The signature is unchanged, so CREATE OR REPLACE
--      keeps the existing grants.
--   2. Seeds the widget empty, error and "See more" strings for the six core locales (en for
--      get_translation_defaults()). ON CONFLICT DO NOTHING keeps text an integrator already added.

BEGIN;

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

    WHEN 'filtered_list' THEN
      -- emptyMessage: the integrator's text for an empty list. Guarded on a string so a JSON null leaves
      -- the config alone (jsonb_set with a SQL NULL value would null the whole config).
      IF jsonb_typeof(v_result -> 'emptyMessage') = 'string' THEN
        v_result := jsonb_set(v_result, '{emptyMessage}',
          to_jsonb(metadata.t('widget_config', v_key_prefix || '.emptyMessage',
            v_result->>'emptyMessage')));
      END IF;

    ELSE
      -- Other widget types (map, calendar, chart): no translatable config text
      NULL;
  END CASE;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION metadata.translate_widget_config(TEXT, INT, INT, JSONB) IS
  'Translates text fields in widget config JSONB based on widget type (markdown, nav_buttons, dashboard_navigation, filtered_list). Uses metadata.t() with source_type=widget_config.';

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
('ui', 'dashboard.empty_default', 'en', 'Nothing to show'),
('ui', 'dashboard.empty_default', 'es', 'Nada que mostrar'),
('ui', 'dashboard.empty_default', 'ar', 'لا يوجد شيء لعرضه'),
('ui', 'dashboard.empty_default', 'fr', 'Rien à afficher'),
('ui', 'dashboard.empty_default', 'de', 'Nichts anzuzeigen'),
('ui', 'dashboard.empty_default', 'ps', 'د ښودلو لپاره څه نشته'),
('ui', 'dashboard.results_one', 'en', 'Showing {{count}} result'),
('ui', 'dashboard.results_one', 'es', 'Mostrando {{count}} resultado'),
('ui', 'dashboard.results_one', 'ar', 'عرض {{count}} نتيجة'),
('ui', 'dashboard.results_one', 'fr', '{{count}} résultat affiché'),
('ui', 'dashboard.results_one', 'de', '{{count}} Ergebnis angezeigt'),
('ui', 'dashboard.results_one', 'ps', '{{count}} پایله ښودل کیږي'),
('ui', 'dashboard.results_other', 'en', 'Showing {{count}} results'),
('ui', 'dashboard.results_other', 'es', 'Mostrando {{count}} resultados'),
('ui', 'dashboard.results_other', 'ar', 'عرض {{count}} نتائج'),
('ui', 'dashboard.results_other', 'fr', '{{count}} résultats affichés'),
('ui', 'dashboard.results_other', 'de', '{{count}} Ergebnisse angezeigt'),
('ui', 'dashboard.results_other', 'ps', '{{count}} پایلې ښودل کیږي'),
('ui', 'dashboard.see_more', 'en', 'See more'),
('ui', 'dashboard.see_more', 'es', 'Ver más'),
('ui', 'dashboard.see_more', 'ar', 'المزيد'),
('ui', 'dashboard.see_more', 'fr', 'Voir plus'),
('ui', 'dashboard.see_more', 'de', 'Mehr anzeigen'),
('ui', 'dashboard.see_more', 'ps', 'نور وګورئ'),
('ui', 'a11y.see_more', 'en', 'See more: {{title}}'),
('ui', 'a11y.see_more', 'es', 'Ver más: {{title}}'),
('ui', 'a11y.see_more', 'ar', 'المزيد: {{title}}'),
('ui', 'a11y.see_more', 'fr', 'Voir plus : {{title}}'),
('ui', 'a11y.see_more', 'de', 'Mehr anzeigen: {{title}}'),
('ui', 'a11y.see_more', 'ps', 'نور وګورئ: {{title}}'),
('ui', 'dashboard.chart_empty', 'en', 'No data to display'),
('ui', 'dashboard.chart_empty', 'es', 'No hay datos para mostrar'),
('ui', 'dashboard.chart_empty', 'ar', 'لا توجد بيانات للعرض'),
('ui', 'dashboard.chart_empty', 'fr', 'Aucune donnée à afficher'),
('ui', 'dashboard.chart_empty', 'de', 'Keine Daten zum Anzeigen'),
('ui', 'dashboard.chart_empty', 'ps', 'د ښودلو لپاره معلومات نشته'),
('ui', 'dashboard.error_load_data', 'en', 'Failed to load data'),
('ui', 'dashboard.error_load_data', 'es', 'Error al cargar los datos'),
('ui', 'dashboard.error_load_data', 'ar', 'فشل تحميل البيانات'),
('ui', 'dashboard.error_load_data', 'fr', 'Échec du chargement des données'),
('ui', 'dashboard.error_load_data', 'de', 'Daten konnten nicht geladen werden'),
('ui', 'dashboard.error_load_data', 'ps', 'د معلوماتو پورته کول ناکام شول'),
('ui', 'dashboard.error_load_schema', 'en', 'Failed to load schema'),
('ui', 'dashboard.error_load_schema', 'es', 'Error al cargar el esquema'),
('ui', 'dashboard.error_load_schema', 'ar', 'فشل تحميل المخطط'),
('ui', 'dashboard.error_load_schema', 'fr', 'Échec du chargement du schéma'),
('ui', 'dashboard.error_load_schema', 'de', 'Schema konnte nicht geladen werden'),
('ui', 'dashboard.error_load_schema', 'ps', 'د سکیما پورته کول ناکام شول'),
('ui', 'dashboard.error_load_chart', 'en', 'Failed to load chart data'),
('ui', 'dashboard.error_load_chart', 'es', 'Error al cargar los datos del gráfico'),
('ui', 'dashboard.error_load_chart', 'ar', 'فشل تحميل بيانات المخطط'),
('ui', 'dashboard.error_load_chart', 'fr', 'Échec du chargement des données du graphique'),
('ui', 'dashboard.error_load_chart', 'de', 'Diagrammdaten konnten nicht geladen werden'),
('ui', 'dashboard.error_load_chart', 'ps', 'د چارټ د معلوماتو پورته کول ناکام شول'),
('ui', 'dashboard.error_load_calendar', 'en', 'Failed to load calendar events'),
('ui', 'dashboard.error_load_calendar', 'es', 'Error al cargar los eventos del calendario'),
('ui', 'dashboard.error_load_calendar', 'ar', 'فشل تحميل أحداث التقويم'),
('ui', 'dashboard.error_load_calendar', 'fr', 'Échec du chargement des événements du calendrier'),
('ui', 'dashboard.error_load_calendar', 'de', 'Kalenderereignisse konnten nicht geladen werden'),
('ui', 'dashboard.error_load_calendar', 'ps', 'د کیلنڈر د پیښو پورته کول ناکام شول'),
('ui', 'dashboard.error_load_map', 'en', 'Failed to load map data'),
('ui', 'dashboard.error_load_map', 'es', 'Error al cargar los datos del mapa'),
('ui', 'dashboard.error_load_map', 'ar', 'فشل تحميل بيانات الخريطة'),
('ui', 'dashboard.error_load_map', 'fr', 'Échec du chargement des données de la carte'),
('ui', 'dashboard.error_load_map', 'de', 'Kartendaten konnten nicht geladen werden'),
('ui', 'dashboard.error_load_map', 'ps', 'د نقشې د معلوماتو پورته کول ناکام شول'),
('ui', 'dashboard.error_load_asset', 'en', 'Failed to load asset: {{message}}'),
('ui', 'dashboard.error_load_asset', 'es', 'Error al cargar el recurso: {{message}}'),
('ui', 'dashboard.error_load_asset', 'ar', 'فشل تحميل الملف: {{message}}'),
('ui', 'dashboard.error_load_asset', 'fr', 'Échec du chargement de la ressource : {{message}}'),
('ui', 'dashboard.error_load_asset', 'de', 'Ressource konnte nicht geladen werden: {{message}}'),
('ui', 'dashboard.error_load_asset', 'ps', 'د شتمنۍ پورته کول ناکام شول: {{message}}'),
('ui', 'dashboard.error_asset_not_found', 'en', 'Static asset "{{slug}}" not found'),
('ui', 'dashboard.error_asset_not_found', 'es', 'No se encontró el recurso estático "{{slug}}"'),
('ui', 'dashboard.error_asset_not_found', 'ar', 'لم يتم العثور على الملف الثابت "{{slug}}"'),
('ui', 'dashboard.error_asset_not_found', 'fr', 'Ressource statique « {{slug}} » introuvable'),
('ui', 'dashboard.error_asset_not_found', 'de', 'Statische Ressource "{{slug}}" nicht gefunden'),
('ui', 'dashboard.error_asset_not_found', 'ps', 'جامد شتمني "{{slug}}" ونه موندل شو'),
('ui', 'dashboard.error_no_asset_slug', 'en', 'No static asset is configured'),
('ui', 'dashboard.error_no_asset_slug', 'es', 'No hay ningún recurso estático configurado'),
('ui', 'dashboard.error_no_asset_slug', 'ar', 'لم يتم تكوين أي ملف ثابت'),
('ui', 'dashboard.error_no_asset_slug', 'fr', 'Aucune ressource statique n''est configurée'),
('ui', 'dashboard.error_no_asset_slug', 'de', 'Es ist keine statische Ressource konfiguriert'),
('ui', 'dashboard.error_no_asset_slug', 'ps', 'هیڅ جامد شتمني نه ده تنظیم شوې'),
('ui', 'dashboard.error_calendar_config', 'en', 'Missing required configuration: entityKey or timeSlotPropertyName'),
('ui', 'dashboard.error_calendar_config', 'es', 'Falta la configuración requerida: entityKey o timeSlotPropertyName'),
('ui', 'dashboard.error_calendar_config', 'ar', 'الإعداد المطلوب مفقود: entityKey أو timeSlotPropertyName'),
('ui', 'dashboard.error_calendar_config', 'fr', 'Configuration requise manquante : entityKey ou timeSlotPropertyName'),
('ui', 'dashboard.error_calendar_config', 'de', 'Erforderliche Konfiguration fehlt: entityKey oder timeSlotPropertyName'),
('ui', 'dashboard.error_calendar_config', 'ps', 'اړینه تنظیمات نشته: entityKey یا timeSlotPropertyName')
ON CONFLICT (source_type, source_key, locale) DO NOTHING;

COMMIT;
