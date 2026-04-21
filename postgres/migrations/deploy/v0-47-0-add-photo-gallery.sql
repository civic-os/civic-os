-- Deploy civic_os:v0-47-0-add-photo-gallery to pg
-- requires: v0-46-0-m2m-search-modal

BEGIN;

-- ============================================================================
-- PHOTO GALLERY PROPERTY TYPE (v0.47.0)
-- ============================================================================
-- Purpose: Multi-image galleries with drag-drop reorder and lightbox display.
--
-- Architecture:
--   - photo_galleries: Polymorphic gallery containers (one per entity+property)
--   - photo_gallery_files: Junction table linking galleries to files
--   - photo_gallery_config: Per-column constraints (max images, allowed types)
--
-- Draft workflow:
--   Create page creates a draft gallery (entity_id=NULL), uploads images,
--   then link_gallery_to_entity binds it after the entity is saved.
--   Orphaned drafts are cleaned up by cleanup_draft_galleries().
-- ============================================================================


-- ============================================================================
-- 1. TABLE: metadata.photo_galleries
-- ============================================================================

CREATE TABLE metadata.photo_galleries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    entity_type     NAME NOT NULL,
    entity_id       TEXT,              -- NULLABLE: NULL during Create page draft state
    property_name   NAME NOT NULL,
    created_by      UUID REFERENCES metadata.civic_os_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint for linked galleries (excludes drafts where entity_id IS NULL)
CREATE UNIQUE INDEX idx_pg_entity_unique
    ON metadata.photo_galleries(entity_type, entity_id, property_name)
    WHERE entity_id IS NOT NULL;

-- Lookup by entity
CREATE INDEX idx_pg_entity ON metadata.photo_galleries(entity_type, entity_id);

-- Cleanup query for orphaned drafts
CREATE INDEX idx_pg_drafts ON metadata.photo_galleries(updated_at)
    WHERE entity_id IS NULL;

COMMENT ON TABLE metadata.photo_galleries IS
  'Gallery containers for multi-image properties. Polymorphic: one gallery per entity+property. '
  'Draft galleries (entity_id IS NULL) are created during Create page flow and linked after save. '
  'Added in v0.47.0.';


-- ============================================================================
-- 2. TABLE: metadata.photo_gallery_files
-- ============================================================================

CREATE TABLE metadata.photo_gallery_files (
    gallery_id      UUID NOT NULL REFERENCES metadata.photo_galleries(id) ON DELETE CASCADE,
    file_id         UUID NOT NULL REFERENCES metadata.files(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    caption         TEXT CHECK (caption IS NULL OR length(caption) <= 500),
    alt_text        TEXT CHECK (alt_text IS NULL OR length(alt_text) <= 200),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (gallery_id, file_id)
);

-- Ordered listing within a gallery
CREATE INDEX idx_pgf_gallery ON metadata.photo_gallery_files(gallery_id, sort_order);

-- Reverse lookup: which galleries contain a given file
CREATE INDEX idx_pgf_file ON metadata.photo_gallery_files(file_id);

COMMENT ON TABLE metadata.photo_gallery_files IS
  'Junction table linking galleries to files with sort order and metadata. '
  'Composite PK (gallery_id, file_id) prevents duplicate file entries. '
  'Added in v0.47.0.';


-- ============================================================================
-- 3. TABLE: metadata.photo_gallery_config
-- ============================================================================

CREATE TABLE metadata.photo_gallery_config (
    id              SERIAL PRIMARY KEY,
    table_name      NAME NOT NULL,
    column_name     NAME NOT NULL,
    max_images      INTEGER NOT NULL DEFAULT 20,
    allowed_types   TEXT NOT NULL DEFAULT 'image/*',
    max_file_size   INTEGER,
    UNIQUE(table_name, column_name)
);

COMMENT ON TABLE metadata.photo_gallery_config IS
  'Per-column constraints for photo gallery properties. Controls max images, '
  'allowed MIME types, and max file size per upload. Added in v0.47.0.';


-- ============================================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================================

-- --- photo_galleries ---
ALTER TABLE metadata.photo_galleries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gallery SELECT: tiered visibility" ON metadata.photo_galleries
  FOR SELECT USING (
    is_admin()
    OR created_by = current_user_id()
    OR has_permission(entity_type::text, 'read')
    OR metadata.can_view_entity_record(entity_type::text, entity_id)
  );

CREATE POLICY "Gallery INSERT: entity create or update" ON metadata.photo_galleries
  FOR INSERT WITH CHECK (
    is_admin()
    OR has_permission(entity_type::text, 'update')
    OR has_permission(entity_type::text, 'create')
  );

CREATE POLICY "Gallery UPDATE: owner or entity update" ON metadata.photo_galleries
  FOR UPDATE USING (
    is_admin()
    OR created_by = current_user_id()
    OR has_permission(entity_type::text, 'update')
  );

CREATE POLICY "Gallery DELETE: owner with update or admin" ON metadata.photo_galleries
  FOR DELETE USING (
    (created_by = current_user_id() AND has_permission(entity_type::text, 'update'))
    OR is_admin()
  );

-- --- photo_gallery_files ---
ALTER TABLE metadata.photo_gallery_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gallery files SELECT: via gallery visibility" ON metadata.photo_gallery_files
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM metadata.photo_galleries pg
      WHERE pg.id = gallery_id
        AND (
          is_admin()
          OR pg.created_by = current_user_id()
          OR has_permission(pg.entity_type::text, 'read')
          OR metadata.can_view_entity_record(pg.entity_type::text, pg.entity_id)
        )
    )
  );

