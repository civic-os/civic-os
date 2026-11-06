-- ============================================================================
-- Client Intake example: grouped sidebar menu
-- 32: Menu Layout (metadata.menu_nodes, v0.81.0+)
-- ============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Groups the sidebar into a Clients workflow (clients, their consent records,
-- referrals, follow-up surveys) and a collapsed Reports section holding the
-- five report views. Service Categories, Partners and Newsletters get no node:
-- they stay unplaced and appear at the root after the headings, ordered by
-- entity sort_order. Hidden nodes from earlier scripts (referrals_per_week,
-- client_current_consents, consents_expiring_soon, consent_reminder_log,
-- newsletter_recipients) are not touched.
--
-- Tree (sort_order among siblings):
--   clients (heading, "Clients")                      10
--     clients (entity, label "All Clients")           10
--       client_consents (entity)                      10
--     referrals (entity)                              20
--     follow_up_surveys (entity)                      30
--   reports (heading, "Reports", collapsed)           20
--     monthly_referral_summary                        10
--     client_contact_summary                          20
--     top_needs_report                                30
--     partner_utilization_report                      40
--     time_lag_report                                 50
--
-- Note: the heading key `clients` and the entity node key `clients` are the
-- same string, but node_key is the primary key, so the heading is keyed
-- `clients_group` instead.
--
-- Parents are inserted before children. The upserts never write is_hidden, so
-- a node an integrator hid stays hidden. Safe to re-run.
--
-- Requires: 03, 04, 26 (targets registered), 28 (translation pattern)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. MENU NODES
-- ============================================================================

-- Headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, display_name, parent_node_key, sort_order, collapsed_by_default)
VALUES
  ('clients_group', 'heading', 'Clients', NULL, 10, FALSE),
  ('reports',       'heading', 'Reports', NULL, 20, TRUE)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order,
  collapsed_by_default = EXCLUDED.collapsed_by_default;

-- Entities directly under the headings
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, display_name, parent_node_key, sort_order)
VALUES
  ('clients',                    'entity', 'clients',                    'All Clients', 'clients_group', 10),
  ('referrals',                  'entity', 'referrals',                  NULL,          'clients_group', 20),
  ('follow_up_surveys',          'entity', 'follow_up_surveys',          NULL,          'clients_group', 30),
  ('monthly_referral_summary',   'entity', 'monthly_referral_summary',   NULL,          'reports',       10),
  ('client_contact_summary',     'entity', 'client_contact_summary',     NULL,          'reports',       20),
  ('top_needs_report',           'entity', 'top_needs_report',           NULL,          'reports',       30),
  ('partner_utilization_report', 'entity', 'partner_utilization_report', NULL,          'reports',       40),
  ('time_lag_report',            'entity', 'time_lag_report',            NULL,          'reports',       50)
ON CONFLICT (node_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- Consent records nest under the clients entity node (depth 3)
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
VALUES ('client_consents', 'entity', 'client_consents', 'clients', 10)
ON CONFLICT (node_key) DO UPDATE SET
  parent_node_key = EXCLUDED.parent_node_key,
  sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- 2. TRANSLATIONS (source type menu_node, key <node_key>.display_name)
-- ============================================================================
-- Locales: es, ar, ps, fr, de (the same five as scripts 13 to 17 and 28).

INSERT INTO metadata.translations (source_type, source_key, locale, translated_text) VALUES
  -- Spanish
  ('menu_node', 'clients_group.display_name', 'es', 'Clientes'),
  ('menu_node', 'reports.display_name',       'es', 'Informes'),
  ('menu_node', 'clients.display_name',       'es', 'Todos los Clientes'),
  -- Arabic
  ('menu_node', 'clients_group.display_name', 'ar', 'العملاء'),
  ('menu_node', 'reports.display_name',       'ar', 'التقارير'),
  ('menu_node', 'clients.display_name',       'ar', 'جميع العملاء'),
  -- Pashto
  ('menu_node', 'clients_group.display_name', 'ps', 'مراجعین'),
  ('menu_node', 'reports.display_name',       'ps', 'راپورونه'),
  ('menu_node', 'clients.display_name',       'ps', 'ټول مراجعین'),
  -- French
  ('menu_node', 'clients_group.display_name', 'fr', 'Clients'),
  ('menu_node', 'reports.display_name',       'fr', 'Rapports'),
  ('menu_node', 'clients.display_name',       'fr', 'Tous les Clients'),
  -- German
  ('menu_node', 'clients_group.display_name', 'de', 'Klienten'),
  ('menu_node', 'reports.display_name',       'de', 'Berichte'),
  ('menu_node', 'clients.display_name',       'de', 'Alle Klienten')
ON CONFLICT (source_type, source_key, locale) DO UPDATE SET
  translated_text = EXCLUDED.translated_text;

-- ============================================================================
-- 3. SCHEMA DECISION
-- ============================================================================

-- Direct INSERT (not the create_schema_decision RPC, which requires an admin
-- JWT) because init scripts run without JWT context. Guarded for re-runs.
INSERT INTO metadata.schema_decisions (title, decision, rationale, entity_types)
SELECT
  'Group the client intake sidebar menu',
  'The sidebar uses metadata.menu_nodes: a Clients heading holds All Clients (with consent '
  'records nested beneath it), Referrals and Follow-Up Surveys; a Reports heading, collapsed '
  'by default, holds the five report views. Service Categories, Partners and Newsletters have '
  'no node and stay at the root after the headings.',
  'Staff work through the client workflow, so it comes first and keeps related records '
  'together. The five reports are consulted less often and would otherwise crowd the sidebar, '
  'so they start collapsed. Reference tables (service categories, partners) and newsletters '
  'are standalone lists that do not belong to either group; leaving them unplaced keeps them '
  'visible at the root in their existing entity sort_order without extra maintenance.',
  ARRAY['clients', 'client_consents', 'referrals', 'follow_up_surveys',
        'monthly_referral_summary', 'client_contact_summary', 'top_needs_report',
        'partner_utilization_report', 'time_lag_report']::NAME[]
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions WHERE title = 'Group the client intake sidebar menu'
);

NOTIFY pgrst, 'reload schema';

COMMIT;
