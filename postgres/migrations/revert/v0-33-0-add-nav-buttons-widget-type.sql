-- Revert civic_os:v0-33-0-add-nav-buttons-widget-type from pg

BEGIN;

-- Remove nav_buttons widget type
DELETE FROM metadata.widget_types WHERE widget_type = 'nav_buttons';

COMMIT;
