-- Revert civic_os:v0-12-0-add-map-widget-type from pg

BEGIN;

-- Remove map widget type
DELETE FROM metadata.widget_types WHERE widget_type = 'map';

COMMIT;
