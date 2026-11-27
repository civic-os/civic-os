#!/bin/bash
# =============================================================================
# Functional Test: v0-88-0 signed file URLs and in-database upload signing
# =============================================================================
# Covers docs/notes/SIGNED_FILE_URLS_DESIGN.md (v0.88.0 amendment):
#   - the SigV4 signer reproduces AWS's presigned GET example; URI encoding of space, unicode, +, ~, /;
#   - public.files: security_invoker, signed URLs for private files and direct ones for public files,
#     X-Amz-Date on a 5-minute boundary and X-Amz-Expires=1200, the same URL on a second read,
#     download_url with an RFC 6266 content-disposition, all URLs NULL without the S3 config;
#   - RLS decides which rows get URLs: a user sees no row (and no URL) for a file they may not read;
#   - request_file_upload(): the key rule (_new before the record exists, Go's filepath.Ext), private by
#     default, x-amz-acl signed only for static assets, static assets need static_assets:create,
#     file_storage_not_configured (55000) without the S3 config, signed-in users only;
#   - create_file_record(): registers only an upload issued to the same user, with its bucket and key,
#     once; is_public follows the rule;
#   - the shims: request_upload_url() completes at once with x-amz-acl signed (an older SPA sends it),
#     get_upload_url() returns only the caller's request;
#   - grants and pinned search_paths; no s3_presign trigger.
#
# Everything runs in one transaction that is rolled back. The S3 config is set to fixed test values inside
# it, so the published values do not matter.
#
# Usage:
#   ./tests/functional/v0-88-0-signed-file-urls-test.sh
#
# Environment overrides (the connecting user must be a superuser):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

