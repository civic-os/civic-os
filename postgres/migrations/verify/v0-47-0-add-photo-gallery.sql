-- Verify civic_os:v0-47-0-add-photo-gallery on pg

BEGIN;

-- Verify photo_galleries table exists
SELECT id, entity_type, entity_id, property_name, created_by, created_at, updated_at
FROM metadata.photo_galleries WHERE FALSE;

-- Verify photo_gallery_files table exists
SELECT gallery_id, file_id, sort_order, caption, alt_text, created_at
FROM metadata.photo_gallery_files WHERE FALSE;

-- Verify photo_gallery_config table exists
SELECT id, table_name, column_name, max_images, allowed_types, max_file_size
FROM metadata.photo_gallery_config WHERE FALSE;

-- Verify key RPCs exist
SELECT has_function_privilege(
  'public.create_draft_gallery(name, name)',
  'execute'
);

SELECT has_function_privilege(
  'public.link_gallery_to_entity(uuid, name, text, name)',
  'execute'
);

SELECT has_function_privilege(
  'public.add_gallery_image(name, text, name, uuid, integer, text, text)',
  'execute'
);

SELECT has_function_privilege(
  'public.add_gallery_image_by_id(uuid, uuid, integer, text, text)',
  'execute'
);

SELECT has_function_privilege(
  'public.remove_gallery_image(uuid, uuid)',
  'execute'
);

SELECT has_function_privilege(
  'public.reorder_gallery_images(uuid, uuid[])',
  'execute'
);

SELECT has_function_privilege(
  'public.update_gallery_image_meta(uuid, uuid, text, text)',
  'execute'
);

SELECT has_function_privilege(
  'public.get_gallery_storage_stats()',
  'execute'
);

-- cleanup_draft_galleries is in metadata schema (hidden from PostgREST)
-- Verify it exists via pg_proc instead of has_function_privilege
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'metadata' AND p.proname = 'cleanup_draft_galleries'
  ) THEN RAISE EXCEPTION 'metadata.cleanup_draft_galleries() does not exist'; END IF;
END $$;

-- Verify public views exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'photo_galleries'
  ) THEN RAISE EXCEPTION 'public.photo_galleries VIEW does not exist'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'photo_gallery_files'
  ) THEN RAISE EXCEPTION 'public.photo_gallery_files VIEW does not exist'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'photo_gallery_config'
  ) THEN RAISE EXCEPTION 'public.photo_gallery_config VIEW does not exist'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'gallery_admin'
  ) THEN RAISE EXCEPTION 'public.gallery_admin VIEW does not exist'; END IF;
END $$;

-- Verify RLS is enabled on all three tables
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'metadata' AND c.relname = 'photo_galleries' AND c.relrowsecurity = true
  ) THEN RAISE EXCEPTION 'RLS not enabled on metadata.photo_galleries'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'metadata' AND c.relname = 'photo_gallery_files' AND c.relrowsecurity = true
  ) THEN RAISE EXCEPTION 'RLS not enabled on metadata.photo_gallery_files'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'metadata' AND c.relname = 'photo_gallery_config' AND c.relrowsecurity = true
  ) THEN RAISE EXCEPTION 'RLS not enabled on metadata.photo_gallery_config'; END IF;
END $$;

-- Verify computed function exists
SELECT has_function_privilege(
  'gallery_image_count(photo_galleries)',
  'execute'
);

-- Verify trigger exists
SELECT 1 FROM pg_trigger
WHERE tgname = 'trg_touch_gallery_updated_at';

-- Verify schema_entities excludes photo gallery views
DO $$
BEGIN
  -- The schema_entities view definition should contain the exclusion list.
  -- We verify by checking the view definition contains the new entries.
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public' AND viewname = 'schema_entities'
      AND definition LIKE '%gallery_admin%'
  ) THEN RAISE EXCEPTION 'schema_entities VIEW does not exclude gallery_admin'; END IF;
END $$;

ROLLBACK;
