-- Verify civic_os:v0-45-0-fk-search-modal on pg

BEGIN;

-- Verify fk_search_modal column exists on metadata.properties
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'properties'
  AND column_name = 'fk_search_modal';

-- Verify VIEW includes fk_search_modal column
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_properties'
  AND column_name = 'fk_search_modal';

-- Verify constraint exists
SELECT 1/COUNT(*) FROM pg_constraint
WHERE conname = 'fk_search_modal_requires_fk';

ROLLBACK;