CREATE FUNCTION pg_temp.expect_sqlstate(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = p_state;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_sqlstate(text, text) TO PUBLIC;

CREATE FUNCTION pg_temp.as_user(p_sub text, p_roles text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","roles":%s}', p_sub, p_roles), true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text, text) TO PUBLIC;

-- query parameter of a URL
CREATE FUNCTION pg_temp.qp(p_url text, p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT (regexp_match(p_url, '[?&]' || p_name || '=([^&]*)'))[1]
$$;
GRANT EXECUTE ON FUNCTION pg_temp.qp(text, text) TO PUBLIC;

-- Fixed S3 config for the test
SELECT metadata.publish_deployment_config(jsonb_build_object(
  's3_access_key_id', 'TESTKEYID', 's3_secret_access_key', 'testsecret', 's3_region', 'us-east-1',
  's3_public_endpoint', 'http://files.example.test:9000', 's3_bucket', 'test-bucket'));

-- Two users and fixtures: a readable Issue file, a hidden file, a public static asset
INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000088a1', 'Signer A'),
  ('00000000-0000-0000-0000-0000000088a2', 'Signer B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metadata.files (id, entity_type, entity_id, file_name, file_type, file_size, s3_bucket,
                            s3_original_key, s3_thumbnail_small_key, thumbnail_status, created_by, is_public)
VALUES
  ('0190e8a0-0000-7000-8000-0000000088f1', 'Issue', '1', 'photo é.png', 'image/png', 10, 'test-bucket',
   'Issue/1/0190e8a0-0000-7000-8000-0000000088f1/original.png',
   'Issue/1/0190e8a0-0000-7000-8000-0000000088f1/thumb-150.jpg', 'completed', NULL, false),
  ('0190e8a0-0000-7000-8000-0000000088f2', 't_hidden', '1', 'hidden.pdf', 'application/pdf', 10, 'test-bucket',
   't_hidden/1/0190e8a0-0000-7000-8000-0000000088f2/original.pdf', NULL, 'not_applicable', NULL, false),
  ('0190e8a0-0000-7000-8000-0000000088f3', 'static_assets', 'x', 'logo.png', 'image/png', 10, 'test-bucket',
   'static_assets/x/0190e8a0-0000-7000-8000-0000000088f3/original.png', NULL, 'not_applicable',
   '00000000-0000-0000-0000-0000000088a1', true);
-- the insert trigger takes created_by from the JWT (none here), so set the owner afterwards
UPDATE metadata.files SET created_by = '00000000-0000-0000-0000-0000000088a1'
WHERE id = '0190e8a0-0000-7000-8000-0000000088f3';

-- ---------------------------------------------------------------------------
-- Signer and encoding
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT metadata._sigv4_presign('GET', 'examplebucket.s3.amazonaws.com', '/test.txt', NULL, NULL,
    'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'us-east-1', '2013-05-24 00:00:00+00', 86400)
    = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
      '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
      '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    'the signer reproduces the AWS presigned GET example exactly';
  ASSERT metadata.aws_uri_encode('a b/é+~-._', true) = 'a%20b%2F%C3%A9%2B~-._', 'encode with slash';
  ASSERT metadata.aws_uri_encode('a b/é+~-._', false) = 'a%20b/%C3%A9%2B~-._', 'encode a path';
  ASSERT pg_temp.qp(metadata._sigv4_presign('PUT', 'h', '/b/k', NULL, '{"x-amz-acl":"public-read"}', 'K', 'S', 'us-east-1', now(), 900),
    'X-Amz-SignedHeaders') = 'host%3Bx-amz-acl', 'an extra header is signed, sorted after host';
  ASSERT metadata._file_object_key('Issue', '', '0190e8a0-0000-7000-8000-000000000001', 'a.JPG')
    = 'Issue/_new/0190e8a0-0000-7000-8000-000000000001/original.JPG', 'staged key under _new';
  ASSERT metadata._file_object_key('Issue', '7', '0190e8a0-0000-7000-8000-000000000001', 'a.tar.gz')
    = 'Issue/7/0190e8a0-0000-7000-8000-000000000001/original.gz', 'the last extension';
  ASSERT metadata._file_object_key('Issue', '7', '0190e8a0-0000-7000-8000-000000000001', 'dir.v2/noext')
    = 'Issue/7/0190e8a0-0000-7000-8000-000000000001/original.bin', '.bin without an extension in the last segment';
  ASSERT metadata.file_is_public('static_assets') AND NOT metadata.file_is_public('Issue') AND NOT metadata.file_is_public(NULL),
    'only static assets are public';
END $$;

-- ---------------------------------------------------------------------------
-- public.files: URLs for the rows RLS shows
-- ---------------------------------------------------------------------------
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000088a1', '["user"]');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v RECORD;
  v_again TEXT;
  v_date TIMESTAMP;
BEGIN
  SELECT * INTO v FROM public.files WHERE id = '0190e8a0-0000-7000-8000-0000000088f1';
  ASSERT v.url LIKE 'http://files.example.test:9000/test-bucket/Issue/1/0190e8a0-0000-7000-8000-0000000088f1/original.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&%',
    'a private file gets a path-style signed URL: ' || v.url;
  ASSERT pg_temp.qp(v.url, 'X-Amz-Expires') = '1200', 'expiry 1200 s';
  ASSERT pg_temp.qp(v.url, 'X-Amz-Credential') LIKE 'TESTKEYID%2F%', 'signed with the published key id';
  v_date := to_timestamp(pg_temp.qp(v.url, 'X-Amz-Date'), 'YYYYMMDD"T"HH24MISS"Z"')::timestamp;
  ASSERT extract(epoch FROM v_date)::bigint % 300 = 0, 'the signing time is on a 5-minute boundary';
  ASSERT v.thumb_small_url LIKE '%/thumb-150.jpg?X-Amz-%', 'thumbnails are signed too';
  ASSERT v.thumb_medium_url IS NULL AND v.thumb_large_url IS NULL, 'missing thumbnails have no URL';
  ASSERT position('X-Amz-Signature=' IN v.download_url) > 0
     AND pg_temp.qp(v.download_url, 'response-content-disposition')
         = 'attachment%3B%20filename%3D%22photo%20_.png%22%3B%20filename%2A%3DUTF-8%27%27photo%2520%25C3%25A9.png',
    'download_url signs an RFC 6266 disposition: ' || v.download_url;
  SELECT url INTO v_again FROM public.files WHERE id = '0190e8a0-0000-7000-8000-0000000088f1';
  ASSERT v_again = v.url, 'a second read returns the same URL';

  SELECT * INTO v FROM public.files WHERE id = '0190e8a0-0000-7000-8000-0000000088f3';
  ASSERT v.url = 'http://files.example.test:9000/test-bucket/static_assets/x/0190e8a0-0000-7000-8000-0000000088f3/original.png',
    'a public file gets a direct URL: ' || v.url;
  ASSERT position('X-Amz-Signature=' IN v.download_url) > 0, 'its download_url is still signed';

  ASSERT NOT EXISTS (SELECT 1 FROM public.files WHERE id = '0190e8a0-0000-7000-8000-0000000088f2'),
    'a file the user may not read has no row, so no URL';
  -- v0.88.0 fix: a UUID-keyed entity (static_assets) answers false instead of raising undefined_function
  ASSERT metadata.can_view_entity_record('static_assets', 'x') = false
     AND metadata.can_view_entity_record('static_assets', '00000000-0000-0000-0000-000000000000') = false,
    'can_view_entity_record handles UUID keys';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE web_anon;
DO $$
BEGIN
  ASSERT (SELECT url FROM public.files WHERE id = '0190e8a0-0000-7000-8000-0000000088f1') LIKE '%X-Amz-Signature=%',
    'anonymous callers get signed URLs for rows they may read';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.request_file_upload('Issue', '1', 'a.png', 'image/png')$q$, '42501'),
    'anonymous callers cannot request an upload';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Uploads
-- ---------------------------------------------------------------------------
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000088a1', '["user"]');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r JSONB;
  r2 JSONB;
  v_rec JSON;
BEGIN
  r := public.request_file_upload('Issue', '', 'photo.png', 'image/png');
  ASSERT r ->> 'key' = 'Issue/_new/' || (r ->> 'file_id') || '/original.png', 'a staged upload key: ' || r::text;
  ASSERT r ->> 'bucket' = 'test-bucket' AND NOT (r ->> 'is_public')::boolean, 'default bucket, private';
  ASSERT r ->> 'url' LIKE 'http://files.example.test:9000/test-bucket/Issue/_new/%/original.png?%', 'a PUT URL for the key';
  ASSERT pg_temp.qp(r ->> 'url', 'X-Amz-SignedHeaders') = 'host', 'no ACL is signed for a private upload';
  ASSERT pg_temp.qp(r ->> 'url', 'X-Amz-Expires') = '900', 'PUT URLs last 15 minutes';

  -- a mismatched key, bucket or entity is refused
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.create_file_record(%L, 'Issue', '', 'photo.png', 'image/png', 1, 'test-bucket', 'Issue/1/other/original.png')$q$, r ->> 'file_id'), '42501'),
    'a client-chosen key is refused';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.create_file_record(%L, 'Issue', '', 'photo.png', 'image/png', 1, 'other-bucket', %L)$q$, r ->> 'file_id', r ->> 'key'), '42501'),
    'a client-chosen bucket is refused';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.create_file_record(%L, 'Issue', '5', 'photo.png', 'image/png', 1, 'test-bucket', %L)$q$, r ->> 'file_id', r ->> 'key'), '42501'),
    'another entity id is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.create_file_record('0190e8a0-0000-7000-8000-0000000088f9', 'Issue', '1', 'x.png', 'image/png', 1, 'test-bucket', 'Issue/1/0190e8a0-0000-7000-8000-0000000088f9/original.png')$q$, '42501'),
    'a file id the database never issued is refused';
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.create_file_record('0190e8a0-0000-7000-8000-0000000088f1', 'Issue', '1', 'photo é.png', 'image/png', 1, 'test-bucket', 'Issue/1/0190e8a0-0000-7000-8000-0000000088f1/original.png')$q$, '42501'),
    'an existing file''s id and key are refused';

  v_rec := public.create_file_record((r ->> 'file_id')::uuid, 'Issue', '', 'photo.png', 'image/png', 1, 'test-bucket', r ->> 'key', 'pending', 'photo');
  ASSERT v_rec ->> 'entity_id' = '' AND v_rec ->> 's3_original_key' = r ->> 'key' AND NOT (v_rec ->> 'is_public')::boolean,
    'the issued upload is registered with its key, private';
  ASSERT v_rec ->> 'url' LIKE '%X-Amz-Signature=%', 'create_file_record returns the file with its signed URL';
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.create_file_record(%L, 'Issue', '', 'photo.png', 'image/png', 1, 'test-bucket', %L)$q$, r ->> 'file_id', r ->> 'key'), '42501'),
    'an upload is registered once';

  -- static assets need the permission
  ASSERT pg_temp.expect_sqlstate($q$SELECT public.request_file_upload('static_assets', 'x', 'logo.png', 'image/png')$q$, '42501'),
    'a user without static_assets:create cannot create a public file';

  -- another user's issued upload
  r2 := public.request_file_upload('Issue', '1', 'mine.png', 'image/png');
  PERFORM set_config('t.other_file', r2 ->> 'file_id', true);
  PERFORM set_config('t.other_key', r2 ->> 'key', true);
