-- Verify civic_os:v0-46-0-m2m-search-modal on pg

BEGIN;

-- Verify show_inline column exists on metadata.properties
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'properties'
  AND column_name = 'show_inline';

-- Verify VIEW includes show_inline column
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_properties'
  AND column_name = 'show_inline';

-- Verify constraint exists
SELECT 1/COUNT(*) FROM pg_constraint
WHERE conname = 'show_inline_requires_m2m';

-- Verify schema_m2m_properties VIEW exists
SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'schema_m2m_properties';

ROLLBACK;
