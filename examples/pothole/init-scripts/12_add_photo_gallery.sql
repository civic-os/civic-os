-- =====================================================
-- Add Photo Gallery to Issue Table (v0.47.0)
-- =====================================================
-- Demonstrates PhotoGallery property type: multi-image gallery
-- with drag-drop upload, reorder, and lightbox viewing.

-- Add gallery FK column to Issue table
ALTER TABLE "public"."Issue"
  ADD COLUMN "photos" UUID REFERENCES metadata.photo_galleries(id);

-- Index on FK column (required for inverse relationship performance)
CREATE INDEX idx_issue_photos ON "public"."Issue"(photos);

-- Configure gallery constraints: 10 images max, common image types
INSERT INTO metadata.photo_gallery_config (table_name, column_name, max_images, allowed_types, max_file_size)
VALUES ('Issue', 'photos', 10, 'image/jpeg,image/png,image/webp', 5242880);

-- Add property metadata for display configuration
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width)
VALUES ('Issue', 'photos', 'Photos', 'Upload photos of the pothole or issue', 55, 2)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
