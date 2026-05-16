-- Verify civic_os:v0-53-0-options-filter-column on pg

BEGIN;

-- 1. Verify options_filter_column exists on metadata.properties
SELECT options_filter_column FROM metadata.properties WHERE FALSE;

-- 2. Verify schema_properties VIEW includes options_filter_column
SELECT options_filter_column FROM public.schema_properties WHERE FALSE;

ROLLBACK;
