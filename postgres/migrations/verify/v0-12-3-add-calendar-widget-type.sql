-- Verify civic_os:v0-12-3-add-calendar-widget-type on pg

BEGIN;

-- Verify calendar widget type exists
SELECT widget_type, display_name, description, icon_name, is_active
FROM metadata.widget_types
WHERE widget_type = 'calendar';

-- Rollback verification transaction
ROLLBACK;
