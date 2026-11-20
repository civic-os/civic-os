-- Verify civic_os:v0-85-0-module-registry on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT module_key, display_name, version, installed_at, updated_at FROM metadata.modules WHERE FALSE;
SELECT 1 / COUNT(*) FROM pg_class WHERE oid = 'metadata.modules'::regclass AND relrowsecurity;
SELECT 1 / (CASE WHEN has_table_privilege('authenticated', 'metadata.modules', 'INSERT,UPDATE,DELETE') THEN 0 ELSE 1 END);

-- register_module: definer with pinned search_path, guarded, closed to PUBLIC and web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.register_module(text,text,text)'::regprocedure
  AND prosecdef AND proconfig IS NOT NULL AND prosrc LIKE '%metadata._is_db_admin()%';
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.register_module(text,text,text)', 'EXECUTE') THEN 0 ELSE 1 END);

-- module_installed: any role
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.module_installed(text)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN public.module_installed('__verify_no_such_module') THEN 0 ELSE 1 END);

-- _is_deployer: not executable by API roles
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata._is_deployer()', 'EXECUTE') THEN 0 ELSE 1 END);

ROLLBACK;
