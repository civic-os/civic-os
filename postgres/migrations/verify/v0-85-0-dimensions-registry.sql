-- Verify civic_os:v0-85-0-dimensions-registry on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later

BEGIN;

SELECT dimension_key, display_name, table_schema, table_name, key_column, label_column, parent_column,
       active_column, external_id_column, default_value_id, hide_when_single, sort_order
FROM metadata.dimensions WHERE FALSE;
SELECT 1 / COUNT(*) FROM pg_class WHERE oid = 'metadata.dimensions'::regclass AND relrowsecurity;
SELECT 1 / (CASE WHEN has_table_privilege('authenticated', 'metadata.dimensions', 'INSERT,UPDATE,DELETE') THEN 0 ELSE 1 END);

-- the client view is invoker
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.schema_dimensions'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- the DDL-generating and writing RPCs are guarded definers, closed to web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.register_dimension(text,text,name,name,name,name,name,name,name,bigint,boolean,integer)'::regprocedure
  AND prosecdef AND proconfig IS NOT NULL AND prosrc LIKE '%metadata._is_db_admin()%' AND prosrc LIKE '%metadata._is_deployer()%';
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.set_dimension_default(text,bigint)'::regprocedure AND prosecdef AND prosrc LIKE '%metadata._is_db_admin()%';
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.register_dimension(text,text,name,name,name,name,name,name,name,bigint,boolean,integer)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.set_dimension_default(text,bigint)', 'EXECUTE') THEN 0 ELSE 1 END);

-- dimension_subtree runs as the caller
SELECT 1 / COUNT(*) FROM pg_proc WHERE oid = 'public.dimension_subtree(text,bigint)'::regprocedure AND NOT prosecdef;

SELECT 1 / COUNT(*) FROM metadata.constraint_messages WHERE constraint_name = 'dimension_row_delete';

ROLLBACK;
