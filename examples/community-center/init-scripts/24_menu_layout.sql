-- ============================================================================
-- Community Center example: grouped sidebar menu
-- 24: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A Bookings heading holds confirmed reservations and the requests that lead
-- to them. Resources stays a root entity node between the headings, and a
-- Payments heading, collapsed by default, holds the payment transactions view
-- that staff reconcile against. Every sidebar entity is placed.
--
-- Tree (sort_order among siblings):
--   bookings (heading, "Bookings")                    10
--     reservations (entity)                           10
--     reservation_requests (entity)                   20
--   resources (entity)                                20
--   payments (heading, "Payments", collapsed)         30
--     payment_transactions (entity)                   10
--
-- Parents are inserted before children. The upserts never write is_hidden, so
-- a node an integrator hid stays hidden. Safe to re-run.
--
-- Requires: 01 (tables), 10 (payment_transactions)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

-- Headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES
  ('bookings', 'heading', 'Bookings', NULL, 10, FALSE),
  ('payments', 'heading', 'Payments', NULL, 30, TRUE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

-- Entities: under the headings, and Resources at the root between them
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('reservations',         'entity', 'reservations',         'bookings', 10),
  ('reservation_requests', 'entity', 'reservation_requests', 'bookings', 20),
  ('resources',            'entity', 'resources',            NULL,       20),
  ('payment_transactions', 'entity', 'payment_transactions', 'payments', 10)
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
  'Group the community center sidebar menu',
  'The sidebar uses metadata.menu_nodes: a Bookings heading holds Reservations and '
  'Reservation Requests; Resources stays a root link; a Payments heading, collapsed by '
  'default, holds Payment Transactions.',
  'Reservations and the requests that become them are one booking workflow and belong '
  'together. Resources is a single reference list that needs no heading of its own. Payment '
  'transactions matter to the staff who reconcile them, not to most visitors, so their '
  'heading starts collapsed.',
  ARRAY['reservations', 'reservation_requests', 'resources', 'payment_transactions']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the community center sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
