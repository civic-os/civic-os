-- Verify civic_os:v0-51-0-rich-junction-m2m on pg

BEGIN;

-- Verify the column exists on metadata.entities
SELECT is_rich_junction FROM metadata.entities LIMIT 0;

-- Verify schema_entities VIEW exposes it
SELECT is_rich_junction FROM public.schema_entities LIMIT 0;

ROLLBACK;
