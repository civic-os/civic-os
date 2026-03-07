-- Verify civic_os:v0-34-0-add-type-system on pg

BEGIN;

-- ============================================================================
-- 1. Verify type_categories table structure
-- ============================================================================
SELECT entity_type, description, created_at, updated_at
FROM metadata.type_categories
WHERE FALSE;

-- ============================================================================
-- 2. Verify types table structure
-- ============================================================================
SELECT id, entity_type, display_name, description, color, sort_order, type_key, created_at, updated_at
FROM metadata.types
WHERE FALSE;

-- ============================================================================
-- 3. Verify indexes exist
-- ============================================================================
SELECT 1 FROM pg_indexes WHERE indexname = 'idx_types_entity_type';
SELECT 1 FROM pg_indexes WHERE indexname = 'idx_types_entity_sort';

-- ============================================================================
-- 4. Verify unique constraints
-- ============================================================================
SELECT 1 FROM pg_constraint WHERE conname = 'types_entity_type_display_name_key';
SELECT 1 FROM pg_constraint WHERE conname = 'types_entity_type_type_key_key';

-- ============================================================================
-- 5. Verify functions exist
-- ============================================================================
SELECT 1 FROM pg_proc WHERE proname = 'get_type_id' AND pronargs = 2;
SELECT 1 FROM pg_proc WHERE proname = 'get_types_for_entity' AND pronargs = 1;
SELECT 1 FROM pg_proc WHERE proname = 'validate_type_entity_type';
SELECT 1 FROM pg_proc WHERE proname = 'set_type_key' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'metadata');

-- ============================================================================
-- 6. Verify RLS is enabled
-- ============================================================================
SELECT 1 FROM pg_tables WHERE tablename = 'type_categories' AND schemaname = 'metadata' AND rowsecurity = true;
SELECT 1 FROM pg_tables WHERE tablename = 'types' AND schemaname = 'metadata' AND rowsecurity = true;

-- ============================================================================
-- 7. Verify RLS policies exist
-- ============================================================================
SELECT 1 FROM pg_policies WHERE policyname = 'type_categories_select' AND tablename = 'type_categories';
SELECT 1 FROM pg_policies WHERE policyname = 'type_categories_insert' AND tablename = 'type_categories';
SELECT 1 FROM pg_policies WHERE policyname = 'type_categories_update' AND tablename = 'type_categories';
SELECT 1 FROM pg_policies WHERE policyname = 'type_categories_delete' AND tablename = 'type_categories';
SELECT 1 FROM pg_policies WHERE policyname = 'types_select' AND tablename = 'types';
SELECT 1 FROM pg_policies WHERE policyname = 'types_insert' AND tablename = 'types';
SELECT 1 FROM pg_policies WHERE policyname = 'types_update' AND tablename = 'types';
SELECT 1 FROM pg_policies WHERE policyname = 'types_delete' AND tablename = 'types';

-- ============================================================================
-- 8. Verify metadata.properties has type_entity_type column
-- ============================================================================
SELECT type_entity_type FROM metadata.properties WHERE FALSE;

-- ============================================================================
-- 9. Verify schema_properties view includes type_entity_type
-- ============================================================================
SELECT type_entity_type FROM public.schema_properties WHERE FALSE;

-- ============================================================================
-- 10. Verify public.types view exists
-- ============================================================================
SELECT id, entity_type, type_key, display_name, color FROM public.types WHERE FALSE;

-- ============================================================================
-- 11. Verify schema_cache_versions includes types cache entry
-- ============================================================================
SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'types';

ROLLBACK;
