-- ============================================================================
-- Neighborhood Hub example: dashboards in the sidebar menu
-- 47: Menu Dashboards (metadata.menu_nodes.dashboard_id, v0.83.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Puts the tool lending dashboards under the Tool Lending heading (script 46):
--   tool_lending (heading, "Tool Lending")  -> opens NEH Staff (its title is a link)
--     tool_reservations, borrowers, training_records   (script 46)
--     NEH Borrower (dashboard node)                     40
--     NEH Admin (dashboard node)                        50
--
-- NEH Staff and NEH Admin are not public (script 45), so each shows only to the
-- roles that can see it: for testuser and anonymous visitors, Tool Lending is a
-- plain heading and NEH Admin is left out, while NEH Borrower (public) shows to
-- everyone. testadmin sees everything. Placing a dashboard here changes neither
-- who can open it nor the dashboard selector.
--
-- Dashboard ids differ per instance, so they are resolved by display_name.
-- Safe to re-run.
--
-- Requires: 10 (dashboards), 45 (dashboard visibility), 46 (menu layout)
-- ============================================================================

BEGIN;

-- The Tool Lending heading opens the staff dashboard
UPDATE metadata.menu_nodes
SET dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'NEH Staff')
WHERE node_key = 'tool_lending'
  AND dashboard_id IS DISTINCT FROM (SELECT id FROM metadata.dashboards WHERE display_name = 'NEH Staff');

-- Dashboard nodes: key dashboard:<id>, no target_key
INSERT INTO metadata.menu_nodes (node_key, node_kind, dashboard_id, parent_node_key, sort_order)
SELECT 'dashboard:' || d.id, 'dashboard', d.id, 'tool_lending', v.sort_order
FROM (VALUES ('NEH Borrower', 40), ('NEH Admin', 50)) AS v(display_name, sort_order)
JOIN metadata.dashboards d ON d.display_name = v.display_name
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- SCHEMA DECISION
-- ============================================================================
-- Direct INSERT (not the create_schema_decision RPC, which requires an admin
-- JWT) because init scripts run without JWT context. Guarded for re-runs.
INSERT INTO metadata.schema_decisions (title, decision, rationale, entity_types)
SELECT
  'Put the tool lending dashboards in the sidebar menu',
  'The Tool Lending heading opens the NEH Staff dashboard, and the NEH Borrower and NEH Admin '
  'dashboards sit under it, after the tool lending entities.',
  'Staff work from the tool lending records and their dashboards together, so the dashboards '
  'belong next to the records rather than only in the dashboard selector. The menu shows each '
  'dashboard only to roles that can see it, so borrowers keep a plain Tool Lending heading.',
  ARRAY['tool_reservations', 'borrowers', 'training_records']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Put the tool lending dashboards in the sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
