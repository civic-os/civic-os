-- Neighborhood Engagement Hub - Checkout Items System
-- Replaces simple checkout_instances M:M with a richer child entity supporting
-- both serial (instance-tracked) and quantity-managed tool checkouts.
--
-- 1. Add "Checked Out" status to tool_instances
-- 2. Drop checkout_instances, create checkout_items
-- 3. Configure metadata (entity, properties, permissions)
-- 4. Create add_checkout_item() RPC with serial/qty validation
-- 5. Create remove_checkout_item() RPC
-- 6. Update return_tool_reservation() to release instances
-- 7. Entity action buttons on tool_reservation_checkouts
-- 8. Return/damage actions on checkouts
BEGIN;

SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';

-- ============================================================================
-- 1. Add "Checked Out" status to tool_instances
--    Serial tools need a status to indicate they're currently lent out,
--    preventing double-booking.
-- ============================================================================

INSERT INTO metadata.statuses (entity_type, display_name, status_key, color, sort_order, is_initial, is_terminal)
VALUES ('tool_instances', 'Checked Out', 'checked_out', '#f59e0b', 20, false, false)
ON CONFLICT (entity_type, status_key) DO NOTHING;

-- ============================================================================
-- 2. Drop checkout_instances, create checkout_items
--    Old table was a simple M:M (checkout_id + tool_instance_id composite PK).
--    New table is a child entity with surrogate PK, supporting both serial
--    (tool_instance_id) and qty-managed (quantity > 1) checkouts.
-- ============================================================================

-- Remove the old M:M metadata property
DELETE FROM metadata.properties
WHERE table_name = 'tool_reservation_checkouts' AND column_name = 'checkout_instances_m2m';

-- Drop old table
DROP TABLE IF EXISTS checkout_instances;

