-- Verify civic_os:v0-12-0-add-map-widget-type on pg

BEGIN;

-- Verify map widget type exists
SELECT widget_type, display_name, description, icon_name, is_active
FROM metadata.widget_types
WHERE widget_type = 'map';

-- Rollback verification transaction
ROLLBACK;
