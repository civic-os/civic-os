-- Deploy civic_os:v0-88-0-signed-file-urls to pg
-- requires: v0-88-0-instance-secrets-translations
--
-- Signed file URLs and in-database upload signing (design: docs/notes/SIGNED_FILE_URLS_DESIGN.md,
-- algorithm: docs/notes/SIGV4_SIGNING_REFERENCE.md). Files stop being public-read: RLS on metadata.files
-- decides who gets a URL, and URLs expire.
--
--   metadata.files.is_public          static_assets files only (metadata.file_is_public()); everything else
--                                     is private and reached through signed URLs
--   metadata._hmac_sha256()           pgcrypto's hmac(), generated with pgcrypto's schema qualified
--                                     (plugins on self-hosted databases, public on managed ones)
--   metadata.aws_uri_encode()         SigV4 URI encoding
--   metadata._sigv4_presign()         pure SigV4 query-string signing (credentials and time passed in)
--   metadata.file_urls()              the four display URLs of one file (signed unless public)
--   metadata.file_download_url()      a signed URL that downloads with the file's name
--   public.files                      re-created with explicit columns, is_public and the URL columns
--   public.request_file_upload()      synchronous presigned PUT; replaces the request/poll pair
--   request_upload_url()/get_upload_url()  kept as SQL-signed shims for a cached older SPA (removed in a
--                                     later release); get_upload_url() now returns only the caller's request
--   public.create_file_record()       registers only an upload the database issued to the same user, with
--                                     the key the database chose (a client-chosen key could point a record at
--                                     another file's private object and get a signed URL for it)
--   insert_s3_presign_job             trigger and function dropped; queued s3_presign jobs cancelled
--
-- URLs are signed with X-Amz-Date rounded down to a 5-minute bucket and X-Amz-Expires = 1200, so a file
-- keeps the same URL for 5 minutes (browser cache hits, stable <img src>) and every URL is valid for at
-- least 15 minutes after it is read. Signing functions read the credentials through the owner-only
-- metadata.s3_signing_config() and return only URLs they computed.

BEGIN;

-- ============================================================================
-- 1. is_public
-- ============================================================================

CREATE FUNCTION metadata.file_is_public(p_entity_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_entity_type IS NOT DISTINCT FROM 'static_assets'
$$;

COMMENT ON FUNCTION metadata.file_is_public(TEXT) IS
    'The rule for public files: static assets (images used in emails and dashboards, which need stable unsigned URLs). Every other file is private and reached through signed URLs that RLS on metadata.files gates. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.file_is_public(TEXT) FROM PUBLIC;

ALTER TABLE metadata.files ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN metadata.files.is_public IS
    'True for files with a stable unsigned URL and a public-read object (metadata.file_is_public(): static assets). Set by create_file_record(); the thumbnail worker gives thumbnails the same ACL. Added in v0.88.0.';

UPDATE metadata.files SET is_public = true WHERE metadata.file_is_public(entity_type);

-- ============================================================================
-- 2. SIGNING PRIMITIVES
-- ============================================================================

-- HMAC-SHA256 from pgcrypto, whose schema differs by host; the call is generated schema-qualified so the
-- signers can pin search_path = ''.
DO $do$
DECLARE
  v_schema TEXT;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgcrypto';
  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is required for signed file URLs';
  END IF;

  EXECUTE format($f$
    CREATE FUNCTION metadata._hmac_sha256(p_key BYTEA, p_message BYTEA)
    RETURNS BYTEA
    LANGUAGE sql
    IMMUTABLE STRICT
    SET search_path = ''
    AS 'SELECT %I.hmac(p_message, p_key, ''sha256'')'
  $f$, v_schema);

  -- uuid_generate_v7() calls gen_random_bytes() unqualified, so it failed inside definers that pin a
  -- search_path without pgcrypto's schema (the upload RPCs below). Its body uses only built-ins and that.
  EXECUTE format('ALTER FUNCTION public.uuid_generate_v7() SET search_path = pg_catalog, %I', v_schema);
END
$do$;

COMMENT ON FUNCTION metadata._hmac_sha256(BYTEA, BYTEA) IS
    'HMAC-SHA256 (pgcrypto, schema-qualified at deploy). Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata._hmac_sha256(BYTEA, BYTEA) FROM PUBLIC;

-- AWS SigV4 URI encoding: every byte of the UTF-8 form except A-Z a-z 0-9 - . _ ~ becomes %XX with
-- uppercase hex; "/" stays literal only when p_encode_slash is false (object key paths).
CREATE FUNCTION metadata.aws_uri_encode(p_input TEXT, p_encode_slash BOOLEAN DEFAULT true)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path = ''
AS $$
DECLARE
  v_bytes BYTEA := pg_catalog.convert_to(p_input, 'UTF8');
  v_out TEXT := '';
  v_b INTEGER;
  i INTEGER;
BEGIN
  FOR i IN 0 .. pg_catalog.length(v_bytes) - 1 LOOP
    v_b := pg_catalog.get_byte(v_bytes, i);
    IF (v_b BETWEEN 65 AND 90) OR (v_b BETWEEN 97 AND 122) OR (v_b BETWEEN 48 AND 57)
       OR v_b IN (45, 46, 95, 126) OR (v_b = 47 AND NOT p_encode_slash) THEN
      v_out := v_out || pg_catalog.chr(v_b);
    ELSE
      v_out := v_out || '%' || pg_catalog.upper(pg_catalog.lpad(pg_catalog.to_hex(v_b), 2, '0'));
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION metadata.aws_uri_encode(TEXT, BOOLEAN) IS
    'AWS SigV4 URI encoding (RFC 3986 unreserved characters kept, uppercase hex, "/" kept when p_encode_slash is false). Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.aws_uri_encode(TEXT, BOOLEAN) FROM PUBLIC;

-- Pure SigV4 query-string signing. Returns the canonical query string with X-Amz-Signature appended.
-- p_path is the unencoded absolute path; p_headers are signed in addition to host.
CREATE FUNCTION metadata._sigv4_presign(
  p_method TEXT,
  p_host TEXT,
  p_path TEXT,
  p_query JSONB,
  p_headers JSONB,
  p_access_key_id TEXT,
  p_secret_access_key TEXT,
  p_region TEXT,
  p_at TIMESTAMPTZ,
  p_expires INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_utc TIMESTAMP := p_at AT TIME ZONE 'UTC';
  v_date TEXT := pg_catalog.to_char(v_utc, 'YYYYMMDD');
  v_stamp TEXT := pg_catalog.to_char(v_utc, 'YYYYMMDD"T"HH24MISS"Z"');
  v_scope TEXT := v_date || '/' || p_region || '/s3/aws4_request';
  v_headers JSONB := COALESCE(p_headers, '{}'::jsonb) || jsonb_build_object('host', p_host);
  v_signed TEXT;
  v_canon_headers TEXT;
  v_query JSONB;
  v_canon_query TEXT;
  v_canon TEXT;
  v_sts TEXT;
  v_key BYTEA;
BEGIN
  SELECT pg_catalog.string_agg(h.k, ';' ORDER BY h.k COLLATE "C"),
         pg_catalog.string_agg(h.k || ':' || pg_catalog.btrim(v_headers ->> h.key), E'\n' ORDER BY h.k COLLATE "C")
    INTO v_signed, v_canon_headers
    FROM (SELECT key, pg_catalog.lower(key) AS k FROM pg_catalog.jsonb_object_keys(v_headers) key) h;

  v_query := COALESCE(p_query, '{}'::jsonb) || jsonb_build_object(
    'X-Amz-Algorithm', 'AWS4-HMAC-SHA256',
    'X-Amz-Credential', p_access_key_id || '/' || v_scope,
    'X-Amz-Date', v_stamp,
    'X-Amz-Expires', p_expires::TEXT,
    'X-Amz-SignedHeaders', v_signed);

  SELECT pg_catalog.string_agg(q.ek || '=' || q.ev, '&' ORDER BY q.ek COLLATE "C")
    INTO v_canon_query
    FROM (SELECT metadata.aws_uri_encode(e.key) AS ek, metadata.aws_uri_encode(e.value) AS ev
          FROM pg_catalog.jsonb_each_text(v_query) e) q;

  v_canon := p_method || E'\n' || metadata.aws_uri_encode(p_path, false) || E'\n' || v_canon_query || E'\n'
          || v_canon_headers || E'\n\n' || v_signed || E'\nUNSIGNED-PAYLOAD';
  v_sts := 'AWS4-HMAC-SHA256' || E'\n' || v_stamp || E'\n' || v_scope || E'\n'
        || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_canon, 'UTF8')), 'hex');

  v_key := metadata._hmac_sha256(pg_catalog.convert_to('AWS4' || p_secret_access_key, 'UTF8'), pg_catalog.convert_to(v_date, 'UTF8'));
  v_key := metadata._hmac_sha256(v_key, pg_catalog.convert_to(p_region, 'UTF8'));
  v_key := metadata._hmac_sha256(v_key, pg_catalog.convert_to('s3', 'UTF8'));
  v_key := metadata._hmac_sha256(v_key, pg_catalog.convert_to('aws4_request', 'UTF8'));

  RETURN v_canon_query || '&X-Amz-Signature='
      || pg_catalog.encode(metadata._hmac_sha256(v_key, pg_catalog.convert_to(v_sts, 'UTF8')), 'hex');
