-- Revert civic_os:v0-12-3-add-calendar-widget-type from pg

BEGIN;

-- Remove calendar widget type
DELETE FROM metadata.widget_types WHERE widget_type = 'calendar';

COMMIT;
