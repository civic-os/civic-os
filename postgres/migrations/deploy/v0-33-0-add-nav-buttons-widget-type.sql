-- Deploy civic_os:v0-33-0-add-nav-buttons-widget-type to pg
-- requires: v0-33-0-causal-bindings

BEGIN;

-- ============================================================================
-- DASHBOARD: NAV_BUTTONS WIDGET TYPE
-- ============================================================================
-- Version: v0.33.0
-- Purpose: Add 'nav_buttons' widget type for flexible navigation button groups
-- Context: Provides configurable buttons with icons, variants, and optional
--          query parameters for dashboard quick-action panels
-- ============================================================================

-- Add nav_buttons widget type to registry
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'nav_buttons',
  'Navigation Buttons',
  'Flexible navigation buttons with header, description, icons, and configurable styles (primary, secondary, outline)',
  'apps',
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
