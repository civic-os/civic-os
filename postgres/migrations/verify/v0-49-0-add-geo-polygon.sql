-- Verify civic_os:v0-49-0-add-geo-polygon

BEGIN;

-- map_color_property column exists on metadata.entities
SELECT map_color_property FROM metadata.entities WHERE false;

-- schema_entities VIEW includes map_color_property
SELECT map_color_property FROM public.schema_entities WHERE false;

-- upsert_entity_metadata function exists with new signature (15 params)
SELECT 1/COUNT(*) FROM pg_proc
WHERE proname = 'upsert_entity_metadata'
  AND pronamespace = 'public'::regnamespace
  AND pronargs = 15;

ROLLBACK;
