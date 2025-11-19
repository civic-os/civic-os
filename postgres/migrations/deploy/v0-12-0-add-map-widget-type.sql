-- Deploy civic_os:v0-12-0-add-map-widget-type to pg
-- requires: v0-11-0-add-user-roles

BEGIN;

-- ============================================================================
-- DASHBOARD PHASE 2: MAP WIDGET TYPE
-- ============================================================================
-- Version: v0.12.0
-- Purpose: Add 'map' widget type for Dashboard Phase 2 (filtered lists + maps)
-- Context: Enables StoryMap-style narratives with geographic visualization
-- ============================================================================

-- Add map widget type to registry
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'map',
  'Geographic Map',
  'Display filtered entity records with geography columns on interactive map with optional clustering',
  'map',
  TRUE
)
ON CONFLICT (widget_type) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  icon_name = EXCLUDED.icon_name,
  is_active = EXCLUDED.is_active;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