-- Create new child entity
CREATE TABLE checkout_items (
    id BIGSERIAL PRIMARY KEY,
    checkout_id BIGINT NOT NULL REFERENCES tool_reservation_checkouts(id) ON DELETE CASCADE,
    tool_type_id INT NOT NULL REFERENCES tool_types(id),
    tool_instance_id INT REFERENCES tool_instances(id),  -- NULL for qty-managed
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for FK lookups and uniqueness
CREATE INDEX idx_checkout_items_checkout_id ON checkout_items(checkout_id);
CREATE INDEX idx_checkout_items_tool_type_id ON checkout_items(tool_type_id);
CREATE INDEX idx_checkout_items_tool_instance_id ON checkout_items(tool_instance_id) WHERE tool_instance_id IS NOT NULL;

-- Prevent double-checkout of the same serial instance
CREATE UNIQUE INDEX idx_checkout_items_unique_instance
ON checkout_items(tool_instance_id)
WHERE tool_instance_id IS NOT NULL;

-- ============================================================================
-- 3. Configure metadata
-- ============================================================================

-- 3a. Entity registration
INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar)
VALUES ('checkout_items', 'Checkout Items', false)
ON CONFLICT (table_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    show_in_sidebar = EXCLUDED.show_in_sidebar;

-- 3b. Property configuration
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
    ('checkout_items', 'checkout_id',       'Checkout',      10, false, false, false, false),
    ('checkout_items', 'tool_type_id',      'Tool Type',     20, true,  true,  true,  false),
    ('checkout_items', 'tool_instance_id',  'Instance',      30, true,  true,  true,  false),
    ('checkout_items', 'quantity',          'Quantity',      40, true,  true,  true,  false),
    ('checkout_items', 'notes',            'Notes',         50, true,  true,  true,  true),
    ('checkout_items', 'created_at',       'Checked Out At', 60, true,  true,  false, false),
    ('checkout_items', 'updated_at',       NULL,            70, false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- 3c. Permissions — staff and admin can manage checkout items
INSERT INTO metadata.permissions (table_name, permission)
VALUES
    ('checkout_items', 'read'),
    ('checkout_items', 'create'),
    ('checkout_items', 'update'),
    ('checkout_items', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant to staff, admin, and global admin/editor roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'checkout_items'
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin', 'editor')
ON CONFLICT DO NOTHING;

-- Borrowers can see their own checkout items (read only)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'checkout_items'
  AND p.permission = 'read'
  AND r.role_key = 'neh_borrower'
ON CONFLICT DO NOTHING;

-- 3d. Database grants
GRANT SELECT ON checkout_items TO authenticated;
GRANT INSERT, UPDATE, DELETE ON checkout_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE checkout_items_id_seq TO authenticated;

-- 3e. RLS policy
ALTER TABLE checkout_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY checkout_items_select ON checkout_items FOR SELECT TO authenticated
USING (has_permission('checkout_items', 'read'));

CREATE POLICY checkout_items_insert ON checkout_items FOR INSERT TO authenticated
WITH CHECK (has_permission('checkout_items', 'create'));

CREATE POLICY checkout_items_update ON checkout_items FOR UPDATE TO authenticated
USING (has_permission('checkout_items', 'update'));

CREATE POLICY checkout_items_delete ON checkout_items FOR DELETE TO authenticated
USING (has_permission('checkout_items', 'delete'));

-- ============================================================================
-- 4. add_checkout_item() RPC
--    Validates serial vs qty-managed rules, inserts row, marks serial
--    instances as "checked_out".
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_checkout_item(
    p_entity_id BIGINT,          -- checkout record ID (passed automatically by entity action)
    p_tool_type_id INT,          -- which tool type
    p_tool_instance_id INT DEFAULT NULL,  -- which specific instance (serial only)
    p_quantity INT DEFAULT 1,    -- how many (qty-managed only)
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_is_qty_managed BOOLEAN;
    v_type_name TEXT;
    v_instance_name TEXT;
    v_instance_status_key TEXT;
    v_checkout_status_key TEXT;
    v_checked_out_status_id INT;
BEGIN
    -- Verify the checkout exists and is in checked_out status
    SELECT s.status_key INTO v_checkout_status_key
    FROM tool_reservation_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout_status_key IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Checkout record not found.');
    END IF;

    IF v_checkout_status_key != 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Items can only be added while checkout is active.');
    END IF;

    -- Look up tool type
    SELECT display_name, is_qty_managed INTO v_type_name, v_is_qty_managed
    FROM tool_types WHERE id = p_tool_type_id;

    IF v_type_name IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Tool type not found.');
    END IF;

    -- Validate based on tracking mode
    IF v_is_qty_managed THEN
        -- Qty-managed: instance must be NULL, quantity required
        IF p_tool_instance_id IS NOT NULL THEN
            RETURN jsonb_build_object('success', false,
                'message', v_type_name || ' is quantity-managed. Do not select a specific instance.');
        END IF;
        IF p_quantity < 1 THEN
            RETURN jsonb_build_object('success', false, 'message', 'Quantity must be at least 1.');
        END IF;
    ELSE
        -- Serial/instance-tracked: instance required, quantity must be 1
        IF p_tool_instance_id IS NULL THEN
            RETURN jsonb_build_object('success', false,
                'message', v_type_name || ' is instance-tracked. Please select a specific tool instance.');
        END IF;

        -- Verify instance belongs to this tool type
        SELECT display_name INTO v_instance_name
        FROM tool_instances
        WHERE id = p_tool_instance_id AND tool_type_id = p_tool_type_id;

        IF v_instance_name IS NULL THEN
            RETURN jsonb_build_object('success', false,
                'message', 'Instance does not belong to tool type "' || v_type_name || '".');
        END IF;

        -- Verify instance is available (in_service)
        SELECT s.status_key INTO v_instance_status_key
        FROM tool_instances ti
        JOIN metadata.statuses s ON ti.status_id = s.id
        WHERE ti.id = p_tool_instance_id;

        IF v_instance_status_key != 'in_service' THEN
            RETURN jsonb_build_object('success', false,
                'message', v_instance_name || ' is not available (current status: ' || v_instance_status_key || ').');
        END IF;

        -- Force quantity to 1 for serial tools
        p_quantity := 1;
    END IF;

    -- Insert checkout item
    INSERT INTO checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes)
    VALUES (p_entity_id, p_tool_type_id, p_tool_instance_id, p_quantity, p_notes);

    -- Mark serial instance as checked out
    IF NOT v_is_qty_managed AND p_tool_instance_id IS NOT NULL THEN
        SELECT id INTO v_checked_out_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

        UPDATE tool_instances SET status_id = v_checked_out_status_id
        WHERE id = p_tool_instance_id;
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', CASE WHEN v_is_qty_managed
            THEN p_quantity || 'x ' || v_type_name || ' added to checkout.'
            ELSE v_instance_name || ' added to checkout.'
        END);
END;
$$;

-- ============================================================================
-- 5. remove_checkout_item() RPC
--    Removes an item from the checkout and returns serial instances to service.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_checkout_item(
    p_entity_id BIGINT,          -- checkout record ID
    p_checkout_item_id BIGINT    -- which item to remove
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_checkout_status_key TEXT;
    v_item RECORD;
    v_in_service_status_id INT;
BEGIN
    -- Verify checkout is still active
    SELECT s.status_key INTO v_checkout_status_key
    FROM tool_reservation_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout_status_key != 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Items can only be removed while checkout is active.');
    END IF;

    -- Find the item
    SELECT ci.*, tt.display_name AS type_name, ti.display_name AS instance_name
    INTO v_item
    FROM checkout_items ci
    JOIN tool_types tt ON ci.tool_type_id = tt.id
    LEFT JOIN tool_instances ti ON ci.tool_instance_id = ti.id
    WHERE ci.id = p_checkout_item_id AND ci.checkout_id = p_entity_id;

    IF v_item IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Checkout item not found.');
    END IF;

    -- Return serial instance to service
    IF v_item.tool_instance_id IS NOT NULL THEN
        SELECT id INTO v_in_service_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

        UPDATE tool_instances SET status_id = v_in_service_status_id
        WHERE id = v_item.tool_instance_id;
    END IF;

    -- Delete the item
    DELETE FROM checkout_items WHERE id = p_checkout_item_id;

    RETURN jsonb_build_object('success', true,
        'message', COALESCE(v_item.instance_name, v_item.type_name) || ' removed from checkout.');
END;
$$;

-- ============================================================================
-- 6. Update return_tool_reservation() to release all serial instances
--    When reservation is marked returned, all checked-out instances go back
--    to in_service status.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.return_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
    v_checkout_id BIGINT;
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_items_returned INT;
BEGIN
    -- Verify current status
    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only checked-out reservations can be returned. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    -- Get the checkout record
    SELECT id INTO v_checkout_id
    FROM tool_reservation_checkouts
    WHERE tool_reservation_id = p_entity_id;

    -- Get status IDs
    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'returned';

    SELECT id INTO v_returned_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    -- Return all serial instances to service
    IF v_checkout_id IS NOT NULL THEN
        UPDATE tool_instances ti
        SET status_id = v_in_service_status_id
        FROM checkout_items ci
        WHERE ci.checkout_id = v_checkout_id
          AND ci.tool_instance_id = ti.id
          AND ti.status_id != v_in_service_status_id;

        GET DIAGNOSTICS v_items_returned = ROW_COUNT;

        -- Mark checkout as returned
        UPDATE tool_reservation_checkouts
        SET status_id = v_returned_status_id
        WHERE id = v_checkout_id;
    END IF;

    -- Transition reservation workflow status
    UPDATE tool_reservations SET workflow_status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true,
        'message', 'Tools marked as returned.' ||
            CASE WHEN v_items_returned > 0
                THEN ' ' || v_items_returned || ' instance(s) returned to service.'
                ELSE ''
            END);
END;
$$;

-- ============================================================================
-- 7. Entity Action Buttons on tool_reservation_checkouts
-- ============================================================================

-- 7a. "Add Item" action
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, refresh_after_action, show_on_detail)
VALUES (
    'tool_reservation_checkouts',
    'add_item',
    'Add Item',
    'Add a tool to this checkout',
    'add_circle',
    'primary',
    10,
    'add_checkout_item',
    '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb,
    true,
    true
);

-- 7b. "Remove Item" action
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, refresh_after_action, show_on_detail)
VALUES (
    'tool_reservation_checkouts',
    'remove_item',
    'Remove Item',
    'Remove a tool from this checkout',
    'remove_circle',
    'warning',
    20,
    'remove_checkout_item',
    '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb,
    true,
    true
);

