-- Verify civic_os:v0-9-0-add-time-slot-domain on pg

BEGIN;

-- Verify btree_gist extension exists
SELECT 1/COUNT(*) FROM pg_extension WHERE extname = 'btree_gist';

-- Verify time_slot domain exists
SELECT 1/COUNT(*) FROM pg_type WHERE typname = 'time_slot';

-- Verify calendar metadata columns exist in metadata.entities table
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'entities'
  AND column_name IN ('show_calendar', 'calendar_property_name', 'calendar_color_property');

-- Verify calendar columns are exposed in schema_entities view
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_entities'
  AND column_name IN ('show_calendar', 'calendar_property_name', 'calendar_color_property');

-- Verify CHECK constraint exists
SELECT 1/COUNT(*) FROM information_schema.table_constraints
WHERE constraint_schema = 'metadata' AND table_name = 'entities'
  AND constraint_name = 'calendar_or_map_not_both';

-- Verify upsert_entity_metadata function has been updated with calendar parameters
SELECT 1/COUNT(*) FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'upsert_entity_metadata'
  AND pg_get_function_identity_arguments(p.oid) LIKE '%p_show_calendar%';

ROLLBACK;
