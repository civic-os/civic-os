-- Revert civic_os:v0-88-0-instance-secrets-translations
-- Deletes the UI strings this change seeded.

BEGIN;

DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND (source_key LIKE 'admin_config.secret.%' OR source_key = 'a11y.admin_config.secret_clear');

COMMIT;