END $$;
RESET ROLE;

SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000088a2', '["user"]');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_req UUID;
BEGIN
  ASSERT pg_temp.expect_sqlstate(format($q$SELECT public.create_file_record(%L, 'Issue', '1', 'mine.png', 'image/png', 1, 'test-bucket', %L)$q$,
    current_setting('t.other_file'), current_setting('t.other_key')), '42501'),
    'another user''s issued upload cannot be registered';

  -- the shim pair completes at once and keeps requests private to their owner
  v_req := public.request_upload_url('Issue', '1', 'old.png', 'image/png');
  ASSERT (SELECT status FROM public.get_upload_url(v_req)) = 'completed', 'the shim request completes immediately';
  ASSERT pg_temp.qp((SELECT url FROM public.get_upload_url(v_req)), 'X-Amz-SignedHeaders') = 'host%3Bx-amz-acl',
    'the shim signs x-amz-acl, which an older SPA always sends';
  PERFORM set_config('t.b_request', v_req::text, true);
END $$;
RESET ROLE;

SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000088a1', '["user"]');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.get_upload_url(current_setting('t.b_request')::uuid)),
    'get_upload_url returns nothing for another user''s request';
END $$;
RESET ROLE;

-- an admin may create static assets: public, and the ACL is signed
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000088a2', '["admin"]');
SET LOCAL ROLE authenticated;
DO $$
DECLARE r JSONB; v_rec JSON;
BEGIN
  r := public.request_file_upload('static_assets', 'x', 'logo.png', 'image/png');
  ASSERT (r ->> 'is_public')::boolean AND pg_temp.qp(r ->> 'url', 'X-Amz-SignedHeaders') = 'host%3Bx-amz-acl',
    'a static asset upload is public and signs x-amz-acl';
  v_rec := public.create_file_record((r ->> 'file_id')::uuid, 'static_assets', 'x', 'logo.png', 'image/png', 1, 'test-bucket', r ->> 'key');
  ASSERT (v_rec ->> 'is_public')::boolean, 'its record is public';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Without the S3 config: NULL URLs, uploads refused with a named error
