-- ============================================================================
-- Mott Park Recreation Area example: grouped sidebar menu
-- 32: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A Reservations heading holds reservation requests (with their payments
-- nested beneath) and the public events calendar. A Managers heading,
-- collapsed by default, holds the manager events virtual entity (a view with
-- INSTEAD OF triggers, script 22) and the holiday rules. Payment Types gets no
-- node: it stays unplaced and appears at the root after the headings.
--
-- Tree (sort_order among siblings):
--   reservations (heading, "Reservations")            10
--     reservation_requests (entity)                   10
--       reservation_payments (entity)                 10
--     public_calendar_events (entity)                 20
--   managers (heading, "Managers", collapsed)         20
--     manager_events (entity, virtual)                10
--     holiday_rules (entity)                          20
--
-- The sidebar does not filter by permission: every signed-in role sees the
-- Managers heading, as it saw these links before; RLS decides what each list
-- returns.
--
-- Parents are inserted before children. The upserts never write is_hidden, so
-- a node an integrator hid stays hidden. Safe to re-run.
--
-- Requires: 01, 02, 05 (tables), 22 (manager_events), 24 (decision pattern)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

-- Headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES
  ('reservations', 'heading', 'Reservations', NULL, 10, FALSE),
  ('managers',     'heading', 'Managers',     NULL, 20, TRUE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

-- Entities directly under the headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('reservation_requests',   'entity', 'reservation_requests',   'reservations', 10),
  ('public_calendar_events', 'entity', 'public_calendar_events', 'reservations', 20),
  ('manager_events',         'entity', 'manager_events',         'managers',     10),
  ('holiday_rules',          'entity', 'holiday_rules',          'managers',     20)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Payments nest under the reservation requests entity node (depth 3)
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('reservation_payments', 'entity', 'reservation_payments', 'reservation_requests', 10)
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
  'Group the Mott Park sidebar menu',
  'The sidebar uses metadata.menu_nodes: a Reservations heading holds Reservation Requests '
  '(with Reservation Payments nested beneath) and Public Events; a Managers heading, collapsed '
  'by default, holds Manager Events and Holiday Rules. Payment Types has no node and stays at '
  'the root after the headings.',
  'Renters and staff start from reservation requests, and each payment belongs to one request, '
  'so payments nest under requests. Public events are the calendar renters check before they '
  'book. Manager events and holiday rules are manager tools that other users rarely open, so '
  'their heading starts collapsed. Payment types is a short lookup list that belongs to '
  'neither group.',
  ARRAY['reservation_requests', 'reservation_payments', 'public_calendar_events',
        'manager_events', 'holiday_rules']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the Mott Park sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
