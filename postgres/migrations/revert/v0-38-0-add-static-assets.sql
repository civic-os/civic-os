-- Revert civic_os:v0-38-0-add-static-assets from pg

BEGIN;

-- Drop helper function
DROP FUNCTION IF EXISTS public.get_static_asset_id(TEXT);

-- Drop public view
DROP VIEW IF EXISTS public.static_assets CASCADE;

-- Drop triggers and functions
DROP TRIGGER IF EXISTS trg_static_assets_set_created_by ON metadata.static_assets;
DROP FUNCTION IF EXISTS metadata.set_static_asset_created_by();

DROP TRIGGER IF EXISTS set_static_assets_updated_at ON metadata.static_assets;

DROP TRIGGER IF EXISTS trg_static_assets_set_slug ON metadata.static_assets;
DROP FUNCTION IF EXISTS metadata.set_static_asset_slug();

-- Drop table (CASCADE removes RLS policies and indexes)
DROP TABLE IF EXISTS metadata.static_assets CASCADE;

-- Remove widget type
DELETE FROM metadata.widget_types WHERE widget_type = 'image';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
