-- Neighborhood Engagement Hub - MEK Checkout System
-- Adds checkout tracking for Mobile Event Kit requests, mirroring the tool
-- reservation checkout pattern from script 17.
--
-- 1. Create mek_checkouts table (photos, condition tracking)
-- 2. Create mek_checkout_items table (what was handed out)
-- 3. Configure metadata (entities, properties, permissions)
-- 4. Create add_mek_checkout_item() / remove_mek_checkout_item() RPCs
-- 5. Create return_mek_checkout() / report_mek_checkout_damage() RPCs
-- 6. Entity action buttons on mek_checkouts
-- 7. Auto-create checkout trigger on MEK status change to checked_out
BEGIN;

SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';

-- ============================================================================
-- 1. Create mek_checkouts table
--    Child record of mek_requests, created automatically when status → checked_out.
--    Stores checkout/return photos and condition notes.
-- ============================================================================

CREATE TABLE mek_checkouts (
    id BIGSERIAL PRIMARY KEY,
    mek_request_id BIGINT NOT NULL REFERENCES mek_requests(id) ON DELETE CASCADE,
    checkout_photos UUID,       -- PhotoGallery: condition at pickup
    return_photos UUID,         -- PhotoGallery: condition at return
    checkout_notes TEXT,
    return_notes TEXT,
    damage_reported BOOLEAN NOT NULL DEFAULT false,
    status_id INT REFERENCES metadata.statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mek_checkouts_request ON mek_checkouts(mek_request_id);

-- Register entity BEFORE inserting statuses (entity_type FK requires it)
INSERT INTO metadata.entities (table_name, display_name, description, show_in_sidebar)
VALUES ('mek_checkouts', 'MEK Checkout', 'Checkout records for mobile event kit requests', false)
ON CONFLICT (table_name) DO NOTHING;

-- Register status type (statuses.entity_type FK references status_types)
INSERT INTO metadata.status_types (entity_type)
VALUES ('mek_checkouts')
ON CONFLICT DO NOTHING;

-- Statuses for mek_checkouts
INSERT INTO metadata.statuses (entity_type, display_name, status_key, color, sort_order, is_initial, is_terminal)
VALUES
    ('mek_checkouts', 'Checked Out', 'checked_out', '#3b82f6', 10, true, false),
    ('mek_checkouts', 'Returned', 'returned', '#22c55e', 20, false, true),
    ('mek_checkouts', 'Damaged', 'damaged', '#ef4444', 30, false, true)
ON CONFLICT (entity_type, status_key) DO NOTHING;

-- ============================================================================
-- 2. Create mek_checkout_items table
--    Tracks individual items actually handed out for the MEK request.
--    Same hybrid model: serial tools get tool_instance_id, qty-managed get quantity.
-- ============================================================================

CREATE TABLE mek_checkout_items (
    id BIGSERIAL PRIMARY KEY,
    checkout_id BIGINT NOT NULL REFERENCES mek_checkouts(id) ON DELETE CASCADE,
    tool_type_id INT NOT NULL REFERENCES tool_types(id),
    tool_instance_id INT REFERENCES tool_instances(id),  -- NULL for qty-managed
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent same instance from being checked out twice
CREATE UNIQUE INDEX idx_mek_checkout_items_unique_instance
ON mek_checkout_items(tool_instance_id) WHERE tool_instance_id IS NOT NULL;

CREATE INDEX idx_mek_checkout_items_checkout ON mek_checkout_items(checkout_id);
CREATE INDEX idx_mek_checkout_items_type ON mek_checkout_items(tool_type_id);

-- ============================================================================
-- 3. Metadata configuration
-- ============================================================================

-- 3a. Entity metadata (mek_checkouts already registered above for status FK)
INSERT INTO metadata.entities (table_name, display_name, description, show_in_sidebar)
VALUES ('mek_checkout_items', 'MEK Checkout Item', 'Individual items checked out for a MEK request', false)
ON CONFLICT (table_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    show_in_sidebar = EXCLUDED.show_in_sidebar;

-- 3b. Property metadata for mek_checkouts
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
    ('mek_checkouts', 'mek_request_id', 'MEK Request', 10, true, true, false, false),
    ('mek_checkouts', 'checkout_photos', 'Checkout Photos', 20, true, true, false, true),
    ('mek_checkouts', 'return_photos', 'Return Photos', 30, true, true, false, true),
    ('mek_checkouts', 'checkout_notes', 'Checkout Notes', 40, true, true, false, true),
    ('mek_checkouts', 'return_notes', 'Return Notes', 50, true, true, false, true),
    ('mek_checkouts', 'damage_reported', 'Damage Reported', 60, true, true, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- status_id needs status_entity_type so the Status type system renders badges/names
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('mek_checkouts', 'status_id', 'Checkout Status', 'mek_checkouts', 70, true, true, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    status_entity_type = EXCLUDED.status_entity_type,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- 3c. Property metadata for mek_checkout_items
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
    ('mek_checkout_items', 'checkout_id', 'Checkout', 10, false, true, false, false),
    ('mek_checkout_items', 'tool_type_id', 'Tool Type', 20, true, true, false, false),
    ('mek_checkout_items', 'tool_instance_id', 'Instance', 30, true, true, false, false),
    ('mek_checkout_items', 'quantity', 'Qty', 40, true, true, false, false),
    ('mek_checkout_items', 'notes', 'Notes', 50, true, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- 3d. Permissions
INSERT INTO metadata.permissions (table_name, permission)
VALUES
    ('mek_checkouts', 'read'),
    ('mek_checkouts', 'create'),
    ('mek_checkouts', 'update'),
    ('mek_checkouts', 'delete'),
    ('mek_checkout_items', 'read'),
    ('mek_checkout_items', 'create'),
    ('mek_checkout_items', 'update'),
    ('mek_checkout_items', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant to staff, admin, and global admin/editor roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('mek_checkouts', 'mek_checkout_items')
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin', 'editor')
ON CONFLICT DO NOTHING;

-- Borrowers get read access to their own checkouts
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('mek_checkouts', 'mek_checkout_items')
  AND p.permission = 'read'
  AND r.role_key = 'neh_borrower'
ON CONFLICT DO NOTHING;

-- 3e. Database grants
GRANT SELECT, INSERT, UPDATE, DELETE ON mek_checkouts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mek_checkout_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE mek_checkouts_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE mek_checkout_items_id_seq TO authenticated;
GRANT SELECT ON mek_checkouts TO web_anon;

-- 3f. RLS policies
ALTER TABLE mek_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mek_checkout_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY mek_checkouts_select ON mek_checkouts FOR SELECT TO authenticated
USING (has_permission('mek_checkouts', 'read'));

CREATE POLICY mek_checkouts_insert ON mek_checkouts FOR INSERT TO authenticated
WITH CHECK (has_permission('mek_checkouts', 'create'));

CREATE POLICY mek_checkouts_update ON mek_checkouts FOR UPDATE TO authenticated
USING (has_permission('mek_checkouts', 'update'));

CREATE POLICY mek_checkouts_delete ON mek_checkouts FOR DELETE TO authenticated
USING (has_permission('mek_checkouts', 'delete'));

CREATE POLICY mek_checkout_items_select ON mek_checkout_items FOR SELECT TO authenticated
USING (has_permission('mek_checkout_items', 'read'));

CREATE POLICY mek_checkout_items_insert ON mek_checkout_items FOR INSERT TO authenticated
WITH CHECK (has_permission('mek_checkout_items', 'create'));

CREATE POLICY mek_checkout_items_update ON mek_checkout_items FOR UPDATE TO authenticated
USING (has_permission('mek_checkout_items', 'update'));

CREATE POLICY mek_checkout_items_delete ON mek_checkout_items FOR DELETE TO authenticated
USING (has_permission('mek_checkout_items', 'delete'));

-- ============================================================================
-- 4. RPCs: add_mek_checkout_item / remove_mek_checkout_item
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_mek_checkout_item(
    p_entity_id BIGINT,      -- mek_checkouts.id (entity action passes this)
    p_tool_type_id INT,
    p_tool_instance_id INT DEFAULT NULL,
    p_quantity INT DEFAULT 1,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql AS $$
DECLARE
    v_tool_type RECORD;
    v_instance RECORD;
    v_checked_out_status_id INT;
BEGIN
    -- Validate tool type exists
    SELECT id, display_name, is_qty_managed INTO v_tool_type
    FROM tool_types WHERE id = p_tool_type_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tool type not found' USING ERRCODE = 'P0001';
    END IF;

    -- Get "Checked Out" status for tool_instances
    SELECT id INTO v_checked_out_status_id
    FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Validate serial vs qty-managed
    IF NOT v_tool_type.is_qty_managed THEN
        -- Serial tool: instance required
        IF p_tool_instance_id IS NULL THEN
            RAISE EXCEPTION 'Serial tool "%" requires a specific instance to be selected.', v_tool_type.display_name
                USING ERRCODE = 'P0001';
        END IF;

        -- Validate instance exists and is available
        SELECT id, display_name, status_id INTO v_instance
        FROM tool_instances WHERE id = p_tool_instance_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Tool instance not found.' USING ERRCODE = 'P0001';
        END IF;

        -- Check instance is in_service
        IF v_instance.status_id != (SELECT id FROM metadata.statuses WHERE entity_type='tool_instances' AND status_key='in_service') THEN
            RAISE EXCEPTION 'Instance "%" is not currently available for checkout.', v_instance.display_name
                USING ERRCODE = 'P0001';
        END IF;

        -- Insert item and mark instance as checked out
        INSERT INTO mek_checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes)
        VALUES (p_entity_id, p_tool_type_id, p_tool_instance_id, 1, p_notes);

        UPDATE tool_instances SET status_id = v_checked_out_status_id WHERE id = p_tool_instance_id;

        RETURN json_build_object('success', true, 'message', v_instance.display_name || ' added to checkout.');
    ELSE
        -- Qty-managed tool: just record the quantity
        INSERT INTO mek_checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes)
        VALUES (p_entity_id, p_tool_type_id, NULL, COALESCE(p_quantity, 1), p_notes);

        RETURN json_build_object('success', true, 'message',
            COALESCE(p_quantity, 1)::TEXT || 'x ' || v_tool_type.display_name || ' added to checkout.');
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_mek_checkout_item(
    p_entity_id BIGINT,        -- mek_checkouts.id
    p_checkout_item_id BIGINT  -- mek_checkout_items.id to remove
)
RETURNS JSON
LANGUAGE plpgsql AS $$
DECLARE
    v_item RECORD;
    v_in_service_status_id INT;
BEGIN
    -- Find the item
    SELECT ci.id, ci.tool_instance_id, tt.display_name as tool_name
    INTO v_item
    FROM mek_checkout_items ci
    JOIN tool_types tt ON tt.id = ci.tool_type_id
    WHERE ci.id = p_checkout_item_id AND ci.checkout_id = p_entity_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Checkout item not found on this checkout record.' USING ERRCODE = 'P0001';
    END IF;

    -- If serial tool, return instance to service
    IF v_item.tool_instance_id IS NOT NULL THEN
        SELECT id INTO v_in_service_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

        UPDATE tool_instances SET status_id = v_in_service_status_id
        WHERE id = v_item.tool_instance_id;
    END IF;

    DELETE FROM mek_checkout_items WHERE id = p_checkout_item_id;

    RETURN json_build_object('success', true, 'message', v_item.tool_name || ' removed from checkout.');
END;
$$;

-- ============================================================================
-- 5. RPCs: return_mek_checkout / report_mek_checkout_damage
-- ============================================================================

CREATE OR REPLACE FUNCTION public.return_mek_checkout(p_entity_id BIGINT)
RETURNS JSON
LANGUAGE plpgsql AS $$
DECLARE
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_released INT := 0;
BEGIN
    SELECT id INTO v_returned_status_id
    FROM metadata.statuses WHERE entity_type = 'mek_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id
    FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    -- Mark checkout as returned
    UPDATE mek_checkouts SET status_id = v_returned_status_id, updated_at = now()
    WHERE id = p_entity_id;

    -- Release all serial instances
    UPDATE tool_instances
    SET status_id = v_in_service_status_id
    WHERE id IN (
        SELECT tool_instance_id FROM mek_checkout_items
        WHERE checkout_id = p_entity_id AND tool_instance_id IS NOT NULL
    );
    GET DIAGNOSTICS v_released = ROW_COUNT;

    -- Also update the parent mek_request status to returned
    UPDATE mek_requests
    SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type='mek_requests' AND status_key='returned')
    WHERE id = (SELECT mek_request_id FROM mek_checkouts WHERE id = p_entity_id);

    RETURN json_build_object('success', true, 'message',
        'Checkout marked as returned. ' || v_released || ' instance(s) returned to service.');
END;
$$;

CREATE OR REPLACE FUNCTION public.report_mek_checkout_damage(p_entity_id BIGINT)
RETURNS JSON
LANGUAGE plpgsql AS $$
DECLARE
    v_damaged_status_id INT;
BEGIN
    SELECT id INTO v_damaged_status_id
    FROM metadata.statuses WHERE entity_type = 'mek_checkouts' AND status_key = 'damaged';

    UPDATE mek_checkouts
    SET status_id = v_damaged_status_id, damage_reported = true, updated_at = now()
    WHERE id = p_entity_id;

    RETURN json_build_object('success', true, 'message', 'Damage reported. Please add photos and notes.');
END;
$$;

-- ============================================================================
-- 6. Entity action buttons on mek_checkouts
-- ============================================================================

-- Add Item
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, refresh_after_action, show_on_detail)
VALUES ('mek_checkouts', 'add_item', 'Add Item', 'Add an item to this checkout', 'add_circle', 'primary', 10, 'add_mek_checkout_item',
        '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb, true, true)
ON CONFLICT (table_name, action_name) DO NOTHING;

-- Add Item parameters
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, join_table, join_column)
SELECT ea.id, 'p_tool_type_id', 'Tool Type', 'foreign_key', true, 10, 'tool_types', 'id'
FROM metadata.entity_actions ea WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'add_item';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, join_table, join_column)
SELECT ea.id, 'p_tool_instance_id', 'Instance (serial tools only)', 'foreign_key', false, 20, 'tool_instances', 'id'
FROM metadata.entity_actions ea WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'add_item';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder, default_value)
SELECT ea.id, 'p_quantity', 'Quantity (qty-managed tools)', 'number', false, 30, 'Enter quantity', '1'
FROM metadata.entity_actions ea WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'add_item';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_notes', 'Notes', 'text', false, 40, 'Condition notes...'
FROM metadata.entity_actions ea WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'add_item';

-- Remove Item
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, refresh_after_action, show_on_detail)
VALUES ('mek_checkouts', 'remove_item', 'Remove Item', 'Remove an item from this checkout', 'remove_circle', 'warning', 20, 'remove_mek_checkout_item',
        '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb, true, true)
ON CONFLICT (table_name, action_name) DO NOTHING;

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_checkout_item_id', 'Item ID to Remove', 'number', true, 10, 'Enter checkout item ID'
FROM metadata.entity_actions ea WHERE ea.table_name = 'mek_checkouts' AND ea.action_name = 'remove_item';

-- Mark Returned
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, requires_confirmation, confirmation_message, refresh_after_action, show_on_detail)
VALUES ('mek_checkouts', 'mark_returned', 'Mark Returned', 'Mark this checkout as returned', 'assignment_return', 'success', 30, 'return_mek_checkout',
        '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb, true, 'Confirm all items have been returned and inspected?', true, true)
ON CONFLICT (table_name, action_name) DO NOTHING;

-- Report Damage
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, visibility_condition, refresh_after_action, show_on_detail)
VALUES ('mek_checkouts', 'report_damage', 'Report Damage', 'Report damage to equipment', 'warning', 'error', 40, 'report_mek_checkout_damage',
        '{"field": "status_id.status_key", "operator": "eq", "value": "checked_out"}'::jsonb, true, true)
ON CONFLICT (table_name, action_name) DO NOTHING;

-- ============================================================================
-- 6b. Entity action role grants
-- ============================================================================

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'mek_checkouts'
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 7. GRANT EXECUTE on RPCs
-- ============================================================================

GRANT EXECUTE ON FUNCTION add_mek_checkout_item(BIGINT, INT, INT, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_mek_checkout_item(BIGINT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION return_mek_checkout(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION report_mek_checkout_damage(BIGINT) TO authenticated;

-- ============================================================================
-- 8. Auto-create MEK checkout trigger
--    When mek_requests.status_id changes to 'checked_out', auto-create a
--    mek_checkouts record.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.auto_create_mek_checkout()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status_key TEXT;
    v_checkout_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.status_id;

    IF v_status_key = 'checked_out' THEN
        SELECT id INTO v_checkout_status_id
        FROM metadata.statuses
        WHERE entity_type = 'mek_checkouts' AND status_key = 'checked_out';

        INSERT INTO mek_checkouts (mek_request_id, status_id)
        VALUES (NEW.id, v_checkout_status_id)
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_create_mek_checkout ON mek_requests;
CREATE TRIGGER trg_auto_create_mek_checkout
    AFTER UPDATE OF status_id ON mek_requests
    FOR EACH ROW
    WHEN (NEW.status_id IS DISTINCT FROM OLD.status_id)
    EXECUTE FUNCTION auto_create_mek_checkout();

-- ============================================================================
-- 9. PhotoGallery configuration for mek_checkouts
-- ============================================================================

INSERT INTO metadata.photo_gallery_config (table_name, column_name, max_images)
VALUES
    ('mek_checkouts', 'checkout_photos', 10),
    ('mek_checkouts', 'return_photos', 10)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ============================================================================
-- 10. Add mek_checkouts as inverse relationship on mek_requests detail page
-- ============================================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, show_on_list, show_on_detail)
VALUES ('mek_checkouts', 'mek_request_id', 'MEK Request', true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name;

-- ============================================================================
-- 11. Ensure admin role has full permissions on ALL entities
--     Catch-all: admin should never be locked out of any table.
-- ============================================================================

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE r.role_key = 'admin'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Schema Decision (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['mek_checkouts', 'mek_checkout_items', 'mek_requests']::NAME[],
    '18_neh_mek_checkouts',
    'MEK checkouts mirror tool reservation checkout pattern',
    'accepted',
    'Mobile Event Kit requests had no checkout tracking — just a status change on the request itself. Staff needed to record which specific equipment was included, track condition with photos, and report damage.',
    'Created mek_checkouts and mek_checkout_items tables following the same architecture as tool_reservation_checkouts/checkout_items. Auto-creates checkout record when mek_requests.status_id transitions to checked_out. RPCs: add_mek_checkout_item, remove_mek_checkout_item, return_mek_checkout, report_mek_checkout_damage. Shared tool_instances status management across both checkout systems.',
    'Reusing the same hybrid serial/qty-managed pattern from checkout_items provides consistency. Both systems share tool_instances for status tracking (checked_out/in_service). Separate tables (not a polymorphic single table) because MEK checkouts have MEK-specific fields (photos, damage reporting) that do not apply to tool reservation checkouts.',
    'Two checkout systems now manage tool_instances.status_id. An instance can only be checked out to one system at a time (enforced by in_service status check in both add_*_checkout_item RPCs). PhotoGallery columns on mek_checkouts enable before/after condition documentation.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '18_neh_mek_checkouts');

COMMIT;

NOTIFY pgrst, 'reload schema';
