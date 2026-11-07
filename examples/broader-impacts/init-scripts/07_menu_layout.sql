-- ============================================================================
-- Broader Impacts example: grouped sidebar menu
-- 07: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- An Engagement heading holds the three records the example is about:
-- organizations, their contacts and the projects they take part in. Interest
-- Centers and Impact Categories get no node: they stay unplaced and appear at
-- the root after the heading, ordered by entity sort_order. This is the
-- smallest useful layout: one heading, with the lookup lists left alone. The
-- four junction tables never show in the sidebar.
--
-- Tree (sort_order among siblings):
--   engagement (heading, "Engagement")                10
--     organizations (entity)                          10
--     contacts (entity)                               20
--     projects (entity)                               30
--
-- Parents are inserted before children. The upserts never write is_hidden, so
-- a node an integrator hid stays hidden. Safe to re-run.
--
-- Requires: 01 (tables)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES ('engagement', 'heading', 'Engagement', NULL, 10, FALSE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('organizations', 'entity', 'organizations', 'engagement', 10),
  ('contacts',      'entity', 'contacts',      'engagement', 20),
  ('projects',      'entity', 'projects',      'engagement', 30)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- 2. SCHEMA DECISION
-- ============================================================================
-- No translations: this example enables no locale besides English.

-- Direct INSERT (not the create_schema_decision RPC, which requires an admin
-- JWT) because init scripts run without JWT context. Guarded for re-runs.
INSERT INTO metadata.schema_decisions (title, decision, rationale, entity_types)
SELECT
  'Group the broader impacts sidebar menu',
  'The sidebar uses metadata.menu_nodes: an Engagement heading holds Organizations, Contacts '
  'and Projects. Interest Centers and Impact Categories have no node and stay at the root '
  'after the heading.',
  'Organizations, contacts and projects are the records users work in, and they reference '
  'each other, so they sit together. Interest centers and impact categories are lookup lists '
  'used to tag those records; leaving them unplaced keeps them visible in their existing '
  'entity sort_order without extra maintenance.',
  ARRAY['organizations', 'contacts', 'projects']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the broader impacts sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
