-- Verify civic_os:v0-5-0-add-file-storage on pg

BEGIN;

-- Verify UUIDv7 function exists and works
DO $$
DECLARE
  v_uuid UUID;
BEGIN
  SELECT uuid_generate_v7() INTO v_uuid;
  ASSERT v_uuid IS NOT NULL, 'uuid_generate_v7() should return a UUID';
END $$;

-- Verify files table exists with correct structure
SELECT id, entity_type, entity_id, file_name, file_type, file_size,
       s3_key_prefix, s3_original_key, s3_thumbnail_small_key,
       s3_thumbnail_medium_key, s3_thumbnail_large_key,
       thumbnail_status, thumbnail_error, created_by, created_at, updated_at
FROM metadata.files
WHERE FALSE;

-- Verify files table indexes
SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'files' AND indexname = 'idx_files_entity';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'files' AND indexname = 'idx_files_pending';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'files' AND indexname = 'idx_files_created';

-- Verify RLS is enabled
SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'files' AND rowsecurity = true;

-- Verify file_upload_requests table exists
SELECT id, entity_type, entity_id, file_name, file_type,
       status, presigned_url, s3_key, file_id, error_message, created_at
FROM metadata.file_upload_requests
WHERE FALSE;

-- Verify functions exist
SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'uuid_generate_v7';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'request_upload_url';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'get_upload_url';

-- notify_file_uploaded() and file_uploaded_trigger were replaced by River jobs in
-- v0-10-0-add-river-queue, so they are intentionally not asserted here.

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'set_file_created_by';

-- Verify triggers exist
SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'set_file_created_by_trigger';

-- Verify public.files view exists
SELECT 1/(COUNT(*))::int FROM pg_views
WHERE schemaname = 'public' AND viewname = 'files';

-- Test UUIDv7 generates time-ordered IDs
DO $$
DECLARE
  v_uuid1 UUID;
  v_uuid2 UUID;
BEGIN
  SELECT uuid_generate_v7() INTO v_uuid1;
  PERFORM pg_sleep(0.001);  -- 1ms delay
  SELECT uuid_generate_v7() INTO v_uuid2;
  ASSERT v_uuid2 > v_uuid1, 'UUIDv7 should be time-ordered';
END $$;

ROLLBACK;
