-- Verify civic_os:v0-85-0-tree-parent-guard on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- the trigger function is a definer with a pinned search_path
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'metadata.tree_parent_guard()'::regprocedure AND prosecdef AND proconfig IS NOT NULL;

-- enable_tree_parent_guard: guarded definer, for authenticated, not web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.enable_tree_parent_guard(name,name,name)'::regprocedure
  AND prosecdef AND prosrc LIKE '%metadata._is_db_admin()%';
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.enable_tree_parent_guard(name,name,name)', 'EXECUTE') THEN 0 ELSE 1 END);

-- the internal helpers are not executable by API roles
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata._install_tree_parent_guard(regclass,name,name)', 'EXECUTE') THEN 0 ELSE 1 END);

-- the constraint message exists and the view translates it
SELECT 1 / COUNT(*) FROM metadata.constraint_messages WHERE constraint_name = 'tree_parent_cycle';
SELECT 1 / COUNT(*) FROM pg_views
WHERE schemaname = 'public' AND viewname = 'constraint_messages' AND definition LIKE '%t(''constraint_message''%';

ROLLBACK;
