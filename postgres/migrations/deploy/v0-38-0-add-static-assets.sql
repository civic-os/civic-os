-- Deploy civic_os:v0-38-0-add-static-assets to pg
-- requires: v0-37-0-fix-sms-preference-trigger

BEGIN;

-- ============================================================================
-- STATIC ASSETS: IMAGE UPLOAD WITH RESPONSIVE BREAKPOINT CROPS
-- ============================================================================
-- Version: v0.38.0
-- Purpose: Add static asset management for dashboard image widgets.
--          Supports art-directed responsive images: admins upload one image
--          and crop it to 3 breakpoints (desktop, tablet, mobile). Each crop
--          is stored as a separate file in metadata.files, with the original
--          preserved for re-cropping. The image widget uses <picture>/<source>
--          for breakpoint-aware display.
--
-- Architecture:
--   metadata.static_assets  →  metadata.files (4 FKs: original + 3 crops)
--   metadata.widget_types   →  'image' widget type for dashboards
--   Admin page              →  /admin/static-assets (list, create, re-crop, delete)
-- ============================================================================


-- ============================================================================
-- 1. CREATE metadata.static_assets TABLE
-- ============================================================================

CREATE TABLE metadata.static_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),

  -- Immutable slug for stable references in widget config JSONB.
  -- Auto-generated from display_name on INSERT (trigger below).
  -- Matches role_key/status_key pattern: immutable programmatic identifier.
  slug VARCHAR(100) NOT NULL,

  -- Human-readable name (freely editable, unlike slug)
  display_name VARCHAR(200) NOT NULL,

  -- Alt text for accessibility (<img alt="...">)
  alt_text TEXT,

  -- Original uploaded image (preserved for re-cropping)
  original_file_id UUID NOT NULL REFERENCES metadata.files(id),

  -- Art-directed crops for responsive breakpoints.
  -- Each is a separate cropped image uploaded to metadata.files.
  -- NULL = crop not yet created for this breakpoint.
  desktop_file_id UUID REFERENCES metadata.files(id),
  tablet_file_id UUID REFERENCES metadata.files(id),
  mobile_file_id UUID REFERENCES metadata.files(id),

  -- Crop coordinates for re-edit (restored in crop UI).
  -- Structure: {
  --   "desktop": {"x": 0, "y": 50, "width": 1920, "height": 1080, "ratio": 1.778},
  --   "tablet":  {"x": 100, "y": 0, "width": 1200, "height": 900, "ratio": 1.333},
  --   "mobile":  {"x": 200, "y": 0, "width": 800, "height": 800, "ratio": 1.0}
  -- }
  crop_state JSONB,

  -- Audit
  created_by UUID REFERENCES metadata.civic_os_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on slug for stable widget config references
ALTER TABLE metadata.static_assets
  ADD CONSTRAINT static_assets_slug_unique UNIQUE (slug);

COMMENT ON TABLE metadata.static_assets IS
  'Static image assets for dashboard widgets with art-directed responsive crops.
   Each asset stores the original image plus up to 3 breakpoint-specific crops
   (desktop, tablet, mobile). Crop coordinates are preserved for re-editing.
   Added in v0.38.0.';

COMMENT ON COLUMN metadata.static_assets.slug IS
  'Stable, URL-safe identifier for referencing in widget config JSONB.
   Auto-generated from display_name on insert. Immutable once set.
   Convention: lowercase, hyphens, no spaces (e.g., homepage-hero).
   Referenced in dashboard widget config as {"static_asset": "slug-here"}.';

COMMENT ON COLUMN metadata.static_assets.original_file_id IS
  'The original uploaded image, preserved for re-cropping. Never displayed directly
   in the widget — only the breakpoint crops are used for display.';

COMMENT ON COLUMN metadata.static_assets.crop_state IS
  'Crop coordinates per breakpoint for re-edit state. Stored as JSONB with keys
   "desktop", "tablet", "mobile", each containing {x, y, width, height, ratio}.
   Allows the admin to return to the crop UI and see their previous selections.';


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- FK indexes (PostgreSQL does NOT auto-index FKs)
CREATE INDEX idx_static_assets_original_file ON metadata.static_assets(original_file_id);
CREATE INDEX idx_static_assets_desktop_file ON metadata.static_assets(desktop_file_id);
CREATE INDEX idx_static_assets_tablet_file ON metadata.static_assets(tablet_file_id);
CREATE INDEX idx_static_assets_mobile_file ON metadata.static_assets(mobile_file_id);
CREATE INDEX idx_static_assets_created_by ON metadata.static_assets(created_by);

-- Lookup by slug (covered by UNIQUE constraint, but explicit for clarity)
-- The UNIQUE constraint already creates an index, so no additional index needed.


-- ============================================================================
-- 3. SLUG AUTO-GENERATION TRIGGER (INSERT-ONLY = IMMUTABLE)
-- ============================================================================
-- Matches the role_key/status_key pattern: auto-generate on insert, immutable after.
-- Uses hyphens (URL-safe slug) rather than underscores (code identifier).

CREATE OR REPLACE FUNCTION metadata.set_static_asset_slug()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-generate if slug is NULL or empty
  IF NEW.slug IS NULL OR TRIM(NEW.slug) = '' THEN
    NEW.slug := LOWER(REGEXP_REPLACE(TRIM(NEW.display_name), '[^a-zA-Z0-9]+', '-', 'g'));
    -- Trim leading/trailing hyphens
    NEW.slug := TRIM(BOTH '-' FROM NEW.slug);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_static_assets_set_slug ON metadata.static_assets;
