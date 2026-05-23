-- Neighborhood Engagement Hub - Dashboard, sidebar, and step property ordering fixes
--
-- 1. Dashboard filters: 5 widgets use hardcoded workflow_status_id (12, 13, 14).
--    Migrated to portable status.status_key dot-notation.
--
-- 2. Sidebar: Hide child/junction/system entities, regroup for logical ordering.
--
-- 3. Step property ordering: M:M tool/equipment selection should display before
--    notes fields on tool_reservation_tools, mek_request_equipment, and
--    tool_reservation_work_site.

BEGIN;

-- NEH Staff: Pending Tool Reservations (workflow_status_id eq 12 → status.status_key eq pending)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{filters}',
    '[{"column": "status.status_key", "operator": "eq", "value": "pending"}]'::jsonb
)
WHERE dashboard_id = 3 AND sort_order = 10
  AND config->>'entity' = 'tool_reservations'
  AND config->'filters'->0->>'value' = '12';

-- NEH Staff: Approved - Awaiting Checkout (workflow_status_id eq 13 → status.status_key eq approved)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{filters}',
    '[{"column": "status.status_key", "operator": "eq", "value": "approved"}]'::jsonb
)
WHERE dashboard_id = 3 AND sort_order = 20
  AND config->>'entity' = 'tool_reservations'
  AND config->'filters'->0->>'value' = '13';

-- NEH Staff: Currently Checked Out (workflow_status_id eq 14 → status.status_key eq checked_out)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{filters}',
    '[{"column": "status.status_key", "operator": "eq", "value": "checked_out"}]'::jsonb
)
WHERE dashboard_id = 3 AND sort_order = 30
  AND config->>'entity' = 'tool_reservations'
  AND config->'filters'->0->>'value' = '14';

-- NEH Admin: Pending Tool Reservations (workflow_status_id eq 12 → status.status_key eq pending)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{filters}',
    '[{"column": "status.status_key", "operator": "eq", "value": "pending"}]'::jsonb
)
WHERE dashboard_id = 4 AND sort_order = 10
  AND config->>'entity' = 'tool_reservations'
  AND config->'filters'->0->>'value' = '12';

-- NEH Admin: Currently Checked Out (workflow_status_id eq 14 → status.status_key eq checked_out)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{filters}',
    '[{"column": "status.status_key", "operator": "eq", "value": "checked_out"}]'::jsonb
)
WHERE dashboard_id = 4 AND sort_order = 20
  AND config->>'entity' = 'tool_reservations'
  AND config->'filters'->0->>'value' = '14';

-- ============================================================================
-- 2. SIDEBAR: Hide child/junction/system entities, regroup ordering
-- ============================================================================

-- Hide child/junction entities
UPDATE metadata.entities SET show_in_sidebar = false
WHERE table_name IN (
    'checkout_instances',     -- child of tool_reservation_checkouts
    'project_parcels',        -- junction table (M:M)
    'work_site_parcels'       -- junction table (M:M)
);

-- Hide recurring timeslot system entities
UPDATE metadata.entities SET show_in_sidebar = false
WHERE table_name IN (
    'time_slot_series_groups',
    'time_slot_series',
    'time_slot_instances'
);

-- Regroup sidebar: Tool Lending → Inventory → Building Use → Event Kits → Community
UPDATE metadata.entities SET sort_order = 1  WHERE table_name = 'tool_reservations';
UPDATE metadata.entities SET sort_order = 2  WHERE table_name = 'borrowers';
UPDATE metadata.entities SET sort_order = 3  WHERE table_name = 'training_records';
UPDATE metadata.entities SET sort_order = 4  WHERE table_name = 'tool_categories';
UPDATE metadata.entities SET sort_order = 5  WHERE table_name = 'tool_types';
UPDATE metadata.entities SET sort_order = 6  WHERE table_name = 'tool_instances';
UPDATE metadata.entities SET sort_order = 7  WHERE table_name = 'building_use_requests';
UPDATE metadata.entities SET sort_order = 8  WHERE table_name = 'building_use_rooms';
UPDATE metadata.entities SET sort_order = 9  WHERE table_name = 'mek_requests';
UPDATE metadata.entities SET sort_order = 10 WHERE table_name = 'projects';
UPDATE metadata.entities SET sort_order = 11 WHERE table_name = 'parcels';
UPDATE metadata.entities SET sort_order = 12 WHERE table_name = 'census_block_groups';

-- ============================================================================
-- 3. STEP PROPERTY ORDERING: M:M displays before notes
-- ============================================================================

-- tool_reservation_tools: tool selection M:M first (1), then tool_notes (10)
UPDATE metadata.properties SET sort_order = 1
WHERE table_name = 'tool_reservation_tools' AND column_name = 'tool_reservation_tool_items_m2m';
UPDATE metadata.properties SET sort_order = 10
WHERE table_name = 'tool_reservation_tools' AND column_name = 'tool_notes';

-- mek_request_equipment: equipment selection M:M first (1), then equipment_notes (10)
UPDATE metadata.properties SET sort_order = 1
WHERE table_name = 'mek_request_equipment' AND column_name = 'mek_request_equipment_items_m2m';
UPDATE metadata.properties SET sort_order = 10
WHERE table_name = 'mek_request_equipment' AND column_name = 'equipment_notes';

-- tool_reservation_work_site: parcel selection M:M first (1), then site_description (10)
UPDATE metadata.properties SET sort_order = 1
WHERE table_name = 'tool_reservation_work_site' AND column_name = 'work_site_parcels_m2m';
UPDATE metadata.properties SET sort_order = 10
WHERE table_name = 'tool_reservation_work_site' AND column_name = 'site_description';

-- ============================================================================
-- ADR
-- ============================================================================

INSERT INTO metadata.schema_decisions (title, decision, entity_types, status, decided_date)
VALUES (
    'Dashboard, sidebar, and step property ordering fixes',
    'Three housekeeping fixes: (1) Dashboard filters — migrated 5 tool_reservation widgets from '
        'hardcoded workflow_status_id values (12, 13, 14) to portable status.status_key dot-notation. '
        '(2) Sidebar — hid child entities (checkout_instances), junction tables (project_parcels, '
        'work_site_parcels), and recurring timeslot system entities; regrouped sidebar into logical '
        'sections: Tool Lending, Inventory, Building Use, Event Kits, Community. '
        '(3) Step property ordering — set M:M selection columns to sort before notes/description '
        'fields on tool_reservation_tools, mek_request_equipment, and tool_reservation_work_site.',
    ARRAY['tool_reservations', 'mek_requests', 'building_use_requests']::name[],
    'accepted',
    CURRENT_DATE
);

COMMIT;