CREATE POLICY "Gallery files INSERT: via gallery update" ON metadata.photo_gallery_files
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM metadata.photo_galleries pg
      WHERE pg.id = gallery_id
        AND (
          is_admin()
          OR pg.created_by = current_user_id()
          OR has_permission(pg.entity_type::text, 'update')
        )
    )
  );

CREATE POLICY "Gallery files UPDATE: via gallery update" ON metadata.photo_gallery_files
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM metadata.photo_galleries pg
      WHERE pg.id = gallery_id
        AND (
          is_admin()
          OR pg.created_by = current_user_id()
          OR has_permission(pg.entity_type::text, 'update')
        )
    )
  );

CREATE POLICY "Gallery files DELETE: via gallery update" ON metadata.photo_gallery_files
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM metadata.photo_galleries pg
      WHERE pg.id = gallery_id
        AND (
          is_admin()
          OR pg.created_by = current_user_id()
          OR has_permission(pg.entity_type::text, 'update')
        )
    )
  );

-- --- photo_gallery_config ---
ALTER TABLE metadata.photo_gallery_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gallery config SELECT: public" ON metadata.photo_gallery_config
  FOR SELECT USING (true);

CREATE POLICY "Gallery config INSERT: admin only" ON metadata.photo_gallery_config
  FOR INSERT WITH CHECK (is_admin());

CREATE POLICY "Gallery config UPDATE: admin only" ON metadata.photo_gallery_config
  FOR UPDATE USING (is_admin());

CREATE POLICY "Gallery config DELETE: admin only" ON metadata.photo_gallery_config
  FOR DELETE USING (is_admin());


-- ============================================================================
-- 5. GRANTS
-- ============================================================================

-- photo_galleries
GRANT SELECT ON metadata.photo_galleries TO web_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.photo_galleries TO authenticated;

-- photo_gallery_files
GRANT SELECT ON metadata.photo_gallery_files TO web_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata.photo_gallery_files TO authenticated;

-- photo_gallery_config
GRANT SELECT ON metadata.photo_gallery_config TO web_anon;
GRANT SELECT ON metadata.photo_gallery_config TO authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.photo_gallery_config TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE metadata.photo_gallery_config_id_seq TO authenticated;


