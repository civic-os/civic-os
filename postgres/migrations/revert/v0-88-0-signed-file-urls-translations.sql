-- Revert civic_os:v0-88-0-signed-file-urls-translations

BEGIN;

DELETE FROM metadata.translations WHERE source_type = 'ui' AND source_key = 'file_upload.storage_not_configured';

COMMIT;
