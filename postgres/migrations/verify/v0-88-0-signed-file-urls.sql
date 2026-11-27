-- Verify civic_os:v0-88-0-signed-file-urls on pg

BEGIN;

-- columns
SELECT is_public FROM metadata.files WHERE false;
SELECT requested_by, s3_bucket, is_public FROM metadata.file_upload_requests WHERE false;
SELECT is_public, url, thumb_small_url, thumb_medium_url, thumb_large_url, download_url FROM public.files WHERE false;

-- the view keeps security_invoker
SELECT 1 / COUNT(*) FROM pg_class
WHERE oid = 'public.files'::regclass AND reloptions @> ARRAY['security_invoker=true'];

-- the signer reproduces AWS's presigned GET example (examplebucket/test.txt, 2013-05-24, 86400 s)
SELECT 1 / (CASE WHEN metadata._sigv4_presign('GET', 'examplebucket.s3.amazonaws.com', '/test.txt', NULL, NULL,
  'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'us-east-1', '2013-05-24 00:00:00+00', 86400)
  LIKE '%&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404' THEN 1 ELSE 0 END);

-- the view's signers run for API roles; the internal ones do not
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'metadata.file_urls(text,text,text,text,text,boolean)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata.file_download_url(text,text,text)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata._presign_put(text,text,boolean)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'metadata._issue_upload(text,text,text,text,boolean)', 'EXECUTE') THEN 0 ELSE 1 END);
SELECT 1 / (CASE WHEN has_function_privilege('authenticated', 'public.request_file_upload(text,text,text,text)', 'EXECUTE') THEN 1 ELSE 0 END);
SELECT 1 / (CASE WHEN has_function_privilege('web_anon', 'public.request_file_upload(text,text,text,text)', 'EXECUTE') THEN 0 ELSE 1 END);

-- every definer added or replaced here pins its search_path
SELECT 1 / (CASE WHEN bool_and(proconfig IS NOT NULL) THEN 1 ELSE 0 END) FROM pg_proc
WHERE prosecdef AND oid IN (
  'metadata.file_urls(text,text,text,text,text,boolean)'::regprocedure,
  'metadata.file_download_url(text,text,text)'::regprocedure,
  'metadata._presign_put(text,text,boolean)'::regprocedure,
  'metadata._issue_upload(text,text,text,text,boolean)'::regprocedure,
  'public.request_file_upload(text,text,text,text)'::regprocedure,
  'public.request_upload_url(text,text,text,text)'::regprocedure,
  'public.get_upload_url(uuid)'::regprocedure,
  'public.create_file_record(uuid,text,text,text,text,bigint,text,text,text,text)'::regprocedure);

-- no worker presign trigger
SELECT 1 / (CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'insert_s3_presign_job_trigger') THEN 0 ELSE 1 END);

ROLLBACK;
