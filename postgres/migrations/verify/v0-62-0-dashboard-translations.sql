-- Verify civic_os:v0-62-0-dashboard-translations on pg

BEGIN;

-- Verify translate_widget_config() function exists
SELECT pg_catalog.has_function_privilege(
  'metadata.translate_widget_config(text, integer, integer, jsonb)',
  'execute'
);

-- Verify get_dashboards() exists and returns expected columns
SELECT id, display_name, description, is_default, is_public,
       show_title, sort_order, created_by, created_at, updated_at,
       is_role_default
FROM public.get_dashboards()
LIMIT 0;

-- Verify get_dashboard() exists
SELECT pg_catalog.has_function_privilege(
  'public.get_dashboard(integer)',
  'execute'
);

-- Rollback verification transaction
ROLLBACK;
