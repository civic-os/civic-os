-- =====================================================
-- Add Text Search to Issue Table
-- =====================================================
-- This script demonstrates how to enable full-text search on an entity
-- by adding a civic_os_text_search column and configuring search_fields

-- Add the generated tsvector column for full-text search
ALTER TABLE "public"."Issue"
  ADD COLUMN civic_os_text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(display_name, ''))
  ) STORED;

-- Create GIN index for fast text search
CREATE INDEX "Issue_text_search_idx"
  ON "public"."Issue"
  USING GIN (civic_os_text_search);

-- Configure search fields in metadata
-- This tells the frontend which fields are included in the search
INSERT INTO metadata.entities (table_name, display_name, search_fields, sort_order)
VALUES ('Issue', 'Issues', ARRAY['display_name'], 10)
ON CONFLICT (table_name) DO UPDATE
  SET search_fields = EXCLUDED.search_fields;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
