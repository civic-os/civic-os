-- Verify civic_os:v0-33-0-add-nav-buttons-widget-type on pg

BEGIN;

-- Verify nav_buttons widget type exists
SELECT widget_type, display_name, description, icon_name, is_active
FROM metadata.widget_types
WHERE widget_type = 'nav_buttons';

-- Rollback verification transaction
ROLLBACK;
