-- Verify civic_os:v0-81-2-menu-access
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Holds right after this deploy and on the fully deployed database: it checks that the objects exist and
-- keep their security properties, not their exact shape.

BEGIN;

-- the view filters through the base table policy
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.schema_menu_nodes'::regclass AND reloptions @> ARRAY['security_invoker=true'];
SELECT 1 / (CASE WHEN has_table_privilege('web_anon', 'public.schema_menu_nodes', 'SELECT')
                  AND has_table_privilege('authenticated', 'public.schema_menu_nodes', 'SELECT') THEN 1 ELSE 0 END);

-- the four policies
SELECT 1 / (CASE WHEN (SELECT COUNT(*) FROM pg_policies
                       WHERE schemaname = 'metadata' AND tablename = 'menu_nodes'
                         AND policyname IN ('menu_nodes_select', 'menu_nodes_insert', 'menu_nodes_update', 'menu_nodes_delete')) = 4
                 THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'metadata' AND tablename = 'menu_nodes'
                              AND cmd = 'SELECT' AND qual = 'true') THEN 0 ELSE 1 END);

-- authenticated writes through the policies; web_anon never writes
SELECT 1 / (CASE WHEN has_table_privilege('authenticated', 'metadata.menu_nodes', 'INSERT')
                  AND has_table_privilege('authenticated', 'metadata.menu_nodes', 'UPDATE')
                  AND has_table_privilege('authenticated', 'metadata.menu_nodes', 'DELETE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_table_privilege('web_anon', 'metadata.menu_nodes', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_table_privilege('authenticated', 'metadata.menu_nodes', 'TRUNCATE') THEN 0 ELSE 1 END);

-- the permission is mapped to admin
SELECT 1 / COUNT(*) FROM metadata.permissions p
JOIN metadata.permission_roles pr ON pr.permission_id = p.id
JOIN metadata.roles r ON r.id = pr.role_id
WHERE p.table_name = 'metadata.menu_nodes' AND p.permission = 'update' AND r.role_key = 'admin';

-- one save_menu_tree, invoker, with the expected-version parameter
SELECT 1 / (CASE WHEN to_regprocedure('public.save_menu_tree(jsonb)') IS NULL THEN 1 ELSE 0 END);
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.save_menu_tree(jsonb,timestamptz)'::regprocedure AND NOT prosecdef;
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.save_menu_tree(jsonb,timestamptz)', 'EXECUTE')
                  AND NOT has_function_privilege('web_anon', 'public.save_menu_tree(jsonb,timestamptz)', 'EXECUTE') THEN 1 ELSE 0 END);

-- the new functions exist, and PUBLIC executes none of them
SELECT 1 / (CASE WHEN EXISTS (
  SELECT 1 FROM unnest(ARRAY[
    'metadata.menu_target_eligible(name)', 'metadata.can_manage_menu()', 'metadata.can_read_full_menu()',
    'metadata.menu_visible_tree(text[])', 'public.save_menu_tree(jsonb,timestamptz)']) f
  WHERE to_regprocedure(f) IS NULL OR has_function_privilege('public', f, 'EXECUTE')) THEN 0 ELSE 1 END);

-- the trigger no longer reads schema_entities per row, and sees every row whoever writes
SELECT 1 / (CASE WHEN pg_get_functiondef('metadata.menu_nodes_validate()'::regprocedure) LIKE '%menu_target_eligible%'
                  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'metadata.menu_nodes_validate()'::regprocedure)
                 THEN 1 ELSE 0 END);

ROLLBACK;
