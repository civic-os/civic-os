-- Neighborhood Engagement Hub - Restructure checkout flow
--
-- Changes the checkout flow from immediate check-out to a two-phase process:
--   Phase 1: "Start Checkout" creates a checkout record in 'preparing' status
--            and navigates staff to it. Staff adds items via entity actions.
--   Phase 2: "Confirm Checkout" transitions checkout → checked_out,
--            parent reservation/request → checked_out, and inserts
--            system notes on tool instances.
--
-- This separation lets staff review and verify items before committing
-- the checkout, matching the physical workflow more closely.
--
-- Also adds missing entity_action_roles grants for all tool_reservations
-- and mek_requests entity actions (omitted from script 16).

BEGIN;

-- ============================================================================
-- 1. Add 'preparing' status to checkout entity types
-- ============================================================================

-- Un-mark 'checked_out' as initial FIRST (unique partial index enforces one is_initial per entity_type)
UPDATE metadata.statuses SET is_initial = false
WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

UPDATE metadata.statuses SET is_initial = false
WHERE entity_type = 'mek_checkouts' AND status_key = 'checked_out';

-- Now insert 'preparing' as the new initial status
INSERT INTO metadata.statuses (entity_type, status_key, display_name, color, sort_order, is_initial, is_terminal)
VALUES ('tool_reservation_checkouts', 'preparing', 'Preparing', '#f59e0b', 0, true, false)
ON CONFLICT (entity_type, status_key) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, status_key, display_name, color, sort_order, is_initial, is_terminal)
VALUES ('mek_checkouts', 'preparing', 'Preparing', '#f59e0b', 5, true, false)
ON CONFLICT (entity_type, status_key) DO NOTHING;

-- ============================================================================
-- 2. Update checkout_tool_reservation — create record + navigate only
--    Status transition and system notes move to confirm_checkout (section 4)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.checkout_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_checkout_id BIGINT;
    v_preparing_status_id INT;
    v_reservation_name TEXT;
BEGIN
    -- Verify current status
    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only approved reservations can start checkout. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_preparing_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'preparing';

    SELECT display_name INTO v_reservation_name
    FROM tool_reservations WHERE id = p_entity_id;

    -- Create checkout record in 'preparing' status
    INSERT INTO public.tool_reservation_checkouts (tool_reservation_id, status_id, display_name)
    VALUES (p_entity_id, v_preparing_status_id, 'Checkout - ' || v_reservation_name)
    ON CONFLICT (tool_reservation_id) DO NOTHING
    RETURNING id INTO v_checkout_id;

    -- If checkout already existed, get its ID
    IF v_checkout_id IS NULL THEN
        SELECT id INTO v_checkout_id
        FROM tool_reservation_checkouts
        WHERE tool_reservation_id = p_entity_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Checkout record created. Add tools to check out.',
        'navigate_to', '/view/tool_reservation_checkouts/' || v_checkout_id
    );
END;
$$;

-- ============================================================================
-- 3. Update checkout_mek_request — create record + navigate only
-- ============================================================================

CREATE OR REPLACE FUNCTION public.checkout_mek_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_checkout_id BIGINT;
    v_preparing_status_id INT;
    v_request_name TEXT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM mek_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only approved requests can start checkout. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'You do not have permission to check out event kit requests.');
    END IF;

    SELECT id INTO v_preparing_status_id FROM metadata.statuses
    WHERE entity_type = 'mek_checkouts' AND status_key = 'preparing';

    SELECT display_name INTO v_request_name FROM mek_requests WHERE id = p_entity_id;

    INSERT INTO mek_checkouts (mek_request_id, status_id, display_name)
    VALUES (p_entity_id, v_preparing_status_id, 'Checkout - ' || v_request_name)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_checkout_id;

    IF v_checkout_id IS NULL THEN
        SELECT id INTO v_checkout_id FROM mek_checkouts WHERE mek_request_id = p_entity_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Checkout record created. Add items to check out.',
        'navigate_to', '/view/mek_checkouts/' || v_checkout_id
    );
