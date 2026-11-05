-- Revert civic_os:v0-80-2-widget-empty-message
--
-- Restores the v0.62.0 body of metadata.translate_widget_config() (no filtered_list branch) and deletes only
-- the rows still holding the text this change seeded; an integrator's customized translation stays.

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

    ELSE
      -- Other widget types (filtered_list, map, calendar, chart): no translatable config text
      NULL;
  END CASE;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION metadata.translate_widget_config(TEXT, INT, INT, JSONB) IS
  'Translates text fields in widget config JSONB based on widget type. Uses metadata.t() with source_type=widget_config.';

DELETE FROM metadata.translations t
USING (VALUES
  ('dashboard.empty_default', 'en', 'Nothing to show'),
  ('dashboard.empty_default', 'es', 'Nada que mostrar'),
  ('dashboard.empty_default', 'ar', 'لا يوجد شيء لعرضه'),
  ('dashboard.empty_default', 'fr', 'Rien à afficher'),
  ('dashboard.empty_default', 'de', 'Nichts anzuzeigen'),
  ('dashboard.empty_default', 'ps', 'د ښودلو لپاره څه نشته'),
  ('dashboard.results_one', 'en', 'Showing {{count}} result'),
  ('dashboard.results_one', 'es', 'Mostrando {{count}} resultado'),
  ('dashboard.results_one', 'ar', 'عرض {{count}} نتيجة'),
  ('dashboard.results_one', 'fr', '{{count}} résultat affiché'),
  ('dashboard.results_one', 'de', '{{count}} Ergebnis angezeigt'),
  ('dashboard.results_one', 'ps', '{{count}} پایله ښودل کیږي'),
  ('dashboard.results_other', 'en', 'Showing {{count}} results'),
  ('dashboard.results_other', 'es', 'Mostrando {{count}} resultados'),
  ('dashboard.results_other', 'ar', 'عرض {{count}} نتائج'),
  ('dashboard.results_other', 'fr', '{{count}} résultats affichés'),
  ('dashboard.results_other', 'de', '{{count}} Ergebnisse angezeigt'),
  ('dashboard.results_other', 'ps', '{{count}} پایلې ښودل کیږي'),
  ('dashboard.see_more', 'en', 'See more'),
  ('dashboard.see_more', 'es', 'Ver más'),
  ('dashboard.see_more', 'ar', 'المزيد'),
  ('dashboard.see_more', 'fr', 'Voir plus'),
  ('dashboard.see_more', 'de', 'Mehr anzeigen'),
  ('dashboard.see_more', 'ps', 'نور وګورئ'),
  ('a11y.see_more', 'en', 'See more: {{title}}'),
  ('a11y.see_more', 'es', 'Ver más: {{title}}'),
  ('a11y.see_more', 'ar', 'المزيد: {{title}}'),
  ('a11y.see_more', 'fr', 'Voir plus : {{title}}'),
  ('a11y.see_more', 'de', 'Mehr anzeigen: {{title}}'),
  ('a11y.see_more', 'ps', 'نور وګورئ: {{title}}'),
  ('dashboard.chart_empty', 'en', 'No data to display'),
  ('dashboard.chart_empty', 'es', 'No hay datos para mostrar'),
  ('dashboard.chart_empty', 'ar', 'لا توجد بيانات للعرض'),
  ('dashboard.chart_empty', 'fr', 'Aucune donnée à afficher'),
  ('dashboard.chart_empty', 'de', 'Keine Daten zum Anzeigen'),
  ('dashboard.chart_empty', 'ps', 'د ښودلو لپاره معلومات نشته'),
  ('dashboard.error_load_data', 'en', 'Failed to load data'),
  ('dashboard.error_load_data', 'es', 'Error al cargar los datos'),
  ('dashboard.error_load_data', 'ar', 'فشل تحميل البيانات'),
  ('dashboard.error_load_data', 'fr', 'Échec du chargement des données'),
  ('dashboard.error_load_data', 'de', 'Daten konnten nicht geladen werden'),
  ('dashboard.error_load_data', 'ps', 'د معلوماتو پورته کول ناکام شول'),
  ('dashboard.error_load_schema', 'en', 'Failed to load schema'),
  ('dashboard.error_load_schema', 'es', 'Error al cargar el esquema'),
  ('dashboard.error_load_schema', 'ar', 'فشل تحميل المخطط'),
  ('dashboard.error_load_schema', 'fr', 'Échec du chargement du schéma'),
  ('dashboard.error_load_schema', 'de', 'Schema konnte nicht geladen werden'),
  ('dashboard.error_load_schema', 'ps', 'د سکیما پورته کول ناکام شول'),
  ('dashboard.error_load_chart', 'en', 'Failed to load chart data'),
  ('dashboard.error_load_chart', 'es', 'Error al cargar los datos del gráfico'),
  ('dashboard.error_load_chart', 'ar', 'فشل تحميل بيانات المخطط'),
  ('dashboard.error_load_chart', 'fr', 'Échec du chargement des données du graphique'),
  ('dashboard.error_load_chart', 'de', 'Diagrammdaten konnten nicht geladen werden'),
  ('dashboard.error_load_chart', 'ps', 'د چارټ د معلوماتو پورته کول ناکام شول'),
  ('dashboard.error_load_calendar', 'en', 'Failed to load calendar events'),
  ('dashboard.error_load_calendar', 'es', 'Error al cargar los eventos del calendario'),
  ('dashboard.error_load_calendar', 'ar', 'فشل تحميل أحداث التقويم'),
  ('dashboard.error_load_calendar', 'fr', 'Échec du chargement des événements du calendrier'),
  ('dashboard.error_load_calendar', 'de', 'Kalenderereignisse konnten nicht geladen werden'),
  ('dashboard.error_load_calendar', 'ps', 'د کیلنڈر د پیښو پورته کول ناکام شول'),
  ('dashboard.error_load_map', 'en', 'Failed to load map data'),
  ('dashboard.error_load_map', 'es', 'Error al cargar los datos del mapa'),
  ('dashboard.error_load_map', 'ar', 'فشل تحميل بيانات الخريطة'),
  ('dashboard.error_load_map', 'fr', 'Échec du chargement des données de la carte'),
  ('dashboard.error_load_map', 'de', 'Kartendaten konnten nicht geladen werden'),
  ('dashboard.error_load_map', 'ps', 'د نقشې د معلوماتو پورته کول ناکام شول'),
  ('dashboard.error_load_asset', 'en', 'Failed to load asset: {{message}}'),
  ('dashboard.error_load_asset', 'es', 'Error al cargar el recurso: {{message}}'),
  ('dashboard.error_load_asset', 'ar', 'فشل تحميل الملف: {{message}}'),
  ('dashboard.error_load_asset', 'fr', 'Échec du chargement de la ressource : {{message}}'),
  ('dashboard.error_load_asset', 'de', 'Ressource konnte nicht geladen werden: {{message}}'),
  ('dashboard.error_load_asset', 'ps', 'د شتمنۍ پورته کول ناکام شول: {{message}}'),
  ('dashboard.error_asset_not_found', 'en', 'Static asset "{{slug}}" not found'),
  ('dashboard.error_asset_not_found', 'es', 'No se encontró el recurso estático "{{slug}}"'),
  ('dashboard.error_asset_not_found', 'ar', 'لم يتم العثور على الملف الثابت "{{slug}}"'),
  ('dashboard.error_asset_not_found', 'fr', 'Ressource statique « {{slug}} » introuvable'),
  ('dashboard.error_asset_not_found', 'de', 'Statische Ressource "{{slug}}" nicht gefunden'),
  ('dashboard.error_asset_not_found', 'ps', 'جامد شتمني "{{slug}}" ونه موندل شو'),
  ('dashboard.error_no_asset_slug', 'en', 'No static asset is configured'),
  ('dashboard.error_no_asset_slug', 'es', 'No hay ningún recurso estático configurado'),
  ('dashboard.error_no_asset_slug', 'ar', 'لم يتم تكوين أي ملف ثابت'),
  ('dashboard.error_no_asset_slug', 'fr', 'Aucune ressource statique n''est configurée'),
  ('dashboard.error_no_asset_slug', 'de', 'Es ist keine statische Ressource konfiguriert'),
  ('dashboard.error_no_asset_slug', 'ps', 'هیڅ جامد شتمني نه ده تنظیم شوې'),
  ('dashboard.error_calendar_config', 'en', 'Missing required configuration: entityKey or timeSlotPropertyName'),
  ('dashboard.error_calendar_config', 'es', 'Falta la configuración requerida: entityKey o timeSlotPropertyName'),
  ('dashboard.error_calendar_config', 'ar', 'الإعداد المطلوب مفقود: entityKey أو timeSlotPropertyName'),
  ('dashboard.error_calendar_config', 'fr', 'Configuration requise manquante : entityKey ou timeSlotPropertyName'),
  ('dashboard.error_calendar_config', 'de', 'Erforderliche Konfiguration fehlt: entityKey oder timeSlotPropertyName'),
  ('dashboard.error_calendar_config', 'ps', 'اړینه تنظیمات نشته: entityKey یا timeSlotPropertyName')
) AS seeded(source_key, locale, translated_text)
WHERE t.source_type = 'ui'
  AND t.source_key = seeded.source_key
  AND t.locale = seeded.locale
  AND t.translated_text = seeded.translated_text;

COMMIT;
