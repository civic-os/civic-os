-- Revert v0-12-2-add-navigation-widget-type

BEGIN;

DELETE FROM metadata.widget_types WHERE widget_type = 'dashboard_navigation';

COMMIT;
