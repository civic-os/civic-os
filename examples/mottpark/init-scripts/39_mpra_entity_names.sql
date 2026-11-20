-- =============================================================================
-- MOTT PARK - SINGULAR ENTITY NAMES, PLURAL MENU LABELS (v0.81.0+)
-- =============================================================================
-- Copyright (C) 2023-2026 Civic OS, L3C
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Pages build their text from the entity's display name: "Add {entity}",
-- "{entity}: {record}", "Search {entity}...", "{entity} List". Plural names
-- read as "Add Reservation Requests" and "Reservation Requests: Smith party",
-- so the clubhouse entities take singular names here. The sidebar lists
-- collections, so each entity's menu node carries the plural as its label.
-- Table names do not change.
--
--   table                       entity name            menu label
--   reservation_requests        Reservation Request    Reservation Requests
--   reservation_payments        Reservation Payment    Reservation Payments
--   public_calendar_events      Public Event           Public Events
--   manager_events              Manager Event          Manager Events
--   holiday_rules               Holiday Rule           Holiday Rules
--   reservation_payment_types   Payment Type           Payment Types (new root node)
--
-- Payment Types had no menu node and showed at the root under its entity
-- name. It gets a root node (sort_order 40, after the Mott Fest heading, where
-- it showed before) so its sidebar entry stays plural.
--
-- Keeps admin edits: an entity name changes only while it still holds the
-- shipped plural, a node label is filled only while it is NULL, and the new
-- node is ON CONFLICT DO NOTHING. Safe to re-run. Production runs this file as
-- 36_mpra_entity_names.sql.
--
-- Requires: 01, 02, 05 (tables), 22 (manager_events), 32 (menu nodes)
-- =============================================================================

BEGIN;

-- 1. Singular entity names (only where the shipped plural is still in place)
UPDATE metadata.entities e
SET display_name = n.singular
FROM (VALUES
    ('reservation_requests',      'Reservation Requests', 'Reservation Request'),
    ('reservation_payments',      'Reservation Payments', 'Reservation Payment'),
    ('public_calendar_events',    'Public Events',        'Public Event'),
    ('manager_events',            'Manager Events',       'Manager Event'),
    ('holiday_rules',             'Holiday Rules',        'Holiday Rule'),
    ('reservation_payment_types', 'Payment Types',        'Payment Type')
) AS n(table_name, plural, singular)
WHERE e.table_name = n.table_name::NAME
  AND e.display_name = n.plural;

-- 2. Payment Types gets a root node so its sidebar entry keeps the plural
INSERT INTO metadata.menu_nodes (node_key, node_kind, target_key, parent_node_key, sort_order)
SELECT 'reservation_payment_types', 'entity', 'reservation_payment_types', NULL, 40
WHERE EXISTS (SELECT 1 FROM metadata.entities WHERE table_name = 'reservation_payment_types')
ON CONFLICT (node_key) DO NOTHING;

-- 3. Plural menu labels (only where the node has no label of its own)
UPDATE metadata.menu_nodes m
SET display_name = n.label
FROM (VALUES
    ('reservation_requests',      'Reservation Requests'),
    ('reservation_payments',      'Reservation Payments'),
    ('public_calendar_events',    'Public Events'),
    ('manager_events',            'Manager Events'),
    ('holiday_rules',             'Holiday Rules'),
    ('reservation_payment_types', 'Payment Types')
) AS n(target_key, label)
WHERE m.node_kind = 'entity'
  AND m.target_key = n.target_key::NAME
  AND m.display_name IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- Schema decision (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
    ARRAY['reservation_requests', 'reservation_payments', 'public_calendar_events',
          'manager_events', 'holiday_rules', 'reservation_payment_types']::NAME[], NULL,
    '39_mpra_entity_names',
    'Singular clubhouse entity names with plural menu labels',
    'accepted',
    'The clubhouse entities had plural display names. Pages build their text from the entity name, so they read "Add Reservation Requests", "Reservation Requests: <record>" and "Search Reservation Requests...". The Mott Fest module uses singular entity names with plural menu labels, and the two halves of the sidebar should read the same way.',
    'Set singular display names on the six clubhouse entities (Reservation Request, Reservation Payment, Public Event, Manager Event, Holiday Rule, Payment Type) and give each entity menu node the plural as its label. Payment Types gets a root node, since an entity without a node shows under its own name. Table names stay as they are.',
    'An entity name names one record, which is how every page uses it; the menu names a collection. Changing display names and labels leaves URLs, API paths, saved filters, iCal feed URLs, exports and integrations untouched, which a table rename would break.',
    'Renaming an entity no longer renames its sidebar entry: change the node label in /admin/menu as well. Inverse-relationship section titles on Detail pages and the Entities admin page show the singular name. Table names stay plural while the Mott Fest tables are singular; new tables follow the singular style.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '39_mpra_entity_names'
      AND title = 'Singular clubhouse entity names with plural menu labels'
);
