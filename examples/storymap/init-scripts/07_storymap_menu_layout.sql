-- ============================================================================
-- StoryMap example: grouped sidebar menu
-- 07: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A Program heading holds the youth soccer participants and the teams (with
-- their rosters nested beneath). Community Sponsors stays a root entity node
-- after the heading. Every sidebar entity is placed.
--
-- Tree (sort_order among siblings):
--   program (heading, "Program")                      10
--     participants (entity)                           10
--     teams (entity)                                  20
--       team_rosters (entity)                         10
--   sponsors (entity)                                 20
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
VALUES ('program', 'heading', 'Program', NULL, 10, FALSE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('participants', 'entity', 'participants', 'program', 10),
  ('teams',        'entity', 'teams',        'program', 20),
  ('sponsors',     'entity', 'sponsors',     NULL,      20)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Rosters nest under the teams entity node (depth 3)
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('team_rosters', 'entity', 'team_rosters', 'teams', 10)
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
  'Group the storymap sidebar menu',
  'The sidebar uses metadata.menu_nodes: a Program heading holds Youth Soccer Participants and '
  'Teams (with Team Rosters nested beneath); Community Sponsors stays a root link after it.',
  'Participants, teams and rosters are the soccer program itself, and each roster belongs to '
  'one team, so rosters nest under teams. Sponsors support the program but are not part of '
  'its day-to-day records, so they stay outside the heading.',
  ARRAY['participants', 'teams', 'team_rosters', 'sponsors']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the storymap sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