-- ============================================================================
-- 6. TRIGGER: Touch gallery updated_at on file changes
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.touch_gallery_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE metadata.photo_galleries SET updated_at = NOW()
  WHERE id = COALESCE(NEW.gallery_id, OLD.gallery_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touch_gallery_updated_at
  AFTER INSERT OR DELETE ON metadata.photo_gallery_files
  FOR EACH ROW EXECUTE FUNCTION metadata.touch_gallery_updated_at();

COMMENT ON FUNCTION metadata.touch_gallery_updated_at() IS
  'Trigger function: updates photo_galleries.updated_at when files are added/removed. '
  'Added in v0.47.0.';


-- ============================================================================
-- 7. RPC: create_draft_gallery
-- Creates a draft gallery (entity_id=NULL) for Create page upload flow.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_draft_gallery(
  p_entity_type NAME,
  p_property_name NAME
) RETURNS UUID AS $$
DECLARE
  v_gallery_id UUID;
BEGIN
  INSERT INTO metadata.photo_galleries (entity_type, entity_id, property_name, created_by)
  VALUES (p_entity_type, NULL, p_property_name, current_user_id())
  RETURNING id INTO v_gallery_id;

  RETURN v_gallery_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.create_draft_gallery(NAME, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_draft_gallery(NAME, NAME) TO authenticated;

COMMENT ON FUNCTION public.create_draft_gallery IS
  'Create a draft photo gallery for Create page flow. Returns gallery_id. '
  'Gallery has entity_id=NULL until linked after entity save. '
  'SECURITY INVOKER: RLS on photo_galleries enforces permission. Added in v0.47.0.';


-- ============================================================================
-- 8. RPC: link_gallery_to_entity
-- Binds a draft gallery to a saved entity and patches the entity FK column.
-- SECURITY INVOKER: RLS on photo_galleries + entity table apply naturally.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.link_gallery_to_entity(
  p_gallery_id UUID,
  p_entity_type NAME,
  p_entity_id TEXT,
  p_column_name NAME
) RETURNS void AS $$
BEGIN
  -- Validate entity_type and column_name exist (allowlist for dynamic SQL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_entity_type::text
      AND column_name = p_column_name::text
  ) THEN
    RAISE EXCEPTION 'Invalid entity type or column: %.%', p_entity_type, p_column_name
      USING ERRCODE = 'P0002';
  END IF;

  -- Update gallery to linked state
  UPDATE metadata.photo_galleries
  SET entity_id = p_entity_id
  WHERE id = p_gallery_id
    AND entity_type = p_entity_type
    AND entity_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gallery not found or already linked'
      USING ERRCODE = 'P0002';
  END IF;

  -- Dynamically patch the entity's FK column to point to this gallery
  -- Cast id to text for comparison since entity_id is TEXT (works for both integer and UUID PKs)
  EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id::text = $2', p_entity_type, p_column_name)
    USING p_gallery_id, p_entity_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.link_gallery_to_entity(UUID, NAME, TEXT, NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_gallery_to_entity(UUID, NAME, TEXT, NAME) TO authenticated;

COMMENT ON FUNCTION public.link_gallery_to_entity IS
  'Bind a draft gallery to a saved entity and patch the entity FK column. '
  'SECURITY INVOKER: RLS on photo_galleries + entity table RLS apply naturally. Added in v0.47.0.';


-- ============================================================================
-- 9. RPC: add_gallery_image
-- Looks up or creates a gallery, validates constraints, inserts junction row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_gallery_image(
  p_entity_type NAME,
  p_entity_id TEXT,
  p_column_name NAME,
  p_file_id UUID,
  p_sort_order INTEGER DEFAULT 0,
  p_caption TEXT DEFAULT NULL,
  p_alt_text TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_gallery_id UUID;
  v_max_images INTEGER;
  v_current_count INTEGER;
  v_file_type TEXT;
BEGIN
  -- Validate entity_type and column_name exist (allowlist for dynamic SQL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_entity_type::text
      AND column_name = p_column_name::text
  ) THEN
    RAISE EXCEPTION 'Invalid entity type or column: %.%', p_entity_type, p_column_name
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate file is an image
  SELECT file_type INTO v_file_type FROM metadata.files WHERE id = p_file_id;
  IF v_file_type IS NULL THEN
    RAISE EXCEPTION 'File not found: %', p_file_id
      USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_file_type LIKE 'image/%' THEN
    RAISE EXCEPTION 'File is not an image: %', v_file_type
      USING ERRCODE = '22023';
  END IF;

  -- Look up or create gallery
  SELECT id INTO v_gallery_id
  FROM metadata.photo_galleries
  WHERE entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND property_name = p_column_name;

  IF v_gallery_id IS NULL THEN
    INSERT INTO metadata.photo_galleries (entity_type, entity_id, property_name, created_by)
    VALUES (p_entity_type, p_entity_id, p_column_name, current_user_id())
    RETURNING id INTO v_gallery_id;

    -- Set the entity's FK column to point to the new gallery
    -- Cast id to text for comparison since entity_id is TEXT (works for both integer and UUID PKs)
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id::text = $2', p_entity_type, p_column_name)
      USING v_gallery_id, p_entity_id;
  END IF;

  -- Validate max_images from config
  SELECT max_images INTO v_max_images
  FROM metadata.photo_gallery_config
  WHERE table_name = p_entity_type AND column_name = p_column_name;

  IF v_max_images IS NOT NULL THEN
    SELECT count(*) INTO v_current_count
    FROM metadata.photo_gallery_files
    WHERE gallery_id = v_gallery_id;

    IF v_current_count >= v_max_images THEN
      RAISE EXCEPTION 'Gallery has reached maximum of % images', v_max_images
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Insert junction row
  INSERT INTO metadata.photo_gallery_files (gallery_id, file_id, sort_order, caption, alt_text)
  VALUES (v_gallery_id, p_file_id, p_sort_order, p_caption, p_alt_text)
  ON CONFLICT (gallery_id, file_id) DO NOTHING;

  RETURN v_gallery_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.add_gallery_image(NAME, TEXT, NAME, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_gallery_image(NAME, TEXT, NAME, UUID, INTEGER, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.add_gallery_image IS
  'Add an image to a gallery (auto-creates gallery if needed). '
  'Updates entity FK column on first image. Validates image type and max_images config. '
  'SECURITY INVOKER: RLS on galleries, junction, entity table, and files all apply naturally. '
  'Returns gallery_id. Added in v0.47.0.';


-- ============================================================================
-- 10. RPC: add_gallery_image_by_id
-- Simpler version for Create page (gallery already exists as draft).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_gallery_image_by_id(
  p_gallery_id UUID,
  p_file_id UUID,
  p_sort_order INTEGER DEFAULT 0,
  p_caption TEXT DEFAULT NULL,
  p_alt_text TEXT DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_entity_type NAME;
  v_property_name NAME;
  v_max_images INTEGER;
  v_current_count INTEGER;
  v_file_type TEXT;
BEGIN
  -- Validate file is an image
  SELECT file_type INTO v_file_type FROM metadata.files WHERE id = p_file_id;
  IF v_file_type IS NULL THEN
    RAISE EXCEPTION 'File not found: %', p_file_id
      USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_file_type LIKE 'image/%' THEN
    RAISE EXCEPTION 'File is not an image: %', v_file_type
      USING ERRCODE = '22023';
  END IF;

  -- Look up gallery metadata for config validation
  SELECT entity_type, property_name
  INTO v_entity_type, v_property_name
  FROM metadata.photo_galleries WHERE id = p_gallery_id;

  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'Gallery not found: %', p_gallery_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate max_images from config
  SELECT max_images INTO v_max_images
  FROM metadata.photo_gallery_config
  WHERE table_name = v_entity_type AND column_name = v_property_name;

  IF v_max_images IS NOT NULL THEN
    SELECT count(*) INTO v_current_count
    FROM metadata.photo_gallery_files WHERE gallery_id = p_gallery_id;

    IF v_current_count >= v_max_images THEN
      RAISE EXCEPTION 'Gallery has reached maximum of % images', v_max_images
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO metadata.photo_gallery_files (gallery_id, file_id, sort_order, caption, alt_text)
  VALUES (p_gallery_id, p_file_id, p_sort_order, p_caption, p_alt_text)
  ON CONFLICT (gallery_id, file_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.add_gallery_image_by_id(UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_gallery_image_by_id(UUID, UUID, INTEGER, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.add_gallery_image_by_id IS
  'Add an image to an existing gallery by ID. Simpler variant for Create page draft flow. '
  'SECURITY INVOKER: RLS on junction table enforces gallery permission. Added in v0.47.0.';


-- ============================================================================
-- 11. RPC: remove_gallery_image
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_gallery_image(
  p_gallery_id UUID,
  p_file_id UUID
) RETURNS void AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  DELETE FROM metadata.photo_gallery_files
  WHERE gallery_id = p_gallery_id AND file_id = p_file_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Gallery image not found or not authorized'
      USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.remove_gallery_image(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_gallery_image(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.remove_gallery_image IS
  'Remove an image from a gallery. '
  'SECURITY INVOKER: RLS on junction table enforces gallery permission. Added in v0.47.0.';


-- ============================================================================
-- 12. RPC: reorder_gallery_images
-- Bulk sort_order update from array position.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reorder_gallery_images(
  p_gallery_id UUID,
  p_file_ids UUID[]
) RETURNS void AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  UPDATE metadata.photo_gallery_files pgf
  SET sort_order = idx.ord - 1
  FROM unnest(p_file_ids) WITH ORDINALITY AS idx(file_id, ord)
  WHERE pgf.gallery_id = p_gallery_id
    AND pgf.file_id = idx.file_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Gallery images not found or not authorized'
      USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.reorder_gallery_images(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_gallery_images(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.reorder_gallery_images IS
  'Bulk update sort_order for gallery images based on array position. '
  'SECURITY INVOKER: RLS on junction table enforces gallery permission. Added in v0.47.0.';


-- ============================================================================
-- 13. RPC: update_gallery_image_meta
-- Update caption and alt_text for a gallery image.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_gallery_image_meta(
  p_gallery_id UUID,
  p_file_id UUID,
  p_caption TEXT,
  p_alt_text TEXT
) RETURNS void AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  UPDATE metadata.photo_gallery_files
  SET caption = p_caption, alt_text = p_alt_text
  WHERE gallery_id = p_gallery_id AND file_id = p_file_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Gallery image not found or not authorized'
      USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.update_gallery_image_meta(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_gallery_image_meta(UUID, UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.update_gallery_image_meta IS
  'Update caption and alt_text for a gallery image. '
  'SECURITY INVOKER: RLS on junction table enforces gallery permission. Added in v0.47.0.';


-- ============================================================================
-- 14. RPC: get_gallery_storage_stats
-- Admin stats: total galleries, images, storage size.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_gallery_storage_stats()
RETURNS JSON AS $$
  SELECT json_build_object(
    'total_galleries', (SELECT count(*) FROM metadata.photo_galleries),
    'total_images', (SELECT count(*) FROM metadata.photo_gallery_files),
    'total_storage_bytes', (
      SELECT COALESCE(sum(f.file_size), 0)
      FROM metadata.photo_gallery_files pgf
      JOIN metadata.files f ON f.id = pgf.file_id
    )
  );
$$ LANGUAGE sql STABLE SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public.get_gallery_storage_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_gallery_storage_stats() TO authenticated;

COMMENT ON FUNCTION public.get_gallery_storage_stats IS
  'Returns JSON with total_galleries, total_images, total_storage_bytes. '
  'SECURITY INVOKER: RLS on gallery tables filters to caller-visible galleries. '
  'Admins see global stats (Tier 1 passes). Added in v0.47.0.';


-- ============================================================================
-- 15. RPC: cleanup_draft_galleries
-- Deletes orphaned drafts older than 12 hours. CASCADE deletes junction rows.
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.cleanup_draft_galleries()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM metadata.photo_galleries
    WHERE entity_id IS NULL
      AND updated_at < NOW() - INTERVAL '12 hours'
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM deleted;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION metadata.cleanup_draft_galleries() FROM PUBLIC;

COMMENT ON FUNCTION metadata.cleanup_draft_galleries IS
  'Delete orphaned draft galleries (entity_id IS NULL, older than 12 hours). '
  'Returns count of deleted galleries. CASCADE deletes junction rows. '
  'Called by consolidated worker daily. Hidden from PostgREST. Added in v0.47.0.';


-- ============================================================================
-- 16. PUBLIC VIEWS for PostgREST access
-- security_invoker=true delegates RLS to calling user.
-- ============================================================================

CREATE VIEW public.photo_galleries WITH (security_invoker = true) AS
SELECT * FROM metadata.photo_galleries;

CREATE VIEW public.photo_gallery_files WITH (security_invoker = true) AS
SELECT * FROM metadata.photo_gallery_files;

CREATE VIEW public.photo_gallery_config WITH (security_invoker = true) AS
SELECT * FROM metadata.photo_gallery_config;

-- Grants on views
GRANT SELECT ON public.photo_galleries TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.photo_galleries TO authenticated;

GRANT SELECT ON public.photo_gallery_files TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.photo_gallery_files TO authenticated;

GRANT SELECT ON public.photo_gallery_config TO web_anon, authenticated;


-- ============================================================================
-- 18. GALLERY ADMIN VIEW
-- Aggregated view for admin file/gallery management page.
-- ============================================================================

CREATE VIEW public.gallery_admin WITH (security_invoker = true) AS
SELECT
    pg.id,
    pg.entity_type,
    pg.entity_id,
    pg.property_name,
    pg.created_by,
    pg.created_at,
    pg.updated_at,
    pg.entity_id IS NOT NULL AS is_linked,
    count(pgf.file_id) AS image_count,
    coalesce(sum(f.file_size), 0) AS total_size
FROM metadata.photo_galleries pg
LEFT JOIN metadata.photo_gallery_files pgf ON pgf.gallery_id = pg.id
LEFT JOIN metadata.files f ON f.id = pgf.file_id
GROUP BY pg.id;

GRANT SELECT ON public.gallery_admin TO authenticated;

COMMENT ON VIEW public.gallery_admin IS
  'Aggregated gallery view for admin page: image count and total size per gallery. '
  'Excluded from schema_entities to avoid sidebar pollution. Added in v0.47.0.';


-- ============================================================================
-- 19. UPDATE schema_entities VIEW
-- Add photo gallery views to the exclusion list so they don't appear
-- in the sidebar or Schema Editor ERD.
-- ============================================================================

CREATE OR REPLACE VIEW public.schema_entities AS
SELECT
    COALESCE(entities.display_name, tables.table_name::text) AS display_name,
    COALESCE(entities.sort_order, 0) AS sort_order,
    entities.description,
    entities.search_fields,
    COALESCE(entities.show_map, false) AS show_map,
    entities.map_property_name,
    tables.table_name,
    has_permission(tables.table_name::text, 'create'::text) AS insert,
    has_permission(tables.table_name::text, 'read'::text) AS "select",
    has_permission(tables.table_name::text, 'update'::text) AS update,
    has_permission(tables.table_name::text, 'delete'::text) AS delete,
    COALESCE(entities.show_calendar, false) AS show_calendar,
    entities.calendar_property_name,
    entities.calendar_color_property,
    entities.payment_initiation_rpc,
    entities.payment_capture_mode,
    COALESCE(entities.enable_notes, false) AS enable_notes,
    COALESCE(entities.supports_recurring, false) AS supports_recurring,
    entities.recurring_property_name,
    (tables.table_type::text = 'VIEW'::text) AS is_view
FROM information_schema.tables
LEFT JOIN metadata.entities ON entities.table_name = tables.table_name::name
WHERE tables.table_schema::name = 'public'::name
  AND tables.table_type::text IN ('BASE TABLE', 'VIEW')
  AND (tables.table_type::text = 'BASE TABLE' OR entities.table_name IS NOT NULL)
  AND NOT (
    tables.table_type::text = 'VIEW' AND (
      tables.table_name::text LIKE 'schema_%'
      OR tables.table_name::text IN (
        'time_slot_series', 'time_slot_instances', 'civic_os_users', 'managed_users',
        'gallery_admin', 'photo_galleries', 'photo_gallery_files', 'photo_gallery_config'
      )
    )
  )
ORDER BY (COALESCE(entities.sort_order, 0)), tables.table_name;

COMMENT ON VIEW public.schema_entities IS
    'Entity metadata view with Virtual Entities support.
     Tables are auto-discovered; VIEWs require explicit metadata.entities entry.
     System views (schema_*, time_slot_*, civic_os_users, managed_users, photo gallery views) are excluded.
     Updated in v0.47.0.';


-- ============================================================================
-- 20. COMPUTED FIELD: gallery_image_count
-- PostgREST computed field exposed as virtual column on photo_galleries VIEW.
-- Used by List pages to show image count badges without fetching all files.
-- ============================================================================

CREATE FUNCTION gallery_image_count(rec photo_galleries)
RETURNS INTEGER AS $$
  SELECT count(*)::integer FROM metadata.photo_gallery_files
  WHERE gallery_id = rec.id;
$$ LANGUAGE SQL STABLE;


-- ============================================================================
-- 21. NOTIFY PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
