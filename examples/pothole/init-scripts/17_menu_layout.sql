-- ============================================================================
-- Pot Hole example: grouped sidebar menu
-- 17: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Issues stay a root entity node at the top, beside the headings. A Repair
-- Work heading holds work packages (with their work details nested beneath)
-- and contractor bids; a Reports heading, collapsed by default, holds the
-- issue summary view. Tags get no node: they stay unplaced and appear at the
-- root after the menu nodes, ordered by entity sort_order. The issue_tags
-- junction never shows in the sidebar. The repair entities' table names
-- (WorkPackage, WorkDetail, Bid) are their display names, so their nodes carry
-- plural labels of their own, translated to Spanish.
--
-- Tree (sort_order among siblings):
--   Issue (entity)                                    10
--   repair_work (heading, "Repair Work")              20
--     WorkPackage (entity, "Work Packages")           10
--       WorkDetail (entity, "Work Details")           10
--     Bid (entity, "Bids")                            20
--   reports (heading, "Reports", collapsed)           30
--     issue_status_summary (entity)                   10
--
-- Entity node keys equal their table names, so they keep the table's case
-- (Issue, WorkPackage); only heading keys must be lowercase slugs.
--
-- Parents are inserted before children. The upserts never write is_hidden, so
-- a node an integrator hid stays hidden. Safe to re-run.
--
-- Requires: 01 (tables), 11 and 16 (issue_status_summary), 13 (Spanish translations)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

-- Root level: the Issue entity and the two headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES
  ('repair_work', 'heading', 'Repair Work', NULL, 20, FALSE),
  ('reports',     'heading', 'Reports',     NULL, 30, TRUE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

-- Entities that keep their own display name
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('Issue',                'entity', 'Issue',                NULL,      10),
  ('issue_status_summary', 'entity', 'issue_status_summary', 'reports', 10)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Repair entities, with menu labels
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, parent_node_key, sort_order)
VALUES
  ('WorkPackage', 'entity', 'WorkPackage', 'Work Packages', 'repair_work', 10),
  ('Bid',         'entity', 'Bid',         'Bids',          'repair_work', 20)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Work details nest under the work package entity node (depth 3)
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, parent_node_key, sort_order)
VALUES ('WorkDetail', 'entity', 'WorkDetail', 'Work Details', 'WorkPackage', 10)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- 2. TRANSLATIONS (source type menu_node, key <node_key>.display_name)
-- ============================================================================
-- Spanish, the locale of script 13. A node label replaces the entity's
-- display name, so the labeled entity nodes need their own translations; the
-- unlabeled ones (Issue, issue_status_summary) show the entity's translated name.

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  ('menu_node', 'repair_work.display_name', 'es', 'Trabajos de Reparación'),
  ('menu_node', 'reports.display_name',     'es', 'Informes'),
  ('menu_node', 'WorkPackage.display_name', 'es', 'Paquetes de Trabajo'),
  ('menu_node', 'WorkDetail.display_name',  'es', 'Detalles de Trabajo'),
  ('menu_node', 'Bid.display_name',         'es', 'Ofertas')
ON CONFLICT (source_type, source_key, locale) DO UPDATE SET
  translated_text = EXCLUDED.translated_text;

-- ============================================================================
-- 3. SCHEMA DECISION
-- ============================================================================

-- Direct INSERT (not the create_schema_decision RPC, which requires an admin
-- JWT) because init scripts run without JWT context. Guarded for re-runs.
INSERT INTO metadata.schema_decisions (title, decision, rationale, entity_types)
SELECT
  'Group the pot hole sidebar menu',
  'The sidebar uses metadata.menu_nodes: Issues stays a root link at the top; a Repair Work '
  'heading holds Work Packages (with Work Details nested beneath) and Bids; a Reports heading, '
  'collapsed by default, holds the issue summary view. Tags have no node and stay at the root '
  'after the menu nodes. The repair entities show plural menu labels (Work Packages, Work '
  'Details, Bids), and the headings and labels are translated to Spanish.',
  'Issues are what most users come for, so they stay one click away rather than inside a '
  'heading. Work packages, their details and the bids against them are one repair workflow, '
  'and nesting details under packages mirrors their parent-child relationship. The summary '
  'view is consulted less often, so it starts collapsed. Tags are a reference list that '
  'belongs to neither group. The repair tables are named in singular CamelCase, which reads '
  'poorly as a menu entry, so their nodes carry labels.',
  ARRAY['Issue', 'WorkPackage', 'WorkDetail', 'Bid', 'issue_status_summary']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the pot hole sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
