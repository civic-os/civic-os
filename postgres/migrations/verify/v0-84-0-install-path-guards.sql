-- Verify civic_os:v0-84-0-install-path-guards on pg
--
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Holds right after this deploy and on the fully deployed database: checks that the objects exist with
-- their security properties and guards, not their exact bodies.

BEGIN;

-- both public functions now use the _is_db_admin() guard
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.set_domain_version(text,text,text,integer)'::regprocedure
  AND prosrc LIKE '%metadata._is_db_admin()%' AND prosecdef;
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.create_schema_decision(text,text,name[],name[],text,text,text,text,text,integer)'::regprocedure
  AND prosrc LIKE '%metadata._is_db_admin()%' AND prosecdef;

-- the internal writer exists and no API role can execute it
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'metadata._set_domain_version(text,text,text,integer)'::regprocedure AND NOT prosecdef;
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata._set_domain_version(text,text,text,integer)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'metadata._set_domain_version(text,text,text,integer)', 'EXECUTE') THEN 0 ELSE 1 END);

-- bump_domain_version is a definer with a pinned search_path, for authenticated but not PUBLIC or web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'public.bump_domain_version(text,text,integer,text)'::regprocedure AND prosecdef AND proconfig IS NOT NULL;
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.bump_domain_version(text,text,integer,text)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.bump_domain_version(text,text,integer,text)', 'EXECUTE') THEN 0 ELSE 1 END);

ROLLBACK;
