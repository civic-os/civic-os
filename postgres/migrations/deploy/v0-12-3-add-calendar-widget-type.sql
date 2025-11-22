-- Deploy civic_os:v0-12-3-add-calendar-widget-type to pg
-- requires: v0-12-2-add-navigation-widget-type

BEGIN;

-- ============================================================================
-- DASHBOARD PHASE 2: CALENDAR WIDGET TYPE
-- ============================================================================
-- Version: v0.12.3
-- Purpose: Add 'calendar' widget type for Dashboard Phase 2 (calendar visualization)
-- Context: Enables interactive calendar views for entities with time_slot properties
-- ============================================================================

-- Add calendar widget type to registry
INSERT INTO metadata.widget_types (widget_type, display_name, description, icon_name, is_active)
VALUES (
  'calendar',
  'Calendar',
  'Display filtered entity records with time_slot columns on interactive calendar with month/week/day views',
  'calendar_month',
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
