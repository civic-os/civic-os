-- Verify civic_os:v0-86-1-module-interface on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT interface FROM metadata.modules WHERE FALSE;

-- both forms, guarded definers, closed to web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.register_module(text,text,text,jsonb)'::regprocedure
  AND prosecdef AND prosrc LIKE '%metadata._is_db_admin()%' AND prosrc LIKE '%compare_interface(p_interface)%';
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.register_module(text,text,text)'::regprocedure
  AND prosecdef AND prosrc LIKE '%register_module(p_module_key, p_display_name, p_version, NULL::jsonb)%';
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.register_module(text,text,text,jsonb)', 'EXECUTE') THEN 0 ELSE 1 END);

ROLLBACK;
