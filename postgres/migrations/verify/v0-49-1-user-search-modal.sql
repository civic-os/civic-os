-- Verify civic_os:v0-49-1-user-search-modal

BEGIN;

-- civic_os_text_search column exists on civic_os_users VIEW
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'civic_os_users'
  AND column_name = 'civic_os_text_search';

ROLLBACK;
