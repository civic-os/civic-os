-- Verify civic_os:v0-49-0-add-geo-polygon

BEGIN;

-- map_color_property column exists on metadata.entities
SELECT map_color_property FROM metadata.entities WHERE false;

-- schema_entities VIEW includes map_color_property
SELECT map_color_property FROM public.schema_entities WHERE false;

-- upsert_entity_metadata exists and accepts at least the 15 parameters added here
-- (later migrations append more, so a minimum is asserted rather than an exact count)
SELECT 1/COUNT(*) FROM pg_proc
WHERE proname = 'upsert_entity_metadata'
  AND pronamespace = 'public'::regnamespace
  AND pronargs >= 15;

ROLLBACK;
