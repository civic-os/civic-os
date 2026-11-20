-- Verify civic_os:v0-83-0-menu-dashboard-nodes
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- the column, its foreign key and one node per dashboard
SELECT 1 / COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'menu_nodes' AND column_name = 'dashboard_id' AND data_type = 'integer';
SELECT 1 / COUNT(*) FROM pg_constraint
WHERE conrelid = 'metadata.menu_nodes'::regclass AND contype = 'f' AND confrelid = 'metadata.dashboards'::regclass;
SELECT 1 / COUNT(*) FROM pg_constraint
WHERE conrelid = 'metadata.menu_nodes'::regclass AND conname = 'menu_nodes_dashboard_unique' AND contype = 'u';

-- the kind and the dashboard node rules
SELECT 1 / COUNT(*) FROM pg_constraint
WHERE conrelid = 'metadata.menu_nodes'::regclass AND conname = 'menu_nodes_node_kind_check'
  AND pg_get_constraintdef(oid) LIKE '%dashboard%';
SELECT 1 / (CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END) FROM pg_constraint
WHERE conrelid = 'metadata.menu_nodes'::regclass AND conname IN ('menu_nodes_dashboard_check', 'menu_nodes_entity_dashboard_check');

-- the view returns the new columns and stays invoker
SELECT dashboard_id, dashboard_display_name FROM public.schema_menu_nodes WHERE FALSE;
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.schema_menu_nodes'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- the dashboard triggers, and their definer functions are not callable by API roles
SELECT 1 / COUNT(*) FROM pg_trigger WHERE tgrelid = 'metadata.dashboards'::regclass AND tgname = 'menu_dashboard_deleted';
SELECT 1 / COUNT(*) FROM pg_trigger WHERE tgrelid = 'metadata.dashboards'::regclass AND tgname = 'menu_dashboard_stamp_version';
SELECT 1 / COUNT(*) FROM pg_trigger WHERE tgrelid = 'metadata.dashboard_roles'::regclass AND tgname = 'menu_dashboard_stamp_version';
SELECT 1 / (CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'metadata' AND p.proname IN ('menu_dashboard_deleted', 'menu_dashboard_stamp_version') AND p.prosecdef;
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata.menu_dashboard_stamp_version()', 'EXECUTE')
                   OR has_function_privilege('web_anon', 'metadata.menu_dashboard_deleted()', 'EXECUTE') THEN 0 ELSE 1 END);

ROLLBACK;
