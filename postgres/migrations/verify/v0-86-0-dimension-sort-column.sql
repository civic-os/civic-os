-- Verify civic_os:v0-86-0-dimension-sort-column on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT sort_column FROM metadata.dimensions WHERE FALSE;
SELECT sort_column FROM public.schema_dimensions WHERE FALSE;
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.schema_dimensions'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- the setter is a guarded definer, closed to web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.set_dimension_sort_column(text,name)'::regprocedure AND prosecdef AND prosrc LIKE '%metadata._is_db_admin()%';
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.set_dimension_sort_column(text,name)', 'EXECUTE') THEN 0 ELSE 1 END);

-- register_dimension keeps its v0.85.0 signature, once
SELECT 1 / (CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END) FROM pg_proc
WHERE oid = 'public.register_dimension(text,text,name,name,name,name,name,name,name,bigint,boolean,integer)'::regprocedure;
SELECT 1 / (CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END) FROM pg_proc
WHERE proname = 'register_dimension' AND pronamespace = 'public'::regnamespace;

-- compare_interface accepts the sort role
SELECT 1 / (CASE WHEN EXISTS (
  SELECT 1 FROM public.compare_interface('{"elements":[{"element":"dimension","key":"__verify_none","columns":{"sort":"sort_order"}}]}')
  WHERE difference = 'missing_dimension') THEN 1 ELSE 0 END);

ROLLBACK;
