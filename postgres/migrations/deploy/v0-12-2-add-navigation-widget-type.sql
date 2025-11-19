-- Deploy v0-12-2-add-navigation-widget-type
-- Add dashboard_navigation widget type for sequential navigation

BEGIN;

-- Add navigation widget type
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'dashboard_navigation',
  'Navigation',
  'Sequential navigation with prev/next buttons and progress chips for storymap-style dashboards',
  'navigation',
  TRUE
)
ON CONFLICT (widget_type) DO NOTHING;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
