-- Verify civic-os:v0-9-0-add-constraint-messages-view on pg

BEGIN;

-- Verify the public.constraint_messages view exists
SELECT 1/COUNT(*)
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'constraint_messages';

-- Verify schema_cache_versions includes constraint_messages row
SELECT 1/COUNT(*)
FROM public.schema_cache_versions
WHERE cache_name = 'constraint_messages';

ROLLBACK;
