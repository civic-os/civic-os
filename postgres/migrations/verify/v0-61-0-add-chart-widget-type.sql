-- Verify civic_os:v0-61-0-add-chart-widget-type on pg

BEGIN;

-- Verify chart widget type exists
SELECT widget_type, display_name, description, icon_name, is_active
FROM metadata.widget_types
WHERE widget_type = 'chart';

-- Rollback verification transaction
ROLLBACK;
