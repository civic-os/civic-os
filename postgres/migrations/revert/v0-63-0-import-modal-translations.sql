-- Revert civic_os:v0-63-0-import-modal-translations from pg

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key LIKE 'import_modal.%';

COMMIT;
