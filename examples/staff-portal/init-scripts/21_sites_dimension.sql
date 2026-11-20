-- ============================================================================
-- Staff Portal example: Sites as a registered dimension
-- 21: Dimensions registry (metadata.dimensions, v0.85.0+; Dimension property type, v0.86.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Sites are the program locations every staff member, incident report and staff task belongs to, and the axis
-- reports are cut by. Registering the table as the `site` dimension:
--   - turns staff_members.site_id, incident_reports.site_id and staff_tasks.site_id into the Dimension property
--     type: a searchable tree select (flat here: sites have no parent) ordered by sort_order;
--   - fills an empty site_id on insert with the default site (Freedom School Site A) while it is active, from
--     forms, import, MCP and SQL alike; staff_tasks.site_id keeps its own column default (the creator's site),
--     and the registry default applies only when that default yields NULL;
--   - refuses deleting or truncating sites: a site that closes is retired by clearing is_active, which hides it
--     from new choices while existing records keep it.
-- Requires every table with a site_id to exist (01, 10), so it runs after them.

BEGIN;

-- The registry requires a boolean active column; sort_order orders the sites by convention.
ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sort_order INT;

UPDATE public.sites SET sort_order = CASE display_name
    WHEN 'Freedom School Site A' THEN 1
    WHEN 'Freedom School Site B' THEN 2
    WHEN 'Freedom School Site C' THEN 3
  END
WHERE sort_order IS NULL;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('sites', 'is_active', 'Active', 4, 1, TRUE, FALSE, TRUE, TRUE),
  ('sites', 'sort_order', 'Sort Order', 5, 1, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO NOTHING;

SELECT public.register_dimension(
  p_dimension_key    := 'site',
  p_display_name     := 'Site',
  p_table_schema     := 'public',
  p_table_name       := 'sites',
  p_active_column    := 'is_active',
  p_default_value_id := (SELECT id FROM public.sites WHERE display_name = 'Freedom School Site A'));

-- The init scripts run as the deployment role, which create_schema_decision() admits since v0.84.0.
SELECT public.create_schema_decision(
  p_title         := 'Sites are the site dimension',
  p_entity_types  := ARRAY['sites', 'staff_members', 'incident_reports', 'staff_tasks']::NAME[],
  p_property_names := ARRAY['is_active', 'sort_order', 'site_id']::NAME[],
  p_context       := 'Every staff member, incident report and staff task belongs to a site, and reports are cut by site.',
  p_decision      := 'Register sites as the site dimension: add is_active and sort_order, default new records to Freedom School Site A, and retire sites instead of deleting them.',
  p_rationale     := 'The dimensions registry gives every site_id the hierarchical tree select, a server-side default for every insert path, and a delete guard that keeps reports intact.',
  p_consequences  := 'Sites can no longer be deleted (clear is_active instead). Inserts without a site_id get the default site while it is active.',
  p_migration_id  := 'staff-portal/21_sites_dimension');

COMMIT;

NOTIFY pgrst, 'reload schema';