-- 7c. "Mark Returned" action on checkout record
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, requires_confirmation, confirmation_message, refresh_after_action, show_on_detail)
VALUES (
    'tool_reservation_checkouts',
    'mark_returned',
    'Mark Returned',
    'Mark all items as returned in good condition',
    'check',
    'success',
    30,
    'return_checkout',
    '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb,
    true,
    'Mark all items as returned? This will return serial tools to service.',
    true,
    true
);

-- 7d. "Report Damage" action on checkout record
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, refresh_after_action, show_on_detail)
VALUES (
    'tool_reservation_checkouts',
    'report_damage',
    'Report Damage',
    'Mark items returned with damage reported',
    'warning',
    'error',
    40,
    'report_checkout_damage',
    '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb,
    true,
    true
);

-- 7e. Action parameters for "Add Item"
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, join_table, join_column)
SELECT ea.id, 'p_tool_type_id', 'Tool Type', 'foreign_key', true, 10, 'tool_types', 'id'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'add_item';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, join_table, join_column)
SELECT ea.id, 'p_tool_instance_id', 'Instance (serial tools only)', 'foreign_key', false, 20, 'tool_instances', 'id'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'add_item';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, default_value)
SELECT ea.id, 'p_quantity', 'Quantity (qty-managed tools)', 'number', false, 30, '1'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'add_item';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_notes', 'Notes', 'text', false, 40, 'Optional condition notes...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'add_item';

-- 7f. Action parameters for "Remove Item"
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_checkout_item_id', 'Item ID to Remove', 'number', true, 10, 'Enter the checkout item ID'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts' AND ea.action_name = 'remove_item';

