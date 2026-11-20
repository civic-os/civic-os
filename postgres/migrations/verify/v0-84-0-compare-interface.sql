-- Verify civic_os:v0-84-0-compare-interface on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

-- invoker functions, for authenticated but not PUBLIC or web_anon
SELECT 1 / COUNT(*) FROM pg_proc WHERE oid = 'public.compare_interface(jsonb)'::regprocedure AND NOT prosecdef;
SELECT 1 / COUNT(*) FROM pg_proc WHERE oid = 'public.assert_interface(jsonb)'::regprocedure AND NOT prosecdef;
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.compare_interface(jsonb)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.compare_interface(jsonb)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.assert_interface(jsonb)', 'EXECUTE') THEN 0 ELSE 1 END);

-- a matching declaration returns no rows; a missing table returns one error row
SELECT 1 / (CASE WHEN NOT EXISTS (
  SELECT 1 FROM public.compare_interface('{"elements":[{"element":"table","name":"metadata.domain_version","columns":[{"name":"domain_version","type":"text","nullable":false}]}]}')
) THEN 1 ELSE 0 END);
SELECT 1 / COUNT(*) FROM public.compare_interface('{"elements":[{"element":"table","name":"public.no_such_table_v0840"}]}')
WHERE difference = 'missing_table' AND severity = 'error';

ROLLBACK;