END;
$$;

COMMENT ON FUNCTION metadata._sigv4_presign(TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER) IS
    'AWS SigV4 query-string presigning (UNSIGNED-PAYLOAD): returns the canonical query string plus X-Amz-Signature. Pure: credentials and signing time are parameters, so tests can use the AWS example vector. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata._sigv4_presign(TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;

-- Splits a path-style endpoint (http[s]://host[:port][/prefix]) into what an object URL needs.
CREATE FUNCTION metadata._s3_endpoint_parts(p_endpoint TEXT, OUT origin TEXT, OUT host TEXT, OUT path_prefix TEXT)
LANGUAGE sql
IMMUTABLE STRICT
SET search_path = ''
AS $$
  SELECT m[1] || m[2], m[2], pg_catalog.rtrim(COALESCE(m[3], ''), '/')
  FROM pg_catalog.regexp_match(p_endpoint, '^(https?://)([^/]+)(/.*)?$') m
$$;

REVOKE EXECUTE ON FUNCTION metadata._s3_endpoint_parts(TEXT) FROM PUBLIC;

-- ============================================================================
-- 3. SIGNERS (definer: they read the credentials; they return only computed URLs)
-- ============================================================================

-- Signing time: now() rounded down to 5 minutes, so the same object gets the same URL for 5 minutes.
-- Expiry 1200 s from that time: valid for at least 15 minutes after it is read.
CREATE FUNCTION metadata.file_urls(
  p_bucket TEXT,
  p_original_key TEXT,
  p_small_key TEXT,
  p_medium_key TEXT,
  p_large_key TEXT,
  p_is_public BOOLEAN
)
RETURNS TABLE (url TEXT, thumb_small_url TEXT, thumb_medium_url TEXT, thumb_large_url TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg RECORD;
  v_ep RECORD;
  v_at TIMESTAMPTZ := pg_catalog.to_timestamp(pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now()) / 300) * 300);
  v_keys TEXT[] := ARRAY[p_original_key, p_small_key, p_medium_key, p_large_key];
  v_urls TEXT[] := ARRAY[NULL, NULL, NULL, NULL]::TEXT[];
  v_path TEXT;
  i INTEGER;