END;
$$;

-- ============================================================================
-- 4. Create confirm_checkout — the actual checkout (tool reservations)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
BEGIN
    -- Get checkout with current status and parent info
    SELECT trc.id, trc.tool_reservation_id, s.status_key,
           tr.display_name AS reservation_name
    INTO v_checkout
    FROM tool_reservation_checkouts trc
    JOIN metadata.statuses s ON s.id = trc.status_id
    JOIN tool_reservations tr ON tr.id = trc.tool_reservation_id
    WHERE trc.id = p_entity_id;

    IF v_checkout.status_key IS DISTINCT FROM 'preparing' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only checkouts in preparing status can be confirmed.');
    END IF;

    -- Require at least one item
    IF NOT EXISTS (SELECT 1 FROM checkout_items WHERE checkout_id = p_entity_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Add at least one item before confirming checkout.');
    END IF;

    -- Get target status IDs
    SELECT id INTO v_checked_out_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_parent_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'checked_out';

    -- Transition checkout to checked_out
    UPDATE tool_reservation_checkouts SET status_id = v_checked_out_status_id
    WHERE id = p_entity_id;

    -- Transition parent reservation to checked_out
    UPDATE tool_reservations SET workflow_status_id = v_parent_checked_out_id
    WHERE id = v_checkout.tool_reservation_id;

    -- Insert system notes on tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        'Checked out — Reservation: ' || COALESCE(v_checkout.reservation_name, '#' || v_checkout.tool_reservation_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id IS NOT NULL;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout confirmed. Tools are now checked out.');
END;
$$;

-- ============================================================================
-- 5. Create confirm_mek_checkout — the actual checkout (MEK)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_mek_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
BEGIN
    SELECT mc.id, mc.mek_request_id, s.status_key,
           mr.display_name AS request_name
    INTO v_checkout
    FROM mek_checkouts mc
    JOIN metadata.statuses s ON s.id = mc.status_id
    JOIN mek_requests mr ON mr.id = mc.mek_request_id
    WHERE mc.id = p_entity_id;

    IF v_checkout.status_key IS DISTINCT FROM 'preparing' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only checkouts in preparing status can be confirmed.');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM mek_checkout_items WHERE checkout_id = p_entity_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Add at least one item before confirming checkout.');
    END IF;

    SELECT id INTO v_checked_out_status_id FROM metadata.statuses
    WHERE entity_type = 'mek_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_parent_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'checked_out';

    UPDATE mek_checkouts SET status_id = v_checked_out_status_id
    WHERE id = p_entity_id;

    UPDATE mek_requests SET status_id = v_parent_checked_out_id
    WHERE id = v_checkout.mek_request_id;

    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', mci.tool_instance_id::text,
        'Checked out (MEK) — Request: ' || COALESCE(v_checkout.request_name, '#' || v_checkout.mek_request_id),
        'system', current_user_id()
    FROM mek_checkout_items mci
    WHERE mci.checkout_id = p_entity_id
      AND mci.tool_instance_id IS NOT NULL;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout confirmed. Items are now checked out.');
END;
$$;

-- ============================================================================
-- 6. Fix invalid icon names (Lucide/Feather → Material Symbols)
-- ============================================================================

UPDATE metadata.entity_actions SET icon = 'add_circle'
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'add_item' AND icon = 'plus';

UPDATE metadata.entity_actions SET icon = 'remove_circle'
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'remove_item' AND icon = 'minus';

UPDATE metadata.entity_actions SET icon = 'warning'
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'report_damage' AND icon = 'alert-triangle';

-- ============================================================================
-- 7. Update parent entity action labels
-- ============================================================================


UPDATE metadata.entity_actions
SET display_name = 'Start Checkout',
    description = 'Create a checkout record to add and verify tools',
    confirmation_message = 'Create a checkout record for this reservation?'
WHERE table_name = 'tool_reservations' AND action_name = 'check_out';

UPDATE metadata.entity_actions
SET display_name = 'Start Checkout',
    description = 'Create a checkout record to add and verify items',
    confirmation_message = 'Create a checkout record for this event kit?'
WHERE table_name = 'mek_requests' AND action_name = 'check_out';

-- ============================================================================
-- 8. Update checkout entity action visibility conditions
--    Add Item + Remove Item: visible in 'preparing' (staff adding items)
--    Mark Returned + Report Damage: stay in 'checked_out' (items physically out)
-- ============================================================================

UPDATE metadata.entity_actions
SET visibility_condition = '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb,
    enabled_condition = '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb
WHERE table_name = 'tool_reservation_checkouts' AND action_name IN ('add_item', 'remove_item');

UPDATE metadata.entity_actions
SET visibility_condition = '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb,
    enabled_condition = '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb
WHERE table_name = 'mek_checkouts' AND action_name IN ('add_item', 'remove_item');

-- ============================================================================
-- 9. Create entity actions for "Confirm Checkout"
-- ============================================================================

INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style,
    sort_order, rpc_function, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, refresh_after_action, show_on_detail
) VALUES
(
    'tool_reservation_checkouts', 'confirm_checkout', 'Confirm Checkout',
    'Confirm all tools have been handed to borrower',
    'check_circle', 'success', 15, 'confirm_checkout', true,
    'Confirm all listed tools have been handed to the borrower?',
    '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb,
    '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb,
    true, true
),
(
    'mek_checkouts', 'confirm_checkout', 'Confirm Checkout',
    'Confirm all items have been handed to borrower',
    'check_circle', 'success', 15, 'confirm_mek_checkout', true,
    'Confirm all listed items have been handed to the borrower?',
    '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb,
    '{"field": "status_id.status_key", "value": "preparing", "operator": "eq"}'::jsonb,
    true, true
)
ON CONFLICT (table_name, action_name) DO NOTHING;

