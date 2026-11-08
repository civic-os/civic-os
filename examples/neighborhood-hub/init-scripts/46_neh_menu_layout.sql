-- ============================================================================
-- Neighborhood Hub example: grouped sidebar menu
-- 46: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Groups the sidebar by program: Tool Lending (reservations, borrowers and
-- training records), Inventory (tool types, with their instances nested beneath),
-- Building Use, Event Kits, and a Community Data heading, collapsed by
-- default, for the project and parcel reference data. Every visible sidebar
-- entity is placed.
--
-- Hidden nodes from earlier scripts (tool_reservation_tools,
-- tool_reservation_work_site, tool_reservation_tool_items,
-- tool_reservation_checkouts, checkout_items, mek_checkouts,
-- mek_checkout_items, mek_request_equipment, mek_request_equipment_items,
-- building_use_event_details, building_use_request_rooms, project_parcels,
-- work_site_parcels) are not touched: this script neither writes is_hidden
-- nor places them, so they stay hidden at the root.
--
-- Tree (sort_order among siblings):
--   tool_lending (heading, "Tool Lending")            10
--     tool_reservations (entity)                      10
--     borrowers (entity)                              20
--     training_records (entity)                       30
--   inventory (heading, "Inventory")                  20
--     tool_types (entity)                             10
--       tool_instances (entity)                       10
--   building_use (heading, "Building Use")            30
--     building_use_requests (entity)                  10
--     building_use_rooms (entity)                     20
--   event_kits (heading, "Event Kits")                40
--     mek_requests (entity)                           10
--   community_data (heading, "Community Data", collapsed) 50
--     projects (entity)                               10
--     parcels (entity)                                20
--     census_block_groups (entity)                    30
--
-- Parents are inserted before children. Safe to re-run.
--
-- Requires: 01, 07, 11 (tables); 02, 11, 17, 18, 27, 33 (hidden nodes)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

-- Headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES
  ('tool_lending',   'heading', 'Tool Lending',   NULL, 10, FALSE),
  ('inventory',      'heading', 'Inventory',      NULL, 20, FALSE),
  ('building_use',   'heading', 'Building Use',   NULL, 30, FALSE),
  ('event_kits',     'heading', 'Event Kits',     NULL, 40, FALSE),
  ('community_data', 'heading', 'Community Data', NULL, 50, TRUE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

-- Entities directly under the headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('tool_reservations',     'entity', 'tool_reservations',     'tool_lending',   10),
  ('borrowers',             'entity', 'borrowers',             'tool_lending',   20),
  ('training_records',      'entity', 'training_records',      'tool_lending',   30),
  ('tool_types',            'entity', 'tool_types',            'inventory',      10),
  ('building_use_requests', 'entity', 'building_use_requests', 'building_use',   10),
  ('building_use_rooms',    'entity', 'building_use_rooms',    'building_use',   20),
  ('mek_requests',          'entity', 'mek_requests',          'event_kits',     10),
  ('projects',              'entity', 'projects',              'community_data', 10),
  ('parcels',               'entity', 'parcels',               'community_data', 20),
  ('census_block_groups',   'entity', 'census_block_groups',   'community_data', 30)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Each tool instance belongs to one tool type, so it nests under it (depth 3)
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('tool_instances', 'entity', 'tool_instances', 'tool_types', 10)
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
  'Group the neighborhood hub sidebar menu',
  'The sidebar uses metadata.menu_nodes, one heading per program: Tool Lending (Tool '
  'Reservations, Borrowers, Training Records), Inventory (Tool Types, with Tool Instances nested beneath), Building Use '
  '(requests and rooms), Event Kits (requests), and Community Data, collapsed by default '
  '(Projects, Parcels, Census Block Groups). Entities hidden by earlier scripts stay hidden.',
  'Staff run each program separately, so grouping by program puts the records of one task '
  'together instead of in one long alphabetical-by-sort list. Each tool instance belongs '
  'to one tool type, so it nests under that type. Project and parcel data is reference material used for reporting, '
  'so its heading starts collapsed.',
  ARRAY['tool_reservations', 'borrowers', 'training_records', 'tool_types', 'tool_instances',
        'building_use_requests', 'building_use_rooms', 'mek_requests', 'projects',
        'parcels', 'census_block_groups']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the neighborhood hub sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
