-- ============================================================================
-- Staff Portal example: grouped sidebar menu
-- 20: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A My Work heading holds the records staff file day to day. A People heading
-- holds the staff directory, the staff member records (with their documents
-- nested beneath) and offboarding feedback. An Administration heading,
-- collapsed by default, holds the setup lists: sites, staff roles and document
-- requirements. Every sidebar entity is placed; the document_requirement_roles
-- junction never shows in the sidebar.
--
-- Tree (sort_order among siblings):
--   my_work (heading, "My Work")                      10
--     staff_tasks (entity)                            10
--     time_entries (entity)                           20
--     time_off_requests (entity)                      30
--     reimbursements (entity)                         40
--     incident_reports (entity)                       50
--   people (heading, "People")                        20
--     staff_directory (entity)                        10
--     staff_members (entity)                          20
--       staff_documents (entity)                      10
--     offboarding_feedback (entity)                   30
--   administration (heading, "Administration", collapsed) 30
--     sites (entity)                                  10
--     staff_roles (entity)                            20
--     document_requirements (entity)                  30
--
-- The sidebar does not filter by permission: every signed-in role sees the
-- Administration heading, as it saw these links before; RLS decides what each
-- list returns.
--
-- Parents are inserted before children. The upserts never write is_hidden, so
-- a node an integrator hid stays hidden. Safe to re-run.
--
-- Requires: 01, 10, 15, 16 (tables and views), 08 (decision pattern)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

-- Headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES
  ('my_work',        'heading', 'My Work',        NULL, 10, FALSE),
  ('people',         'heading', 'People',         NULL, 20, FALSE),
  ('administration', 'heading', 'Administration', NULL, 30, TRUE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

-- Entities directly under the headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES
  ('staff_tasks',           'entity', 'staff_tasks',           'my_work',        10),
  ('time_entries',          'entity', 'time_entries',          'my_work',        20),
  ('time_off_requests',     'entity', 'time_off_requests',     'my_work',        30),
  ('reimbursements',        'entity', 'reimbursements',        'my_work',        40),
  ('incident_reports',      'entity', 'incident_reports',      'my_work',        50),
  ('staff_directory',       'entity', 'staff_directory',       'people',         10),
  ('staff_members',         'entity', 'staff_members',         'people',         20),
  ('offboarding_feedback',  'entity', 'offboarding_feedback',  'people',         30),
  ('sites',                 'entity', 'sites',                 'administration', 10),
  ('staff_roles',           'entity', 'staff_roles',           'administration', 20),
  ('document_requirements', 'entity', 'document_requirements', 'administration', 30)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Staff documents nest under the staff members entity node (depth 3)
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('staff_documents', 'entity', 'staff_documents', 'staff_members', 10)
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
  'Group the staff portal sidebar menu',
  'The sidebar uses metadata.menu_nodes: a My Work heading holds Staff Tasks, Time Entries, '
  'Time Off Requests, Reimbursements and Incident Reports; a People heading holds the Staff '
  'Directory, Staff Members (with Staff Documents nested beneath) and Offboarding Feedback; an '
  'Administration heading, collapsed by default, holds Sites, Staff Roles and Document '
  'Requirements.',
  'Most staff open the portal to file or check their own records, so those come first under '
  'one heading. Records about people sit together, and each staff document belongs to one '
  'staff member, so documents nest under members. Sites, roles and document requirements are '
  'setup lists that change rarely, so their heading starts collapsed.',
  ARRAY['staff_tasks', 'time_entries', 'time_off_requests', 'reimbursements',
        'incident_reports', 'staff_directory', 'staff_members', 'staff_documents',
        'offboarding_feedback', 'sites', 'staff_roles', 'document_requirements']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the staff portal sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
