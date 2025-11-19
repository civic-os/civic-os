-- Verify v0-12-2-add-navigation-widget-type

BEGIN;

-- Check that the widget type exists
SELECT 1/COUNT(*) FROM metadata.widget_types WHERE widget_type = 'dashboard_navigation';

ROLLBACK;