-- ============================================================================
-- 10. Add missing entity_action_roles grants
--    Script 16 created entity actions for tool_reservations but never
--    inserted role grants. Also grant for checkout entity actions.
-- ============================================================================

-- Checkout entity actions → neh_staff, neh_admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name IN ('tool_reservation_checkouts', 'mek_checkouts')
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;

-- Parent entity actions → neh_staff, neh_admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name IN ('tool_reservations', 'mek_requests')
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- ADR
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['tool_reservation_checkouts', 'mek_checkouts']::NAME[],
    '23_neh_checkout_restructure',
    'Two-phase checkout: preparing → confirmed',
    'accepted',
    'The original checkout flow immediately transitioned the parent reservation to checked_out status and inserted system notes when the checkout record was created. Staff had no opportunity to add and verify items before committing the checkout.',
    'Split checkout into two phases: (1) "Start Checkout" creates a checkout record in preparing status and navigates to it. Staff adds items via entity actions. (2) "Confirm Checkout" transitions both checkout and parent to checked_out, and inserts system notes on tool instances. Add missing entity_action_roles grants for all tool_reservations and mek_requests entity actions.',
    'Matches the physical workflow — staff gather and verify tools/items before officially checking them out. The preparing status gates Add/Remove Item buttons while Confirm Checkout gates the status transition. System notes are only written when checkout is actually confirmed.',
    'Existing add_checkout_item RPCs still mark serial tool instances as checked_out immediately when added (reserving the specific instance). This is intentional — it prevents double-booking during the preparing phase. If checkout is abandoned, instances would need manual status reset.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '23_neh_checkout_restructure');

COMMIT;

-- ============================================================================
-- Parcels composite index (outside transaction for CONCURRENTLY)
-- ============================================================================
-- The is_eligible() computed column checks lmi_status AND land_bank_status.
-- Individual indexes exist but a composite index allows a single scan
-- instead of bitmap-ANDing two separate indexes (70k+ parcels).

-- NOTE: If running via pgAdmin or a tool that wraps the whole file in a transaction,
-- run this statement separately after the main script completes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_parcels_is_eligible
ON parcels (lmi_status, land_bank_status);
