-- Revert civic_os:v0-88-0-signed-file-urls from pg
--
-- Restores the worker-signed upload flow (request row -> s3_presign job), the v0.76.5 upload RPCs, the
-- v0.39.0 create_file_record() and the SELECT * public.files view; drops the signers and the is_public
-- columns. Uploads need a v0.87 worker (with the s3_presign job) after this revert.

BEGIN;

-- Re-created at the end, after is_public is gone (SELECT * would capture it).
DROP VIEW public.files;

DROP FUNCTION public.request_file_upload(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION request_upload_url(
  p_entity_type text,
  p_entity_id text,
  p_file_name text,
  p_file_type text
) RETURNS uuid AS $$
DECLARE
  v_request_id UUID;
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to request upload URLs';
  END IF;

  INSERT INTO metadata.file_upload_requests (entity_type, entity_id, file_name, file_type)
  VALUES (p_entity_type, p_entity_id, p_file_name, p_file_type)
  RETURNING id INTO v_request_id;

  PERFORM pg_notify(
    'upload_url_request',
    json_build_object(
      'requestId', v_request_id,
      'fileName', p_file_name,
      'fileType', p_file_type,
      'entityType', p_entity_type,
      'entityId', p_entity_id
    )::text
  );

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


REVOKE EXECUTE ON FUNCTION request_upload_url(text, text, text, text) FROM PUBLIC;
COMMENT ON FUNCTION request_upload_url(text, text, text, text) IS NULL;

CREATE OR REPLACE FUNCTION get_upload_url(p_request_id uuid)
RETURNS TABLE(status text, url text, file_id uuid, error text) AS $$
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to retrieve upload URLs';
  END IF;

  RETURN QUERY
  SELECT fur.status, fur.presigned_url, fur.file_id, fur.error_message
  FROM metadata.file_upload_requests fur
  WHERE fur.id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


REVOKE EXECUTE ON FUNCTION get_upload_url(uuid) FROM PUBLIC;
COMMENT ON FUNCTION get_upload_url(uuid) IS NULL;

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
) RETURNS json AS $$
DECLARE
  v_result metadata.files;
BEGIN
  -- Validate caller has create permission on the target entity type
  IF NOT has_permission(p_entity_type, 'create') THEN
    RAISE EXCEPTION 'Not authorized to upload files for entity type %', p_entity_type
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO metadata.files (
    id, entity_type, entity_id, file_name, file_type, file_size,
    s3_bucket, s3_original_key, thumbnail_status, property_name
  ) VALUES (
    p_id, p_entity_type, p_entity_id, p_file_name, p_file_type, p_file_size,
    p_s3_bucket, p_s3_original_key, p_thumbnail_status, p_property_name
  )
  RETURNING * INTO v_result;

  RETURN row_to_json(v_result);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER;

-- PostgreSQL grants EXECUTE to PUBLIC by default — revoke before granting to authenticated only
REVOKE EXECUTE ON FUNCTION public.create_file_record(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_file_record(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.create_file_record IS
  'Create a file record after S3 upload. SECURITY DEFINER; created_by set by trigger from JWT (v0.39.0)';


CREATE OR REPLACE FUNCTION insert_s3_presign_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts)
    VALUES (
        's3_presign',
        jsonb_build_object(
            'request_id', NEW.id::text,
            'file_name', NEW.file_name,
            'file_type', NEW.file_type,
            'entity_type', NEW.entity_type,
            'entity_id', NEW.entity_id::text
        ),
        's3_signer',
        1,
        25
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insert_s3_presign_job_trigger
    AFTER INSERT ON metadata.file_upload_requests
    FOR EACH ROW
    EXECUTE FUNCTION insert_s3_presign_job();


REVOKE EXECUTE ON FUNCTION insert_s3_presign_job() FROM PUBLIC;

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
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
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

DROP FUNCTION metadata._issue_upload(TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION metadata._file_object_key(TEXT, TEXT, UUID, TEXT);
DROP FUNCTION metadata._presign_put(TEXT, TEXT, BOOLEAN);
DROP FUNCTION metadata.file_download_url(TEXT, TEXT, TEXT);
DROP FUNCTION metadata.file_urls(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION metadata._s3_endpoint_parts(TEXT);
DROP FUNCTION metadata._sigv4_presign(TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION metadata.aws_uri_encode(TEXT, BOOLEAN);
DROP FUNCTION metadata._hmac_sha256(BYTEA, BYTEA);
ALTER FUNCTION public.uuid_generate_v7() RESET search_path;

DROP INDEX metadata.idx_upload_requests_file_id;
ALTER TABLE metadata.file_upload_requests
  DROP COLUMN is_public,
  DROP COLUMN s3_bucket,
  DROP COLUMN requested_by;

ALTER TABLE metadata.files DROP COLUMN is_public;
DROP FUNCTION metadata.file_is_public(TEXT);

CREATE VIEW public.files
  WITH (security_invoker = true)
  AS SELECT * FROM metadata.files;
GRANT SELECT ON public.files TO web_anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
