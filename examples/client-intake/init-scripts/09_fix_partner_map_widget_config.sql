-- =====================================================
-- Fix Partner Locations map widget config keys
-- =====================================================
-- The map widget was configured with incorrect JSONB keys
-- (geoColumn, labelColumn, center, zoom) that don't match
-- the MapWidgetConfig interface the Angular component reads
-- (mapPropertyName, enableClustering, etc.).
--
-- Result: cfg.mapPropertyName was undefined, the queryParams
-- guard returned null, and no PostgREST request was ever made.

BEGIN;

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
      'mapPropertyName', 'location',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'active', 'operator', 'eq', 'value', true)
      ),
      'enableClustering', true
    ),
    updated_at = NOW()
WHERE widget_type = 'map'
  AND entity_key = 'partners'
  AND title = 'Partner Locations';

COMMIT;
