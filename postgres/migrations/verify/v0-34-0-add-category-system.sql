-- Verify civic_os:v0-34-0-add-category-system on pg

BEGIN;

-- ============================================================================
-- 1. Verify category_groups table structure
-- ============================================================================
SELECT entity_type, description, created_at, updated_at
FROM metadata.category_groups
WHERE FALSE;

-- ============================================================================
-- 2. Verify categories table structure
-- ============================================================================
SELECT id, entity_type, display_name, description, color, sort_order, category_key, created_at, updated_at
FROM metadata.categories
WHERE FALSE;

-- ============================================================================
-- 3. Verify indexes exist
-- ============================================================================
SELECT 1 FROM pg_indexes WHERE indexname = 'idx_categories_entity_type';
SELECT 1 FROM pg_indexes WHERE indexname = 'idx_categories_entity_sort';

-- ============================================================================
-- 4. Verify unique constraints
-- ============================================================================
SELECT 1 FROM pg_constraint WHERE conname = 'categories_entity_type_display_name_key';
SELECT 1 FROM pg_constraint WHERE conname = 'categories_entity_type_category_key_key';

-- ============================================================================
-- 5. Verify functions exist
-- ============================================================================
SELECT 1 FROM pg_proc WHERE proname = 'get_category_id' AND pronargs = 2;
SELECT 1 FROM pg_proc WHERE proname = 'get_categories_for_entity' AND pronargs = 1;
SELECT 1 FROM pg_proc WHERE proname = 'validate_category_entity_type';
SELECT 1 FROM pg_proc WHERE proname = 'set_category_key' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'metadata');

-- ============================================================================
-- 6. Verify RLS is enabled
-- ============================================================================
SELECT 1 FROM pg_tables WHERE tablename = 'category_groups' AND schemaname = 'metadata' AND rowsecurity = true;
SELECT 1 FROM pg_tables WHERE tablename = 'categories' AND schemaname = 'metadata' AND rowsecurity = true;

-- ============================================================================
-- 7. Verify RLS policies exist
-- ============================================================================
SELECT 1 FROM pg_policies WHERE policyname = 'category_groups_select' AND tablename = 'category_groups';
SELECT 1 FROM pg_policies WHERE policyname = 'category_groups_insert' AND tablename = 'category_groups';
SELECT 1 FROM pg_policies WHERE policyname = 'category_groups_update' AND tablename = 'category_groups';
SELECT 1 FROM pg_policies WHERE policyname = 'category_groups_delete' AND tablename = 'category_groups';
SELECT 1 FROM pg_policies WHERE policyname = 'categories_select' AND tablename = 'categories';
SELECT 1 FROM pg_policies WHERE policyname = 'categories_insert' AND tablename = 'categories';
SELECT 1 FROM pg_policies WHERE policyname = 'categories_update' AND tablename = 'categories';
SELECT 1 FROM pg_policies WHERE policyname = 'categories_delete' AND tablename = 'categories';

-- ============================================================================
-- 8. Verify metadata.properties has category_entity_type column
-- ============================================================================
SELECT category_entity_type FROM metadata.properties WHERE FALSE;

-- ============================================================================
-- 9. Verify schema_properties view includes category_entity_type
-- ============================================================================
SELECT category_entity_type FROM public.schema_properties WHERE FALSE;

-- ============================================================================
-- 10. Verify public.categories view exists
-- ============================================================================
SELECT id, entity_type, category_key, display_name, color FROM public.categories WHERE FALSE;

-- ============================================================================
-- 11. Verify schema_cache_versions includes categories cache entry
-- ============================================================================
SELECT 1 FROM public.schema_cache_versions WHERE cache_name = 'categories';

ROLLBACK;
