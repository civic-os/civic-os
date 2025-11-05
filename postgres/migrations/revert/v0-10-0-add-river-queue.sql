-- Revert civic_os:v0-10-0-add-river-queue from pg

BEGIN;

-- Restore LISTEN/NOTIFY triggers
DROP TRIGGER IF EXISTS insert_s3_presign_job_trigger ON metadata.file_upload_requests;
DROP FUNCTION IF EXISTS insert_s3_presign_job();

DROP TRIGGER IF EXISTS insert_thumbnail_job_trigger ON metadata.files;
DROP FUNCTION IF EXISTS insert_thumbnail_job();

-- Recreate original LISTEN/NOTIFY triggers for S3 Signer
CREATE OR REPLACE FUNCTION notify_upload_url_request()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('upload_url_request', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_upload_url_request
    AFTER INSERT ON metadata.file_upload_requests
    FOR EACH ROW
    EXECUTE FUNCTION notify_upload_url_request();

-- Recreate original LISTEN/NOTIFY triggers for Thumbnail Worker
-- Note: Original trigger from v0-5-0 was named 'file_uploaded_trigger', not 'notify_file_uploaded'
CREATE OR REPLACE FUNCTION notify_file_uploaded()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.thumbnail_status = 'pending' THEN
        PERFORM pg_notify(
            'file_uploaded',
            json_build_object(
                'file_id', NEW.id,
                's3_key', NEW.s3_key,
                'file_type', NEW.file_type
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER file_uploaded_trigger
    AFTER INSERT ON metadata.files
    FOR EACH ROW
    EXECUTE FUNCTION notify_file_uploaded();

-- Drop River tables and types (in reverse dependency order)
DROP INDEX IF EXISTS metadata.river_job_unique_idx;
DROP FUNCTION IF EXISTS metadata.river_job_state_in_bitmask(BIT(8), metadata.river_job_state);

DROP TABLE IF EXISTS metadata.river_client_queue;
DROP TABLE IF EXISTS metadata.river_client;
DROP TABLE IF EXISTS metadata.river_queue;
DROP TABLE IF EXISTS metadata.river_leader;
DROP TABLE IF EXISTS metadata.river_job;
DROP TABLE IF EXISTS metadata.river_migration;

DROP TYPE IF EXISTS metadata.river_job_state;

COMMIT;
