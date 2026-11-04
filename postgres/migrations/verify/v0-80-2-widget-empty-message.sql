-- Verify civic_os:v0-80-2-widget-empty-message

DO $$
DECLARE
  v_expected CONSTANT INT := 90;
  v_found INT;
BEGIN
  IF pg_get_functiondef('metadata.translate_widget_config(text,int,int,jsonb)'::regprocedure) NOT LIKE '%emptyMessage%' THEN
    RAISE EXCEPTION 'metadata.translate_widget_config() does not translate filtered_list emptyMessage';
  END IF;

  SELECT COUNT(*) INTO v_found
  FROM metadata.translations
  WHERE source_type = 'ui'
    AND source_key IN ('dashboard.empty_default', 'dashboard.results_one', 'dashboard.results_other', 'dashboard.see_more', 'a11y.see_more', 'dashboard.chart_empty', 'dashboard.error_load_data', 'dashboard.error_load_schema', 'dashboard.error_load_chart', 'dashboard.error_load_calendar', 'dashboard.error_load_map', 'dashboard.error_load_asset', 'dashboard.error_asset_not_found', 'dashboard.error_no_asset_slug', 'dashboard.error_calendar_config')
    AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps');
  IF v_found < v_expected THEN
    RAISE EXCEPTION 'Expected at least % widget UI translations, found %', v_expected, v_found;
  END IF;
END $$;
