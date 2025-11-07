-- Revert civic_os:v0-10-8-fix-thumbnail-bucket-config from pg

BEGIN;

-- Restore insert_thumbnail_job() to previous version with hardcoded bucket
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
            jsonb_build_object(
                'file_id', NEW.id::text,
                's3_key', NEW.s3_original_key,
                'file_type', NEW.file_type,
                'bucket', 'civic-os-files'
            ),
            'thumbnails',
            1,
            25
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate public.files view to exclude s3_bucket column (before dropping column)
-- This prevents dependency errors when dropping the column
DROP VIEW IF EXISTS public.files;
CREATE VIEW public.files AS
  SELECT * FROM metadata.files;

-- Restore grants on the view
GRANT SELECT ON public.files TO web_anon, authenticated;
GRANT INSERT, UPDATE ON public.files TO authenticated;

COMMENT ON VIEW public.files IS
  'Public view of file storage metadata. Exposes metadata.files table to PostgREST.';

-- Remove s3_bucket column from metadata.files
ALTER TABLE metadata.files DROP COLUMN IF EXISTS s3_bucket;

COMMIT;
