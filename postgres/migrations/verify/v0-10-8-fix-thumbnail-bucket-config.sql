-- Verify civic_os:v0-10-8-fix-thumbnail-bucket-config on pg

BEGIN;

-- Verify s3_bucket column exists in metadata.files
SELECT s3_bucket
FROM metadata.files
WHERE FALSE;

-- Verify the column has the correct default
SELECT 1/COUNT(*)
FROM information_schema.columns
WHERE table_schema = 'metadata'
  AND table_name = 'files'
  AND column_name = 's3_bucket'
  AND column_default LIKE '%civic-os-files%';

-- Verify insert_thumbnail_job() function exists (in public schema)
SELECT 1/COUNT(*)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'insert_thumbnail_job';

ROLLBACK;