BEGIN
  SELECT * INTO v_cfg FROM metadata.s3_signing_config();
  IF NOT FOUND OR p_bucket IS NULL THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  SELECT * INTO v_ep FROM metadata._s3_endpoint_parts(v_cfg.public_endpoint);

  FOR i IN 1 .. 4 LOOP
    CONTINUE WHEN v_keys[i] IS NULL;
    v_path := v_ep.path_prefix || '/' || p_bucket || '/' || v_keys[i];
    IF p_is_public THEN
      v_urls[i] := v_ep.origin || metadata.aws_uri_encode(v_path, false);
    ELSE
      v_urls[i] := v_ep.origin || metadata.aws_uri_encode(v_path, false) || '?' ||
        metadata._sigv4_presign('GET', v_ep.host, v_path, NULL, NULL,
          v_cfg.access_key_id, v_cfg.secret_access_key, v_cfg.region, v_at, 1200);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_urls[1], v_urls[2], v_urls[3], v_urls[4];
END;
$$;

COMMENT ON FUNCTION metadata.file_urls(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) IS
    'The display URLs of one file (original and three thumbnails): direct for a public file, else SigV4-signed GET URLs (signing time rounded to 5 minutes, valid 20 minutes from it). NULL for a missing key, and all NULL until the S3 signing config is published. Called by the public.files view, whose RLS decides which rows reach it. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.file_urls(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.file_urls(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO web_anon, authenticated;

