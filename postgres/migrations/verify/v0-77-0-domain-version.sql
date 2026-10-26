-- Verify civic_os:v0-77-0-domain-version on pg
--
-- Holds both right after this deploy and on the fully deployed database, so it checks that the objects
-- exist and keep their security properties, not their exact shape.

BEGIN;

-- the single row exists
SELECT 1 / COUNT(*) FROM metadata.domain_version WHERE id;

-- RLS on, with a select policy and no write grant for API roles
SELECT 1 / COUNT(*) FROM pg_class WHERE oid = 'metadata.domain_version'::regclass AND relrowsecurity;
SELECT 1 / COUNT(*) FROM pg_policy WHERE polrelid = 'metadata.domain_version'::regclass AND polcmd = 'r';
SELECT 1 / (CASE WHEN has_table_privilege('authenticated', 'metadata.domain_version', 'INSERT,UPDATE,DELETE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_table_privilege('web_anon', 'metadata.domain_version', 'SELECT') THEN 1 ELSE 0 END);

-- the FK column is indexed
SELECT 1 / COUNT(*) FROM pg_index WHERE indrelid = 'metadata.domain_version'::regclass AND indkey[0] =
  (SELECT attnum FROM pg_attribute WHERE attrelid = 'metadata.domain_version'::regclass AND attname = 'decision_id');

-- the decision link column exists
SELECT 1 / COUNT(*) FROM pg_attribute
WHERE attrelid = 'metadata.schema_decisions'::regclass AND attname = 'domain_version' AND NOT attisdropped;

-- the public view keeps security_invoker (a later CREATE OR REPLACE must repeat it)
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.schema_domain_version'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- the hash function is a definer with a pinned search_path, and PUBLIC cannot execute it
SELECT 1 / COUNT(*) FROM pg_proc
WHERE oid = 'metadata.schema_contract_hash()'::regprocedure AND prosecdef AND proconfig IS NOT NULL;
SELECT 1 / (CASE WHEN has_function_privilege('public', 'metadata.schema_contract_hash()', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN metadata.schema_contract_hash() ~ '^sha256:[0-9a-f]{64}$' THEN 1 ELSE 0 END);

-- set_domain_version is a definer, closed to PUBLIC and web_anon
SELECT 1 / COUNT(*) FROM pg_proc
WHERE proname = 'set_domain_version' AND pronamespace = 'public'::regnamespace AND prosecdef;
SELECT 1 / (CASE WHEN has_function_privilege('public', 'public.set_domain_version(text,text,text,integer)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.set_domain_version(text,text,text,integer)', 'EXECUTE') THEN 0 ELSE 1 END);

-- the public decisions view still has the column
SELECT 1 / COUNT(*) FROM pg_attribute
WHERE attrelid = 'public.schema_decisions'::regclass AND attname = 'domain_version' AND NOT attisdropped;

ROLLBACK;
