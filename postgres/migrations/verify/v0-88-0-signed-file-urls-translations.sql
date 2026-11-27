-- Verify civic_os:v0-88-0-signed-file-urls-translations

BEGIN;

SELECT 1 / (CASE WHEN COUNT(*) = 6 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui' AND source_key = 'file_upload.storage_not_configured';

ROLLBACK;