-- ---------------------------------------------------------------------------
UPDATE metadata.instance_config SET config_value = NULL WHERE config_key = 's3_secret_access_key';
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000088a1', '["user"]');
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_msg TEXT;
BEGIN
  ASSERT (SELECT url IS NULL AND thumb_small_url IS NULL AND download_url IS NULL FROM public.files
          WHERE id = '0190e8a0-0000-7000-8000-0000000088f1'), 'URLs are NULL without the config';
  BEGIN
    PERFORM public.request_file_upload('Issue', '1', 'a.png', 'image/png');
    ASSERT false, 'request_file_upload should fail without the config';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg = 'file_storage_not_configured', 'the named error: ' || v_msg;
  END;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Security properties
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'public.files'::regclass),
    'public.files is security_invoker';
  ASSERT has_function_privilege('web_anon', 'metadata.file_urls(text,text,text,text,text,boolean)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'metadata.file_download_url(text,text,text)', 'EXECUTE'),
    'the view''s signers run for API roles';
  ASSERT NOT has_function_privilege('authenticated', 'metadata._presign_put(text,text,boolean)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'metadata._issue_upload(text,text,text,text,boolean)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'metadata._sigv4_presign(text,text,text,jsonb,jsonb,text,text,text,timestamp with time zone,integer)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'metadata.s3_signing_config()', 'EXECUTE'),
    'the internal signers are owner-only';
  ASSERT NOT has_function_privilege('web_anon', 'public.request_file_upload(text,text,text,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.request_file_upload(text,text,text,text)', 'EXECUTE'),
    'request_file_upload is for signed-in users';
  ASSERT (SELECT bool_and(proconfig::text LIKE '%search_path%') FROM pg_proc WHERE prosecdef AND oid IN (
      'metadata.file_urls(text,text,text,text,text,boolean)'::regprocedure,
      'metadata.file_download_url(text,text,text)'::regprocedure,
      'metadata._presign_put(text,text,boolean)'::regprocedure,
      'metadata._issue_upload(text,text,text,text,boolean)'::regprocedure,
      'public.request_file_upload(text,text,text,text)'::regprocedure,
      'public.request_upload_url(text,text,text,text)'::regprocedure,
      'public.get_upload_url(uuid)'::regprocedure,
      'public.create_file_record(uuid,text,text,text,text,bigint,text,text,text,text)'::regprocedure)),
    'every definer pins its search_path';
  ASSERT (SELECT proconfig::text LIKE '%search_path%' FROM pg_proc WHERE oid = 'public.uuid_generate_v7()'::regprocedure),
    'uuid_generate_v7 resolves pgcrypto from any caller';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'insert_s3_presign_job_trigger'), 'no s3_presign trigger';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: signed file URLs (signer, view URLs, RLS, uploads issued by the database, shims, missing config, security)"
else
  echo "FAIL: signed file URL checks failed (see error above)"
  exit 1
fi
