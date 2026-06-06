-- Revert civic_os:v0-61-0-add-chart-widget-type from pg

BEGIN;

-- Remove chart widget type
DELETE FROM metadata.widget_types WHERE widget_type = 'chart';

COMMIT;
