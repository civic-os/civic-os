-- Verify civic_os:v0-79-0-instance-config on pg
--
-- Holds both right after this deploy and on the fully deployed database, so it checks that the objects
-- exist and keep their security properties, not their exact shape.

BEGIN;

-- both tables exist with RLS on
SELECT 1 / COUNT(*) FROM pg_class WHERE oid = 'metadata.instance_config'::regclass AND relrowsecurity;
SELECT 1 / COUNT(*) FROM pg_class WHERE oid = 'metadata.instance_config_groups'::regclass AND relrowsecurity;

-- API roles cannot insert or delete, and can write only config_value
SELECT 1 / (CASE WHEN has_table_privilege('authenticated', 'metadata.instance_config', 'INSERT,DELETE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_column_privilege('authenticated', 'metadata.instance_config', 'config_value', 'UPDATE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_column_privilege('authenticated', 'metadata.instance_config', 'config_key', 'UPDATE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_column_privilege('authenticated', 'metadata.instance_config', 'default_value', 'UPDATE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_table_privilege('web_anon', 'metadata.instance_config', 'INSERT,UPDATE,DELETE') THEN 0 ELSE 1 END);

-- the public view keeps security_invoker
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.instance_config'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- the RPCs exist; PUBLIC cannot execute them and web_anon cannot write
SELECT 1 / COUNT(*) FROM pg_proc WHERE oid = 'public.set_instance_config(text,text)'::regprocedure;
SELECT 1 / COUNT(*) FROM pg_proc WHERE oid = 'public.get_config(text)'::regprocedure;
SELECT 1 / (CASE WHEN has_function_privilege('public', 'public.set_instance_config(text,text)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.set_instance_config(text,text)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('public', 'public.get_config(text)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.get_config(text)', 'EXECUTE') THEN 1 ELSE 0 END);

-- the normalize triggers (value and default) exist and PUBLIC cannot execute its function
SELECT 1 / COUNT(*) FROM pg_trigger WHERE tgrelid = 'metadata.instance_config'::regclass AND tgname = 'instance_config_normalize_trigger';
SELECT 1 / COUNT(*) FROM pg_trigger WHERE tgrelid = 'metadata.instance_config'::regclass AND tgname = 'instance_config_default_trigger';
SELECT 1 / (CASE WHEN has_function_privilege('public', 'metadata.instance_config_normalize()', 'EXECUTE') THEN 0 ELSE 1 END);

-- the cache-version view carries the instance_config row
SELECT 1 / COUNT(*) FROM public.schema_cache_versions WHERE cache_name = 'instance_config';

-- the permission is mapped to admin
SELECT 1 / COUNT(*) FROM metadata.permissions p
JOIN metadata.permission_roles pr ON pr.permission_id = p.id
JOIN metadata.roles r ON r.id = pr.role_id
WHERE p.table_name = 'metadata.instance_config' AND p.permission = 'update' AND r.role_key = 'admin';

ROLLBACK;
