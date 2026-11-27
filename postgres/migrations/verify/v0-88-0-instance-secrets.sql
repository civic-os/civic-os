-- Verify civic_os:v0-88-0-instance-secrets on pg
--
-- Checks the objects exist and keep their security properties.

BEGIN;

-- columns
SELECT is_secret, managed_by, secret_display FROM metadata.instance_config WHERE false;

-- the five S3 keys are deployment-managed secrets, never public
SELECT 1 / (CASE WHEN COUNT(*) = 5 THEN 1 ELSE 0 END) FROM metadata.instance_config
WHERE config_key IN ('s3_access_key_id', 's3_secret_access_key', 's3_region', 's3_public_endpoint', 's3_bucket')
  AND is_secret AND managed_by = 'deployment' AND NOT is_public;

-- policies hide secret rows
SELECT 1 / COUNT(*) FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'instance_config' AND policyname = 'instance_config_select_authenticated'
  AND qual LIKE '%is_secret%';
SELECT 1 / COUNT(*) FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'instance_config' AND policyname = 'instance_config_select_anon'
  AND qual LIKE '%is_secret%';

-- the view keeps security_invoker
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.instance_config'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- owner-only readers and the deployment writer: no API role can execute them
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata.s3_signing_config()', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'metadata.s3_signing_config()', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata.get_instance_secret(text)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata.publish_deployment_config(jsonb)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'metadata.publish_deployment_config(jsonb)', 'EXECUTE') THEN 0 ELSE 1 END);

-- admin RPCs: authenticated only
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.set_instance_secret(text,text)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.set_instance_secret(text,text)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.get_instance_secret_status()', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.get_instance_secret_status()', 'EXECUTE') THEN 0 ELSE 1 END);

-- definers pin their search_path
SELECT 1 / (CASE WHEN COUNT(*) = 3 THEN 1 ELSE 0 END) FROM pg_proc
WHERE oid IN ('metadata.publish_deployment_config(jsonb)'::regprocedure,
              'public.set_instance_secret(text,text)'::regprocedure,
              'public.get_instance_secret_status()'::regprocedure)
  AND prosecdef AND proconfig IS NOT NULL;

ROLLBACK;
