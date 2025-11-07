-- Deploy civic_os:v0-10-8-fix-thumbnail-bucket-config to pg
-- requires: v0-10-0-add-river-queue

BEGIN;

-- =============================================================================
-- Fix Thumbnail Bucket Configuration
-- =============================================================================
-- Problem: Thumbnail jobs had hardcoded 'civic-os-files' bucket in trigger,
-- causing "NoSuchBucket" errors in deployments using custom bucket names.
--
-- Solution: Add s3_bucket column to metadata.files and simplify job args to
-- only contain file_id. Worker queries database for all file metadata,
-- making metadata.files the single source of truth.

-- Add s3_bucket column to metadata.files
ALTER TABLE metadata.files
  ADD COLUMN s3_bucket VARCHAR(255) NOT NULL DEFAULT 'civic-os-files';

COMMENT ON COLUMN metadata.files.s3_bucket IS
  'S3 bucket name where this file is stored. Allows per-file bucket configuration for multi-tenant deployments.';

-- Backfill existing files with default bucket
-- (Already done by DEFAULT constraint, but explicit for clarity)
UPDATE metadata.files SET s3_bucket = 'civic-os-files' WHERE s3_bucket IS NULL;

-- Recreate public.files view to include new s3_bucket column
-- PostgreSQL views with SELECT * don't automatically pick up new columns
DROP VIEW IF EXISTS public.files;
CREATE VIEW public.files AS
  SELECT * FROM metadata.files;

-- Restore grants on the view
GRANT SELECT ON public.files TO web_anon, authenticated;
GRANT INSERT, UPDATE ON public.files TO authenticated;

COMMENT ON VIEW public.files IS
  'Public view of file storage metadata. Exposes metadata.files table to PostgREST.';

-- Update insert_thumbnail_job() function to simplify job args
-- Old: Passed file_id, s3_key, file_type, bucket (duplicated data)
-- New: Only passes file_id (worker queries database for metadata)
CREATE OR REPLACE FUNCTION insert_thumbnail_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Only create job if thumbnail_status is 'pending'
    IF NEW.thumbnail_status = 'pending' THEN
        INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts)
        VALUES (
            'thumbnail_generate',
            jsonb_build_object('file_id', NEW.id::text),
            'thumbnails',
            1,
            25
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION insert_thumbnail_job() IS
  'Trigger function to create River job for thumbnail generation. Passes only file_id; worker queries metadata.files for all file details.';

COMMIT;