CREATE TRIGGER trg_static_assets_set_slug
  BEFORE INSERT ON metadata.static_assets
  FOR EACH ROW EXECUTE FUNCTION metadata.set_static_asset_slug();

COMMENT ON FUNCTION metadata.set_static_asset_slug() IS
  'Auto-generates slug from display_name if not provided on INSERT.
   INSERT-only trigger ensures immutability. Converts to URL-safe slug:
   "Homepage Hero Banner" → "homepage-hero-banner"';


-- ============================================================================
-- 4. UPDATED_AT TRIGGER
-- ============================================================================

CREATE TRIGGER set_static_assets_updated_at
  BEFORE UPDATE ON metadata.static_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- 5. CREATED_BY AUTO-SET TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION metadata.set_static_asset_created_by()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := public.current_user_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_static_assets_set_created_by
  BEFORE INSERT ON metadata.static_assets
  FOR EACH ROW EXECUTE FUNCTION metadata.set_static_asset_created_by();


-- ============================================================================
-- 6. ROW LEVEL SECURITY (RBAC via has_permission)
-- ============================================================================
-- Uses the standard RBAC pattern (like payments, user management) instead of
-- hardcoded is_admin(). This allows integrators to grant static asset
-- management to non-admin roles (e.g., "content editor").

ALTER TABLE metadata.static_assets ENABLE ROW LEVEL SECURITY;

-- Anyone can view static assets (they're displayed on public dashboards)
CREATE POLICY "Anyone can view static assets"
  ON metadata.static_assets
  FOR SELECT
  USING (true);

-- Permission-based create/update/delete
CREATE POLICY "Permitted roles can create static assets"
  ON metadata.static_assets
  FOR INSERT
  WITH CHECK (metadata.has_permission('static_assets', 'create') OR public.is_admin());

CREATE POLICY "Permitted roles can update static assets"
  ON metadata.static_assets
  FOR UPDATE
  USING (metadata.has_permission('static_assets', 'update') OR public.is_admin());

CREATE POLICY "Permitted roles can delete static assets"
  ON metadata.static_assets
  FOR DELETE
  USING (metadata.has_permission('static_assets', 'delete') OR public.is_admin());


-- ============================================================================
-- 7. GRANTS
-- ============================================================================

-- The plugins schema contains pgcrypto (gen_random_bytes) which is called by
-- uuid_generate_v7(). These roles already have plugins in their search_path
-- but need USAGE to actually resolve functions in it. Without this, direct
-- PostgREST inserts fail because the UUID default can't execute.
-- (Other tables using uuid_generate_v7 work via SECURITY DEFINER RPCs.)
GRANT USAGE ON SCHEMA plugins TO web_anon, authenticated;

GRANT SELECT ON metadata.static_assets TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON metadata.static_assets TO authenticated;


-- ============================================================================
-- 8. PUBLIC VIEW FOR POSTGREST API
-- ============================================================================

CREATE VIEW public.static_assets
WITH (security_invoker = true) AS
SELECT * FROM metadata.static_assets;

COMMENT ON VIEW public.static_assets IS
  'Public API view for static assets. Actual data stored in metadata.static_assets.
   Uses security_invoker to evaluate RLS policies as the calling user.
   Added in v0.38.0.';

GRANT SELECT ON public.static_assets TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.static_assets TO authenticated;


-- ============================================================================
-- 9. REGISTER 'image' WIDGET TYPE
-- ============================================================================

INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'image',
  'Static Image',
  'Display a static image asset with art-directed responsive crops for desktop, tablet, and mobile breakpoints',
  'image',
  TRUE
)
ON CONFLICT (widget_type) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  icon_name = EXCLUDED.icon_name,
  is_active = EXCLUDED.is_active;


-- ============================================================================
-- 10. HELPER FUNCTION: get_static_asset_id(slug)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_static_asset_id(p_slug TEXT)
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT id FROM metadata.static_assets
  WHERE slug = p_slug
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_static_asset_id(TEXT) IS
  'Returns the static asset UUID for a given slug.
   Use this for programmatic lookups in SQL.
   Example: SELECT get_static_asset_id(''homepage-hero'');';

GRANT EXECUTE ON FUNCTION public.get_static_asset_id(TEXT) TO web_anon, authenticated;


-- ============================================================================
-- 11. REGISTER DEFAULT RBAC PERMISSIONS
-- ============================================================================
-- Grant all static_assets permissions to admin role by default.
-- Integrators can grant to other roles via the Permissions page or SQL:
--   SELECT set_role_permission(get_role_id('editor'), 'static_assets', 'create', true);

DO $$
DECLARE
  v_admin_role_id SMALLINT;
  v_perm_id INTEGER;
  v_op TEXT;
BEGIN
  SELECT id INTO v_admin_role_id FROM metadata.roles WHERE role_key = 'admin';

  IF v_admin_role_id IS NOT NULL THEN
    FOREACH v_op IN ARRAY ARRAY['read', 'create', 'update', 'delete'] LOOP
      -- Create permission entry if missing
      INSERT INTO metadata.permissions (table_name, permission)
      VALUES ('static_assets', v_op::metadata.permission)
      ON CONFLICT DO NOTHING;

      -- Get the permission ID
      SELECT id INTO v_perm_id FROM metadata.permissions
      WHERE table_name = 'static_assets' AND permission::TEXT = v_op;

      -- Grant to admin role
      INSERT INTO metadata.permission_roles (role_id, permission_id)
      VALUES (v_admin_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;


-- ============================================================================
-- 12. NOTIFY POSTGREST TO RELOAD SCHEMA CACHE
-- ============================================================================

NOTIFY pgrst, 'reload schema';


COMMIT;
