-- Verify civic_os:v0-58-0-metadata-translations on pg

BEGIN;

-- Verify metadata.t() function exists
SELECT 1/count(*) FROM pg_proc
  JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
  WHERE pg_namespace.nspname = 'metadata' AND pg_proc.proname = 't';

-- Verify schema_entities VIEW exists and returns data
SELECT display_name, description FROM public.schema_entities LIMIT 1;

-- Verify schema_properties VIEW exists and returns data
SELECT display_name, description FROM public.schema_properties LIMIT 1;

-- Verify statuses VIEW exists and returns data
SELECT display_name, description FROM public.statuses LIMIT 1;

-- Verify categories VIEW exists
SELECT display_name, description FROM public.categories LIMIT 0;

-- Verify static_text VIEW exists
SELECT content FROM public.static_text LIMIT 0;

-- Verify schema_entity_actions VIEW exists
SELECT display_name, description FROM public.schema_entity_actions LIMIT 0;

-- Verify schema_guided_form_steps VIEW exists
SELECT display_name, description FROM public.schema_guided_form_steps LIMIT 0;

-- Verify schema_cache_versions includes 'translations' entry
SELECT 1/count(*) FROM public.schema_cache_versions WHERE cache_name = 'translations';

-- Verify missing UI keys were seeded
SELECT 1/count(*) FROM metadata.translations
  WHERE source_type = 'ui' AND source_key = 'action.pay_now' AND locale = 'en';

ROLLBACK;