-- ============================================================================
-- 8. Return/Damage RPCs for checkout-level actions
--    These operate on the checkout record directly (vs reservation-level).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.return_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_checkout RECORD;
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_items_count INT;
BEGIN
    -- Get checkout with status
    SELECT c.*, s.status_key INTO v_checkout
    FROM tool_reservation_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Checkout not found.');
    END IF;

    IF v_checkout.status_key != 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Checkout is not in active state.');
    END IF;

    -- Get status IDs
    SELECT id INTO v_returned_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    -- Return all serial instances to service
    UPDATE tool_instances ti
    SET status_id = v_in_service_status_id
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id = ti.id;

    GET DIAGNOSTICS v_items_count = ROW_COUNT;

    -- Mark checkout as returned
    UPDATE tool_reservation_checkouts
    SET status_id = v_returned_status_id
    WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout marked as returned.' ||
            CASE WHEN v_items_count > 0
                THEN ' ' || v_items_count || ' instance(s) returned to service.'
                ELSE ''
            END);
END;
$$;

CREATE OR REPLACE FUNCTION public.report_checkout_damage(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_checkout RECORD;
    v_damaged_status_id INT;
    v_maintenance_status_id INT;
    v_items_count INT;
BEGIN
    -- Get checkout with status
    SELECT c.*, s.status_key INTO v_checkout
    FROM tool_reservation_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Checkout not found.');
    END IF;

    IF v_checkout.status_key != 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Checkout is not in active state.');
    END IF;

    -- Get status IDs
    SELECT id INTO v_damaged_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'returned_damaged';

    SELECT id INTO v_maintenance_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'maintenance';

    -- Move serial instances to maintenance (needs inspection)
    UPDATE tool_instances ti
    SET status_id = v_maintenance_status_id
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id = ti.id;

    GET DIAGNOSTICS v_items_count = ROW_COUNT;

    -- Mark checkout as returned with damage
    UPDATE tool_reservation_checkouts
    SET status_id = v_damaged_status_id,
        damage_reported = true
    WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true,
        'message', 'Damage reported.' ||
            CASE WHEN v_items_count > 0
                THEN ' ' || v_items_count || ' instance(s) moved to maintenance.'
                ELSE ''
            END);
END;
$$;

-- ============================================================================
-- 9. Grant EXECUTE on new RPCs
-- ============================================================================

GRANT EXECUTE ON FUNCTION add_checkout_item(BIGINT, INT, INT, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_checkout_item(BIGINT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION return_checkout(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION report_checkout_damage(BIGINT) TO authenticated;

-- ============================================================================
-- 9b. Entity action role grants
--     Without these, only is_admin() users can execute the action buttons.
--     Staff need all 4 actions; borrowers don't interact with checkouts directly.
-- ============================================================================

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'tool_reservation_checkouts'
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 10. Updated auto_create_checkout trigger
--     Now references checkout_items instead of checkout_instances.
--     Trigger already exists from script 16 on workflow_status_id changes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.auto_create_checkout()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status_key TEXT;
    v_checkout_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.workflow_status_id;

    IF v_status_key = 'checked_out' THEN
        SELECT id INTO v_checkout_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

        INSERT INTO public.tool_reservation_checkouts (tool_reservation_id, status_id)
        VALUES (NEW.id, v_checkout_status_id)
        ON CONFLICT (tool_reservation_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- ============================================================================
-- Schema Decision (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['checkout_items', 'tool_reservation_checkouts']::NAME[],
    '17_neh_checkout_items',
    'Checkout items as hybrid serial/qty-managed tracking entity',
    'accepted',
    'Tool reservation checkouts previously only tracked that a checkout occurred, not which specific items were included. Staff needed item-level tracking for accountability and to mark individual tool_instances as checked out/returned.',
    'Created checkout_items table that tracks individual items checked out during a tool reservation checkout. Serial tools (is_qty_managed=false) reference a specific tool_instance_id and transition the instance to checked_out status. Qty-managed tools (is_qty_managed=true) only record a quantity with no instance tracking. RPCs add_checkout_item and remove_checkout_item enforce these rules.',
    'A single table with nullable tool_instance_id (NULL for qty-managed) avoids needing two separate tables. The tool_type_id is always present as the common denominator. This mirrors how the M:M tool selection works in the guided form (tool_reservation_tool_items) but at the physical checkout level.',
    'tool_instances.status_id is now managed by checkout RPCs (add sets checked_out, return_checkout sets in_service). Deleting a checkout_item via remove_checkout_item also releases the instance. Entity action buttons on checkout detail page provide the staff UI.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '17_neh_checkout_items');

COMMIT;

-- Notify PostgREST to reload schema (new table + RPCs)
NOTIFY pgrst, 'reload schema';
