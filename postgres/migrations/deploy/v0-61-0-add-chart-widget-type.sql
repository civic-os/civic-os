-- Deploy civic_os:v0-61-0-add-chart-widget-type to pg

BEGIN;

-- ============================================================================
-- DASHBOARD: CHART WIDGET TYPE
-- ============================================================================
-- Version: v0.61.0
-- Purpose: Add 'chart' widget type for grouped bar chart visualization
-- Context: Renders pre-aggregated data from PostgreSQL VIEWs using Unovis.
--          Aggregation lives in SQL; the widget is presentation-only.
-- ============================================================================

-- Add chart widget type to registry
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'chart',
  'Chart',
  'Grouped bar chart that visualizes pre-aggregated data from PostgreSQL VIEWs. Supports single and multi-series bars with DaisyUI theme-aware colors.',
  'bar_chart',
  TRUE
)
ON CONFLICT (widget_type) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  icon_name = EXCLUDED.icon_name,
  is_active = EXCLUDED.is_active;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
