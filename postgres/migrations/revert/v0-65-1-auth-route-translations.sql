-- Revert civic_os:v0-65-1-auth-route-translations from pg

BEGIN;

-- Revert translations
DELETE FROM metadata.translations
WHERE source_type = 'ui'
  AND source_key = 'nav.redirecting';

COMMIT;
