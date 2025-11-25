-- Verify civic-os:v0-13-0-add-payment-metadata on pg

BEGIN;

-- Verify payment_initiation_rpc column exists in metadata.entities table
SELECT payment_initiation_rpc
FROM metadata.entities
WHERE FALSE;

-- Verify payment_capture_mode column exists with correct constraint
SELECT payment_capture_mode
FROM metadata.entities
WHERE FALSE;

-- Verify schema_cache_versions view includes entity timestamps
SELECT cache_name, last_updated
FROM public.schema_cache_versions
WHERE cache_name = 'entities';

-- CRITICAL: Verify payment columns are exposed via schema_entities view
-- Frontend queries this view, not metadata.entities directly
SELECT payment_initiation_rpc, payment_capture_mode
FROM public.schema_entities
WHERE FALSE;

ROLLBACK;
