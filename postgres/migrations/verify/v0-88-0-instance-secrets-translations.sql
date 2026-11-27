-- Verify civic_os:v0-88-0-instance-secrets-translations

BEGIN;

SELECT 1 / (CASE WHEN COUNT(*) = 48 THEN 1 ELSE 0 END) FROM metadata.translations
WHERE source_type = 'ui'
  AND (source_key LIKE 'admin_config.secret.%' OR source_key = 'a11y.admin_config.secret_clear');

ROLLBACK;