-- A signed URL whose response downloads under the file's name (signed even for public files, because
-- response-content-disposition must be signed).
CREATE FUNCTION metadata.file_download_url(p_bucket TEXT, p_key TEXT, p_file_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg RECORD;
  v_ep RECORD;
  v_at TIMESTAMPTZ := pg_catalog.to_timestamp(pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now()) / 300) * 300);
  v_name TEXT := pg_catalog.regexp_replace(COALESCE(NULLIF(p_file_name, ''), 'download'), '[\r\n]', ' ', 'g');
  v_ascii TEXT;
  v_disposition TEXT;
  v_path TEXT;
BEGIN
  IF p_bucket IS NULL OR p_key IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_cfg FROM metadata.s3_signing_config();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_ep FROM metadata._s3_endpoint_parts(v_cfg.public_endpoint);

  -- RFC 6266: an ASCII fallback plus the exact name in filename* (RFC 5987)
  v_ascii := pg_catalog.regexp_replace(v_name, '[^\x20-\x7E]|["\\]', '_', 'g');
  v_disposition := 'attachment; filename="' || v_ascii || '"; filename*=UTF-8''''' || metadata.aws_uri_encode(v_name);
  v_path := v_ep.path_prefix || '/' || p_bucket || '/' || p_key;

  RETURN v_ep.origin || metadata.aws_uri_encode(v_path, false) || '?' ||
    metadata._sigv4_presign('GET', v_ep.host, v_path,
      jsonb_build_object('response-content-disposition', v_disposition), NULL,
      v_cfg.access_key_id, v_cfg.secret_access_key, v_cfg.region, v_at, 1200);
END;
$$;

COMMENT ON FUNCTION metadata.file_download_url(TEXT, TEXT, TEXT) IS
    'A signed GET URL that downloads the object under the given file name (response-content-disposition attachment, RFC 6266 with a UTF-8 filename*). NULL until the S3 signing config is published. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata.file_download_url(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metadata.file_download_url(TEXT, TEXT, TEXT) TO web_anon, authenticated;

-- A presigned PUT. A public upload signs x-amz-acl: public-read, which the browser must then send.
CREATE FUNCTION metadata._presign_put(p_cfg_bucket TEXT, p_key TEXT, p_public_read BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg RECORD;
  v_ep RECORD;
  v_path TEXT;
BEGIN
  SELECT * INTO v_cfg FROM metadata.s3_signing_config();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_ep FROM metadata._s3_endpoint_parts(v_cfg.public_endpoint);
  v_path := v_ep.path_prefix || '/' || p_cfg_bucket || '/' || p_key;
  RETURN v_ep.origin || metadata.aws_uri_encode(v_path, false) || '?' ||
    metadata._sigv4_presign('PUT', v_ep.host, v_path, NULL,
      CASE WHEN p_public_read THEN '{"x-amz-acl": "public-read"}'::jsonb END,
      v_cfg.access_key_id, v_cfg.secret_access_key, v_cfg.region, pg_catalog.now(), 900);
END;
$$;

COMMENT ON FUNCTION metadata._presign_put(TEXT, TEXT, BOOLEAN) IS
    'A presigned PUT URL (15 minutes) for one object key; signs x-amz-acl: public-read when asked. NULL until the S3 signing config is published. Internal to the upload RPCs. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION metadata._presign_put(TEXT, TEXT, BOOLEAN) FROM PUBLIC;

-- The object key of an upload, the rule the s3_presign worker used:
-- {entity_type}/{entity_id, or _new before the record exists}/{file_id}/original{extension or .bin},
-- where the extension is Go's filepath.Ext of the file name (from the last "." of its last path segment).
CREATE FUNCTION metadata._file_object_key(p_entity_type TEXT, p_entity_id TEXT, p_file_id UUID, p_file_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_entity_type || '/' ||
         CASE WHEN pg_catalog.btrim(COALESCE(p_entity_id, '')) = '' THEN '_new' ELSE p_entity_id END || '/' ||
         p_file_id::TEXT || '/original' ||
         COALESCE(pg_catalog.substring(pg_catalog.regexp_replace(COALESCE(p_file_name, ''), '^.*/', ''), '(\.[^.]*)$'), '.bin')
$$;

REVOKE EXECUTE ON FUNCTION metadata._file_object_key(TEXT, TEXT, UUID, TEXT) FROM PUBLIC;

-- ============================================================================
-- 3b. can_view_entity_record(): a UUID-keyed table raised instead of answering
-- ============================================================================
-- For a table whose id is UUID (static_assets), "id = $1::BIGINT" fails to plan with undefined_function
-- (no uuid = bigint operator), which the v0.39.0 handler did not catch: any caller whose RLS check reached
-- this branch for such a file (everyone but admins, for static assets) got an error instead of a row.
-- The BIGINT attempt now falls through to the UUID one on undefined_function too.

CREATE OR REPLACE FUNCTION metadata.can_view_entity_record(
  p_entity_type TEXT, p_entity_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  -- Guard: entity_type must be a real table in public schema
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = p_entity_type
  ) THEN RETURN FALSE; END IF;

  -- Dynamic SQL: delegates to target table's own RLS
  -- Try BIGINT first (most common PK type), then UUID fallback
  BEGIN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1::BIGINT)', p_entity_type)
      INTO v_exists USING p_entity_id;
    RETURN v_exists;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR undefined_function THEN
    BEGIN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id = $1::UUID)', p_entity_type)
        INTO v_exists USING p_entity_id;
      RETURN v_exists;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN FALSE;
    END;
  END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

-- ============================================================================
-- 4. public.files
-- ============================================================================
-- Explicit columns instead of SELECT *. RLS on metadata.files (security_invoker) decides which rows reach
-- the signers. download_url is computed only when a request selects it (the view is inlined).

DROP VIEW public.files;

CREATE VIEW public.files
WITH (security_invoker = true) AS
SELECT
  f.id,
  f.entity_type,
  f.entity_id,
  f.file_name,
  f.file_type,
  f.file_size,
  f.s3_key_prefix,
  f.s3_original_key,
  f.s3_thumbnail_small_key,
  f.s3_thumbnail_medium_key,
  f.s3_thumbnail_large_key,
  f.thumbnail_status,
  f.thumbnail_error,
  f.created_by,
  f.created_at,
  f.updated_at,
  f.s3_bucket,
  f.property_name,
  f.is_public,
  u.url,
  u.thumb_small_url,
  u.thumb_medium_url,
  u.thumb_large_url,
  metadata.file_download_url(f.s3_bucket, f.s3_original_key, f.file_name) AS download_url
FROM metadata.files f
LEFT JOIN LATERAL metadata.file_urls(
  f.s3_bucket, f.s3_original_key, f.s3_thumbnail_small_key, f.s3_thumbnail_medium_key,
  f.s3_thumbnail_large_key, f.is_public) u ON true;

COMMENT ON VIEW public.files IS
    'Files the caller may see (RLS on metadata.files, security_invoker) with their URLs: url and thumb_*_url are direct for public files and signed (valid at least 15 minutes) otherwise; download_url is signed and downloads under file_name. URLs are NULL until the S3 signing config is published. Read-only: writes go through RPCs. URL columns added in v0.88.0.';

GRANT SELECT ON public.files TO web_anon, authenticated;

-- ============================================================================
-- 5. UPLOADS
-- ============================================================================
-- Every upload is issued by the database and recorded in metadata.file_upload_requests (by user, with
-- its key and bucket); create_file_record() registers only an issued upload, for the same user.

ALTER TABLE metadata.file_upload_requests
  ADD COLUMN requested_by UUID,
  ADD COLUMN s3_bucket TEXT,
  ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_upload_requests_file_id ON metadata.file_upload_requests(file_id);

DROP TRIGGER insert_s3_presign_job_trigger ON metadata.file_upload_requests;
DROP FUNCTION public.insert_s3_presign_job();

-- Jobs queued before the upgrade would wait forever for a worker that no longer runs them.
UPDATE metadata.river_job
SET state = 'cancelled', finalized_at = now()
WHERE kind = 's3_presign' AND state IN ('available', 'scheduled', 'retryable', 'pending');

-- Issues one upload: a new file id, its key and a presigned PUT, recorded for create_file_record().
CREATE FUNCTION metadata._issue_upload(p_entity_type TEXT, p_entity_id TEXT, p_file_name TEXT, p_file_type TEXT,
                                       p_public_read_acl BOOLEAN)
RETURNS metadata.file_upload_requests
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_cfg RECORD;
  v_req metadata.file_upload_requests;
  v_file_id UUID := public.uuid_generate_v7();
  v_key TEXT;
BEGIN
  IF public.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501', HINT = 'Must be logged in to upload files';
  END IF;
  IF p_entity_type IS NULL OR pg_catalog.btrim(p_entity_type) = '' OR p_file_name IS NULL THEN
    RAISE EXCEPTION 'An entity type and a file name are required' USING ERRCODE = '22023';
  END IF;
  -- A public file is world-readable for good: only those who manage static assets may create one.
  IF metadata.file_is_public(p_entity_type)
     AND NOT (public.has_permission('static_assets', 'create') OR public.is_admin()) THEN
    RAISE EXCEPTION 'Not authorized to upload static assets' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cfg FROM metadata.s3_signing_config();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file_storage_not_configured' USING ERRCODE = '55000',
      HINT = 'The consolidated worker publishes the S3 settings when it starts';
  END IF;

  v_key := metadata._file_object_key(p_entity_type, p_entity_id, v_file_id, p_file_name);
  INSERT INTO metadata.file_upload_requests
    (entity_type, entity_id, file_name, file_type, status, presigned_url, s3_key, file_id,
     requested_by, s3_bucket, is_public)
  VALUES
    (p_entity_type, COALESCE(p_entity_id, ''), p_file_name, COALESCE(p_file_type, 'application/octet-stream'),
     'completed', metadata._presign_put(v_cfg.default_bucket, v_key, p_public_read_acl), v_key, v_file_id,
     public.current_user_id(), v_cfg.default_bucket, metadata.file_is_public(p_entity_type))
  RETURNING * INTO v_req;
  RETURN v_req;
END;
$$;

REVOKE EXECUTE ON FUNCTION metadata._issue_upload(TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;

CREATE FUNCTION public.request_file_upload(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_file_name TEXT,
  p_file_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_req metadata.file_upload_requests;
BEGIN
  v_req := metadata._issue_upload(p_entity_type, p_entity_id, p_file_name, p_file_type,
                                  metadata.file_is_public(p_entity_type));
  RETURN jsonb_build_object(
    'url', v_req.presigned_url,
    'file_id', v_req.file_id,
    'bucket', v_req.s3_bucket,
    'key', v_req.s3_key,
    'is_public', v_req.is_public);
END;
$$;

COMMENT ON FUNCTION public.request_file_upload(TEXT, TEXT, TEXT, TEXT) IS
    'Issues one upload synchronously: {url (presigned PUT, 15 minutes), file_id, bucket, key, is_public}. Send x-amz-acl: public-read with the PUT only when is_public is true. Then call create_file_record() with the file_id. Requires a signed-in user; static assets require the static_assets:create permission. Raises file_storage_not_configured (55000) until the S3 signing config is published. Added in v0.88.0.';

REVOKE EXECUTE ON FUNCTION public.request_file_upload(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_file_upload(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Shim for a cached older SPA: same signature, the request completes at once (no worker). The older SPA
-- always sends x-amz-acl: public-read, and S3 refuses an unsigned x-amz-* header, so the shim signs it;
-- privatize-acls makes such objects private again. Removed in a later release.
CREATE OR REPLACE FUNCTION public.request_upload_url(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_file_name TEXT,
  p_file_type TEXT
) RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  RETURN (metadata._issue_upload(p_entity_type, p_entity_id, p_file_name, p_file_type, true)).id;
END;
$$;

COMMENT ON FUNCTION public.request_upload_url(TEXT, TEXT, TEXT, TEXT) IS
    'Deprecated in v0.88.0 (use request_file_upload): kept so an SPA loaded before the upgrade can still upload. The request completes immediately; read it with get_upload_url().';

CREATE OR REPLACE FUNCTION public.get_upload_url(p_request_id UUID)
RETURNS TABLE(status TEXT, url TEXT, file_id UUID, error TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
BEGIN
  IF public.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING HINT = 'Must be logged in to retrieve upload URLs';
  END IF;

  RETURN QUERY
  SELECT fur.status, fur.presigned_url, fur.file_id, fur.error_message
  FROM metadata.file_upload_requests fur
  WHERE fur.id = p_request_id AND fur.requested_by = public.current_user_id();
END;
$$;

COMMENT ON FUNCTION public.get_upload_url(UUID) IS
    'Deprecated in v0.88.0 (request_file_upload returns the URL directly). Returns the caller''s own upload request only.';

-- Registers an upload the database issued to this user. The bucket and key come from the issued request;
-- the client's p_s3_bucket and p_s3_original_key must match them.
CREATE OR REPLACE FUNCTION public.create_file_record(
  p_id UUID,
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_file_name TEXT,
  p_file_type TEXT,
  p_file_size BIGINT,
  p_s3_bucket TEXT,
  p_s3_original_key TEXT,
  p_thumbnail_status TEXT DEFAULT 'not_applicable',
  p_property_name TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
  v_req metadata.file_upload_requests;
  v_result metadata.files;
BEGIN
  SELECT * INTO v_req FROM metadata.file_upload_requests
  WHERE file_id = p_id AND requested_by = public.current_user_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No upload was issued for this file' USING ERRCODE = '42501';
  END IF;
  IF v_req.entity_type IS DISTINCT FROM p_entity_type
     OR v_req.entity_id IS DISTINCT FROM COALESCE(p_entity_id, '')
     OR v_req.s3_bucket IS DISTINCT FROM p_s3_bucket
     OR v_req.s3_key IS DISTINCT FROM p_s3_original_key THEN
    RAISE EXCEPTION 'The file record does not match the upload that was issued' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_permission(v_req.entity_type, 'create') THEN
    RAISE EXCEPTION 'Not authorized to upload files for entity type %', v_req.entity_type
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO metadata.files (
    id, entity_type, entity_id, file_name, file_type, file_size,
    s3_bucket, s3_original_key, thumbnail_status, property_name, is_public
  ) VALUES (
    p_id, v_req.entity_type, v_req.entity_id, p_file_name, p_file_type, p_file_size,
    v_req.s3_bucket, v_req.s3_key, p_thumbnail_status, p_property_name, v_req.is_public
  )
  RETURNING * INTO v_result;

  DELETE FROM metadata.file_upload_requests WHERE id = v_req.id;

  -- The new file with its URLs (the caller created it, so it may read it): the files view's columns.
  RETURN (SELECT pg_catalog.row_to_json(v) FROM public.files v WHERE v.id = v_result.id);
END;
$$;

COMMENT ON FUNCTION public.create_file_record IS
  'Register an uploaded file. Only an upload the database issued to the same user (request_file_upload), with that upload''s entity, bucket and key; is_public follows metadata.file_is_public(). Returns the file as public.files shows it, URLs included. SECURITY DEFINER; created_by set by trigger from JWT. Since v0.39.0; issued uploads only and URLs in the result since v0.88.0.';

NOTIFY pgrst, 'reload schema';

COMMIT;
