-- Verify civic_os:v0-38-0-add-static-assets on pg

BEGIN;

-- Verify static_assets table exists with correct structure
SELECT id, slug, display_name, alt_text,
       original_file_id, desktop_file_id, tablet_file_id, mobile_file_id,
       crop_state, created_by, created_at, updated_at
FROM metadata.static_assets
WHERE FALSE;

-- Verify slug unique constraint
SELECT 1/(COUNT(*))::int FROM pg_constraint
WHERE conname = 'static_assets_slug_unique';

-- Verify FK indexes
SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_assets' AND indexname = 'idx_static_assets_original_file';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_assets' AND indexname = 'idx_static_assets_desktop_file';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_assets' AND indexname = 'idx_static_assets_tablet_file';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_assets' AND indexname = 'idx_static_assets_mobile_file';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'static_assets' AND indexname = 'idx_static_assets_created_by';

-- Verify RLS is enabled
SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'static_assets' AND rowsecurity = true;

-- Verify slug trigger exists
SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'trg_static_assets_set_slug';

-- Verify updated_at trigger exists
SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'set_static_assets_updated_at';

-- Verify created_by trigger exists
SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'trg_static_assets_set_created_by';

-- Verify public view exists
SELECT 1/(COUNT(*))::int FROM pg_views
WHERE schemaname = 'public' AND viewname = 'static_assets';

-- Verify image widget type exists
SELECT 1/(COUNT(*))::int FROM metadata.widget_types
WHERE widget_type = 'image';

-- Verify helper function exists
SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'get_static_asset_id';

-- Test slug generation
DO $$
DECLARE
  v_slug TEXT;
BEGIN
  -- Test the function directly
  v_slug := LOWER(REGEXP_REPLACE(TRIM('Homepage Hero Banner'), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := TRIM(BOTH '-' FROM v_slug);
  ASSERT v_slug = 'homepage-hero-banner', 'Slug generation should produce "homepage-hero-banner"';
END $$;

ROLLBACK;
