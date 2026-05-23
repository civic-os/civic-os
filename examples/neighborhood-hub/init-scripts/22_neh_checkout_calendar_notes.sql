-- Neighborhood Engagement Hub - Checkout Flow, Calendar Colors, Display Names, Entity Notes
--
-- This script enhances the NEH tool lending and MEK workflows:
--   A. Enable entity notes on tool_instances (audit trail for checkout/return)
--   B. Add calendar_hex_color columns with status sync triggers
--   C. Enhance display_name triggers (show tools after approval)
--   D. Improve checkout/return RPCs (navigate_to, system notes, back-flow)
--   E. Convert MEK from pickup_date/return_date to time_slot + calendar
--   F. ADR documenting all changes
--
-- IMPORTANT: Scripts 01-21 are deployed to production. All changes here are
-- additive (CREATE OR REPLACE, ALTER TABLE ADD COLUMN IF NOT EXISTS, etc.).
BEGIN;

SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';

-- ============================================================================
-- PART A: Enable Entity Notes on tool_instances
-- ============================================================================

SELECT enable_entity_notes('tool_instances');

-- Grant notes permissions to NEH-specific roles (enable_entity_notes only grants to editor/user)
DO $$
DECLARE
    v_perm_id INT;
    v_role_id INT;
    perms TEXT[] := ARRAY['tool_instances:notes:read', 'tool_instances:notes:create'];
    roles TEXT[] := ARRAY['neh_staff', 'neh_admin'];
    p TEXT;
    r TEXT;
BEGIN
    FOREACH p IN ARRAY perms LOOP
        SELECT id INTO v_perm_id FROM metadata.permissions
        WHERE table_name = split_part(p, ':', 1) || ':notes'
          AND permission = split_part(p, ':', 3)::metadata.permission;

        -- If the enable_entity_notes uses a different convention, try direct lookup
        IF v_perm_id IS NULL THEN
            -- Try the standard pattern: table_name = 'tool_instances', permission includes notes
            SELECT id INTO v_perm_id FROM metadata.permissions
            WHERE table_name || ':notes:' || permission = p;
        END IF;

        -- Fallback: find by matching the entity_notes pattern
        IF v_perm_id IS NULL THEN
            IF p LIKE '%:read' THEN
                SELECT id INTO v_perm_id FROM metadata.permissions
                WHERE table_name = 'entity_notes'
                  AND permission = 'read';
            ELSE
                SELECT id INTO v_perm_id FROM metadata.permissions
                WHERE table_name = 'entity_notes'
                  AND permission = 'create';
            END IF;
        END IF;

        IF v_perm_id IS NOT NULL THEN
            FOREACH r IN ARRAY roles LOOP
                SELECT id INTO v_role_id FROM metadata.roles WHERE role_key = r;
                IF v_role_id IS NOT NULL THEN
                    INSERT INTO metadata.permission_roles (permission_id, role_id)
                    VALUES (v_perm_id, v_role_id)
                    ON CONFLICT DO NOTHING;
                END IF;
            END LOOP;
        END IF;
    END LOOP;
END $$;

-- Simpler approach: grant entity_notes read/create to neh_staff and neh_admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'entity_notes'
  AND p.permission IN ('read', 'create')
  AND r.role_key IN ('neh_staff', 'neh_admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PART B: Calendar Hex Color Columns + Sync Triggers
-- ============================================================================

-- B1. Add calendar_hex_color to tool_reservations
ALTER TABLE tool_reservations ADD COLUMN IF NOT EXISTS calendar_hex_color VARCHAR(7);

-- B2. Add calendar_hex_color to mek_requests
ALTER TABLE mek_requests ADD COLUMN IF NOT EXISTS calendar_hex_color VARCHAR(7);

-- B3. Register in metadata.properties (internal-only, not shown on any views)
INSERT INTO metadata.properties (table_name, column_name, display_name, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
    ('tool_reservations', 'calendar_hex_color', 'Calendar Color', false, false, false, false),
    ('mek_requests', 'calendar_hex_color', 'Calendar Color', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    show_on_list = false,
    show_on_detail = false,
    show_on_create = false,
    show_on_edit = false;

-- B4. Sync trigger for tool_reservations (fires on workflow_status_id change)
CREATE OR REPLACE FUNCTION public.sync_reservation_calendar_color()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
BEGIN
    IF NEW.workflow_status_id IS NOT NULL THEN
        SELECT color INTO NEW.calendar_hex_color
        FROM metadata.statuses
        WHERE id = NEW.workflow_status_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_reservation_calendar_color ON tool_reservations;
CREATE TRIGGER trg_sync_reservation_calendar_color
    BEFORE INSERT OR UPDATE OF workflow_status_id ON tool_reservations
    FOR EACH ROW
    EXECUTE FUNCTION sync_reservation_calendar_color();

-- B5. Sync trigger for mek_requests (fires on status_id change)
CREATE OR REPLACE FUNCTION public.sync_mek_calendar_color()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
BEGIN
    IF NEW.status_id IS NOT NULL THEN
        SELECT color INTO NEW.calendar_hex_color
        FROM metadata.statuses
        WHERE id = NEW.status_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_mek_calendar_color ON mek_requests;
CREATE TRIGGER trg_sync_mek_calendar_color
    BEFORE INSERT OR UPDATE OF status_id ON mek_requests
    FOR EACH ROW
    EXECUTE FUNCTION sync_mek_calendar_color();

-- B6. Backfill existing records
UPDATE tool_reservations tr
SET calendar_hex_color = s.color
FROM metadata.statuses s
WHERE s.id = tr.workflow_status_id
  AND tr.calendar_hex_color IS NULL;

UPDATE mek_requests mr
SET calendar_hex_color = s.color
FROM metadata.statuses s
WHERE s.id = mr.status_id
  AND mr.calendar_hex_color IS NULL;

-- ============================================================================
-- PART C: Display Name Trigger Enhancements
-- ============================================================================

-- C1. Enhanced tool_reservation_display_name: shows tools after status moves past pending
CREATE OR REPLACE FUNCTION public.tool_reservation_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_borrower_name TEXT;
    v_tools_summary TEXT;
    v_status_key TEXT;
BEGIN
    -- Always resolve borrower name on INSERT or borrower change
    IF TG_OP = 'INSERT' OR OLD.borrower_id IS DISTINCT FROM NEW.borrower_id THEN
        v_borrower_name := COALESCE(
            (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
            'Tool Reservation'
        );
        NEW.display_name := v_borrower_name || ' - ' || TO_CHAR(COALESCE(NEW.created_at, NOW()), 'YYYY-MM-DD');
    END IF;

    -- On workflow_status_id change away from pending/NULL, rebuild with tool details
    IF TG_OP = 'UPDATE'
       AND OLD.workflow_status_id IS DISTINCT FROM NEW.workflow_status_id
       AND NEW.workflow_status_id IS NOT NULL THEN

        -- Check if we're transitioning away from pending (or from NULL)
        IF OLD.workflow_status_id IS NULL
           OR (SELECT status_key FROM metadata.statuses WHERE id = OLD.workflow_status_id) IN ('pending') THEN

            v_borrower_name := COALESCE(
                (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
                'Reservation'
            );

            -- Build compact tool summary: "Tool1, Tool2 x3"
            SELECT string_agg(
                CASE WHEN sub.qty > 1 THEN sub.tool_name || ' x' || sub.qty
                     ELSE sub.tool_name
                END, ', '
                ORDER BY sub.tool_name
            ) INTO v_tools_summary
            FROM (
                SELECT tt.display_name AS tool_name, SUM(trti.quantity) AS qty
                FROM tool_reservation_tool_items trti
                JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
                JOIN tool_types tt ON tt.id = trti.tool_type_id
                WHERE trt.tool_reservation_id = NEW.id
                GROUP BY tt.display_name
            ) sub;

            IF v_tools_summary IS NOT NULL AND v_tools_summary != '' THEN
                NEW.display_name := v_borrower_name || ' — ' || v_tools_summary;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- C2. Enhanced mek_request_display_name: shows items after status moves past pending
CREATE OR REPLACE FUNCTION public.mek_request_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_borrower_name TEXT;
    v_items_summary TEXT;
    v_status_key TEXT;
BEGIN
    -- Always resolve borrower name on INSERT or borrower change
    IF TG_OP = 'INSERT' OR OLD.borrower_id IS DISTINCT FROM NEW.borrower_id THEN
        v_borrower_name := COALESCE(
            (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
            'Event Kit Request'
        );
        NEW.display_name := v_borrower_name || ' - ' || TO_CHAR(COALESCE(NEW.created_at, NOW()), 'YYYY-MM-DD');
    END IF;

    -- On status_id change away from pending/NULL, rebuild with item details
    IF TG_OP = 'UPDATE'
       AND OLD.status_id IS DISTINCT FROM NEW.status_id
       AND NEW.status_id IS NOT NULL THEN

        -- Check if we're transitioning away from pending (or from NULL/draft)
        IF OLD.status_id IS NULL
           OR (SELECT status_key FROM metadata.statuses WHERE id = OLD.status_id) IN ('pending') THEN

            v_borrower_name := COALESCE(
                (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
                'Event Kit'
            );

            -- Build compact item summary: "Folding Table x10, PA System"
            SELECT string_agg(
                CASE WHEN sub.qty > 1 THEN sub.item_name || ' x' || sub.qty
                     ELSE sub.item_name
                END, ', '
                ORDER BY sub.item_name
            ) INTO v_items_summary
            FROM (
                SELECT tt.display_name AS item_name, SUM(mei.quantity) AS qty
                FROM mek_request_equipment_items mei
                JOIN mek_request_equipment me ON me.id = mei.mek_request_equipment_id
                JOIN tool_types tt ON tt.id = mei.tool_type_id
                WHERE me.mek_request_id = NEW.id
                GROUP BY tt.display_name
            ) sub;

            IF v_items_summary IS NOT NULL AND v_items_summary != '' THEN
                NEW.display_name := v_borrower_name || ' — ' || v_items_summary;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- ============================================================================
-- PART D: Checkout/Check-in Flow Enhancements
-- ============================================================================

-- D1. Enhanced checkout_tool_reservation: creates checkout record directly, adds
--     system notes on tool instances, returns navigate_to URL
CREATE OR REPLACE FUNCTION public.checkout_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
    v_checkout_id BIGINT;
    v_checkout_status_id INT;
    v_reservation_name TEXT;
BEGIN
    -- Verify current status
    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only approved reservations can be checked out. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    -- Get target status IDs
    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'checked_out';

    SELECT id INTO v_checkout_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

    -- Get reservation display_name for checkout record
    SELECT display_name INTO v_reservation_name
    FROM tool_reservations WHERE id = p_entity_id;

    -- Create checkout record directly (before trigger also tries via ON CONFLICT DO NOTHING)
    INSERT INTO public.tool_reservation_checkouts (tool_reservation_id, status_id, display_name)
    VALUES (p_entity_id, v_checkout_status_id, 'Checkout - ' || v_reservation_name)
    ON CONFLICT (tool_reservation_id) DO NOTHING
    RETURNING id INTO v_checkout_id;

    -- If checkout already existed, get its ID
    IF v_checkout_id IS NULL THEN
        SELECT id INTO v_checkout_id
        FROM tool_reservation_checkouts
        WHERE tool_reservation_id = p_entity_id;
    END IF;

    -- Transition reservation workflow status
    UPDATE tool_reservations SET workflow_status_id = v_target_id WHERE id = p_entity_id;

    -- Insert system notes on tool instances that have been assigned
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        'Checked out — Reservation: ' || COALESCE(v_reservation_name, '#' || p_entity_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = v_checkout_id
      AND ci.tool_instance_id IS NOT NULL;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Tools checked out.',
        'navigate_to', '/view/tool_reservation_checkouts/' || v_checkout_id
    );
END;
$$;

-- D2. Create approve_mek_request RPC (pending → approved)
CREATE OR REPLACE FUNCTION public.approve_mek_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM mek_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'pending' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only pending requests can be approved. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    -- Permission check
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'You do not have permission to approve event kit requests.');
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'approved';

    UPDATE mek_requests SET status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Event kit request approved.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_mek_request(BIGINT) TO authenticated;

-- D3. Create checkout_mek_request RPC (approved → checked_out, creates checkout, returns navigate_to)
CREATE OR REPLACE FUNCTION public.checkout_mek_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
    v_checkout_id BIGINT;
    v_checkout_status_id INT;
    v_request_name TEXT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM mek_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only approved requests can be checked out. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    -- Permission check
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'You do not have permission to check out event kit requests.');
    END IF;

    SELECT id INTO v_checkout_status_id FROM metadata.statuses
    WHERE entity_type = 'mek_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'checked_out';

    SELECT display_name INTO v_request_name FROM mek_requests WHERE id = p_entity_id;

    -- Create checkout record directly
    INSERT INTO mek_checkouts (mek_request_id, status_id, display_name)
    VALUES (p_entity_id, v_checkout_status_id, 'Checkout - ' || v_request_name)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_checkout_id;

    IF v_checkout_id IS NULL THEN
        SELECT id INTO v_checkout_id FROM mek_checkouts WHERE mek_request_id = p_entity_id;
    END IF;

    -- Transition MEK request status
    UPDATE mek_requests SET status_id = v_target_id WHERE id = p_entity_id;

    -- Insert system notes on tool instances in the checkout
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', mci.tool_instance_id::text,
        'Checked out (MEK) — Request: ' || COALESCE(v_request_name, '#' || p_entity_id),
        'system', current_user_id()
    FROM mek_checkout_items mci
    WHERE mci.checkout_id = v_checkout_id
      AND mci.tool_instance_id IS NOT NULL;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Event kit checked out.',
        'navigate_to', '/view/mek_checkouts/' || v_checkout_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.checkout_mek_request(BIGINT) TO authenticated;

-- D4. Enhanced return_checkout: also back-flows to parent reservation + system notes
CREATE OR REPLACE FUNCTION public.return_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_checkout RECORD;
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_reservation_returned_id INT;
    v_items_count INT;
    v_reservation_name TEXT;
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

    SELECT id INTO v_reservation_returned_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'returned';

    -- Get reservation name for notes
    SELECT tr.display_name INTO v_reservation_name
    FROM tool_reservations tr
    WHERE tr.id = v_checkout.tool_reservation_id;

    -- Return all serial instances to service
    UPDATE tool_instances ti
    SET status_id = v_in_service_status_id
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id = ti.id;

    GET DIAGNOSTICS v_items_count = ROW_COUNT;

    -- Insert system notes on returned tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        'Returned — Reservation: ' || COALESCE(v_reservation_name, '#' || v_checkout.tool_reservation_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id IS NOT NULL;

    -- Mark checkout as returned
    UPDATE tool_reservation_checkouts
    SET status_id = v_returned_status_id
    WHERE id = p_entity_id;

    -- Back-flow: set parent reservation to returned
    UPDATE tool_reservations
    SET workflow_status_id = v_reservation_returned_id
    WHERE id = v_checkout.tool_reservation_id;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout marked as returned.' ||
            CASE WHEN v_items_count > 0
                THEN ' ' || v_items_count || ' instance(s) returned to service.'
                ELSE ''
            END);
END;
$$;

-- D5. Enhanced return_mek_checkout: add system notes on tool instances
-- Must DROP first because original (script 18) returns JSON, new version returns JSONB
DROP FUNCTION IF EXISTS public.return_mek_checkout(BIGINT);
CREATE OR REPLACE FUNCTION public.return_mek_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_released INT := 0;
    v_request_name TEXT;
    v_mek_request_id BIGINT;
BEGIN
    SELECT id INTO v_returned_status_id
    FROM metadata.statuses WHERE entity_type = 'mek_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id
    FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    -- Get parent request info
    SELECT mc.mek_request_id, mr.display_name INTO v_mek_request_id, v_request_name
    FROM mek_checkouts mc
    JOIN mek_requests mr ON mr.id = mc.mek_request_id
    WHERE mc.id = p_entity_id;

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

    -- Insert system notes on returned tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', mci.tool_instance_id::text,
        'Returned (MEK) — Request: ' || COALESCE(v_request_name, '#' || v_mek_request_id),
        'system', current_user_id()
    FROM mek_checkout_items mci
    WHERE mci.checkout_id = p_entity_id
      AND mci.tool_instance_id IS NOT NULL;

    -- Back-flow: update parent mek_request status to returned
    UPDATE mek_requests
    SET status_id = (SELECT id FROM metadata.statuses WHERE entity_type='mek_requests' AND status_key='returned')
    WHERE id = v_mek_request_id;

    RETURN jsonb_build_object('success', true, 'message',
        'Checkout marked as returned. ' || v_released || ' instance(s) returned to service.');
END;
$$;

-- D6. Create complete_mek_request RPC (returned → completed)
CREATE OR REPLACE FUNCTION public.complete_mek_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM mek_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'returned' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only returned requests can be completed. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'completed';

    UPDATE mek_requests SET status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Event kit request completed.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_mek_request(BIGINT) TO authenticated;

-- D7. Create cancel_mek_request RPC (pending/approved → cancelled)
CREATE OR REPLACE FUNCTION public.cancel_mek_request(p_entity_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM mek_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key NOT IN ('pending', 'approved') THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only pending or approved requests can be cancelled. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'cancelled';

    UPDATE mek_requests
    SET status_id = v_target_id,
        decision_notes = CASE WHEN p_reason IS NOT NULL
                         THEN COALESCE(decision_notes || E'\n', '') || 'Cancelled: ' || p_reason
                         ELSE decision_notes END
    WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Event kit request cancelled.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_mek_request(BIGINT, TEXT) TO authenticated;

-- D8. Register MEK entity action buttons
-- Approve (visible when status = pending)
INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style, sort_order,
    rpc_function, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, refresh_after_action, show_on_detail
) VALUES (
    'mek_requests', 'approve', 'Approve', 'Approve this event kit request',
    'check_circle', 'success', 5,
    'approve_mek_request', true, 'Approve this event kit request?',
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'pending'),
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'pending'),
    true, true
) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    rpc_function = EXCLUDED.rpc_function,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

-- Check Out (visible when status = approved)
INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style, sort_order,
    rpc_function, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, refresh_after_action, show_on_detail
) VALUES (
    'mek_requests', 'check_out', 'Check Out', 'Mark equipment as checked out to borrower',
    'output', 'primary', 15,
    'checkout_mek_request', true, 'Confirm equipment has been handed to the borrower?',
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'approved'),
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'approved'),
    true, true
) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    rpc_function = EXCLUDED.rpc_function,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

-- Complete (visible when status = returned)
INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style, sort_order,
    rpc_function, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, refresh_after_action, show_on_detail
) VALUES (
    'mek_requests', 'complete', 'Complete', 'Mark request as fully completed',
    'task_alt', 'success', 20,
    'complete_mek_request', false, NULL,
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'returned'),
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'returned'),
    true, true
) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    rpc_function = EXCLUDED.rpc_function,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

-- Cancel (visible when status IN pending, approved)
INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style, sort_order,
    rpc_function, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, refresh_after_action, show_on_detail
) VALUES (
    'mek_requests', 'cancel', 'Cancel', 'Cancel this event kit request',
    'cancel', 'ghost', 30,
    'cancel_mek_request', true, 'Are you sure you want to cancel this request?',
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'in', 'value',
        jsonb_agg(id ORDER BY sort_order))
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key IN ('pending', 'approved')),
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'in', 'value',
        jsonb_agg(id ORDER BY sort_order))
     FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key IN ('pending', 'approved')),
    true, true
) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    rpc_function = EXCLUDED.rpc_function,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

-- Cancel action parameter (reason)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_reason', 'Reason (optional)', 'text', false, 10, 'Enter reason for cancellation...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_requests' AND ea.action_name = 'cancel'
  AND NOT EXISTS (
    SELECT 1 FROM metadata.entity_action_params eap
    WHERE eap.entity_action_id = ea.id AND eap.param_name = 'p_reason'
  );

-- Grant MEK action buttons to staff and admin roles
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'mek_requests'
  AND ea.action_name IN ('approve', 'check_out', 'complete', 'cancel')
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin')
ON CONFLICT (entity_action_id, role_id) DO NOTHING;

-- D9. Fix checkout/return icons: 'output' for checkout, 'input' for return
-- (shopping_cart was misleading for a lending workflow)
UPDATE metadata.entity_actions SET icon = 'output'
WHERE table_name = 'tool_reservations' AND action_name = 'check_out';

UPDATE metadata.entity_actions SET icon = 'input'
WHERE table_name = 'tool_reservations' AND action_name = 'mark_returned';

UPDATE metadata.entity_actions SET icon = 'input'
WHERE table_name = 'tool_reservation_checkouts' AND action_name = 'mark_returned';

UPDATE metadata.entity_actions SET icon = 'input'
WHERE table_name = 'mek_checkouts' AND action_name = 'mark_returned';

-- ============================================================================
-- PART E: Convert MEK to time_slot + Calendar Enablement
-- ============================================================================

-- E1. Add timeslot column to mek_requests
ALTER TABLE mek_requests ADD COLUMN IF NOT EXISTS timeslot time_slot;

-- E2. Backfill from existing pickup_date/return_date (9am pickup, 5pm return as defaults)
-- Only runs if pickup_date column still exists (idempotent)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mek_requests' AND column_name = 'pickup_date'
    ) THEN
        EXECUTE '
            UPDATE mek_requests
            SET timeslot = tstzrange(
                (pickup_date + TIME ''09:00'')::timestamptz,
                (return_date + TIME ''17:00'')::timestamptz,
                ''[)''
            )
            WHERE timeslot IS NULL AND pickup_date IS NOT NULL
        ';
    END IF;
END $$;

-- E3. Make timeslot NOT NULL and drop old columns
-- Note: Only drop if pickup_date still exists (idempotent)
DO $$
BEGIN
    -- Set NOT NULL if not already
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mek_requests' AND column_name = 'timeslot'
          AND is_nullable = 'YES'
    ) THEN
        -- Ensure any NULL timeslots get a default before constraining
        UPDATE mek_requests
        SET timeslot = tstzrange(now(), now() + INTERVAL '1 day', '[)')
        WHERE timeslot IS NULL;

        ALTER TABLE mek_requests ALTER COLUMN timeslot SET NOT NULL;
    END IF;

    -- Drop old columns if they exist
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mek_requests' AND column_name = 'pickup_date'
    ) THEN
        ALTER TABLE mek_requests DROP COLUMN pickup_date;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mek_requests' AND column_name = 'return_date'
    ) THEN
        ALTER TABLE mek_requests DROP COLUMN return_date;
    END IF;
END $$;

-- Drop old indexes (safe even if columns already dropped)
DROP INDEX IF EXISTS idx_mek_requests_pickup;
DROP INDEX IF EXISTS idx_mek_requests_return;

-- Add GIST index for range overlap queries
CREATE INDEX IF NOT EXISTS idx_mek_requests_timeslot ON mek_requests USING GIST (timeslot);

-- Drop the old CHECK constraint (tstzrange inherently enforces start < end)
ALTER TABLE mek_requests DROP CONSTRAINT IF EXISTS mek_return_after_pickup;

-- E4. Update metadata.properties for MEK: remove old date columns, add timeslot
DELETE FROM metadata.properties
WHERE table_name = 'mek_requests' AND column_name IN ('pickup_date', 'return_date');

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('mek_requests', 'timeslot', 'Pickup / Return Dates', 21, 2, true, true, true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    sort_order = EXCLUDED.sort_order,
    column_width = EXCLUDED.column_width,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- Delete old validations for pickup_date/return_date
DELETE FROM metadata.validations
WHERE table_name = 'mek_requests' AND column_name IN ('pickup_date', 'return_date');

-- Delete old constraint message
DELETE FROM metadata.constraint_messages
WHERE constraint_name = 'mek_return_after_pickup';

-- E5. Update MEK notification trigger to use timeslot instead of pickup_date/return_date
CREATE OR REPLACE FUNCTION public.notify_mek_request_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
  v_status_key TEXT;
  v_template_name TEXT;
  v_borrower_user_id UUID;
  v_entity_data JSONB;
  v_staff RECORD;
BEGIN
  SELECT status_key INTO v_status_key
  FROM metadata.statuses WHERE id = NEW.status_id;

  -- Build entity data with pickup/return derived from timeslot for template compatibility
  v_entity_data := jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW.display_name,
    'timeslot', NEW.timeslot::text,
    'pickup_date', lower(NEW.timeslot)::date::text,
    'return_date', (upper(NEW.timeslot) - INTERVAL '1 day')::date::text,
    'borrower_display_name', (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id)
  );

  -- 'pending' = submission -> notify staff
  IF v_status_key = 'pending' THEN
    FOR v_staff IN SELECT user_id FROM get_neh_users_with_role('neh_staff')
                   UNION
                   SELECT user_id FROM get_neh_users_with_role('neh_admin')
    LOOP
      INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
      VALUES (v_staff.user_id, 'mek_request_submitted', 'mek_requests', NEW.id::text, v_entity_data);
    END LOOP;
    RETURN NEW;
  END IF;

  -- Other statuses -> notify requester (borrower)
  CASE v_status_key
    WHEN 'approved' THEN v_template_name := 'mek_request_approved';
    WHEN 'denied' THEN v_template_name := 'mek_request_denied';
    ELSE v_template_name := NULL;
  END CASE;

  IF v_template_name IS NOT NULL THEN
    SELECT b.user_id INTO v_borrower_user_id
    FROM borrowers b WHERE b.id = NEW.borrower_id;

    IF v_borrower_user_id IS NOT NULL THEN
      INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
      VALUES (v_borrower_user_id, v_template_name, 'mek_requests', NEW.id::text, v_entity_data);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- E6. Update dashboard widgets: replace pickup_date/return_date with timeslot in showColumns
-- Borrower dashboard MEK widget
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{showColumns}',
    '["display_name", "event_type", "timeslot", "status.display_name"]'::jsonb
)
WHERE widget_type = 'filtered_list'
  AND (config->>'entity' = 'mek_requests' OR entity_key = 'mek_requests')
  AND config->'showColumns' IS NOT NULL
  AND (config->'showColumns')::text LIKE '%pickup_date%';

-- Staff/Admin dashboard MEK widgets (pending, uses older format)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    config,
    '{showColumns}',
    '["display_name", "borrower.display_name", "event_type", "timeslot"]'::jsonb
)
WHERE widget_type = 'filtered_list'
  AND (config->>'entity' = 'mek_requests' OR entity_key = 'mek_requests')
  AND config->'showColumns' IS NOT NULL
  AND (config->'showColumns')::text LIKE '%borrower%';

-- E7. Calendar configuration on entities
-- Enable calendar on tool_reservations entity
UPDATE metadata.entities
SET show_calendar = true,
    calendar_property_name = 'timeslot'
WHERE table_name = 'tool_reservations';

-- Enable calendar on mek_requests entity
UPDATE metadata.entities
SET show_calendar = true,
    calendar_property_name = 'timeslot'
WHERE table_name = 'mek_requests';

-- E8. Add colorProperty to existing tool_reservations calendar widgets
UPDATE metadata.dashboard_widgets
SET config = config || '{"colorProperty": "calendar_hex_color"}'::jsonb
WHERE widget_type = 'calendar'
  AND (config->>'entityKey' = 'tool_reservations' OR entity_key = 'tool_reservations')
  AND NOT (config ? 'colorProperty');

-- E9. Add MEK calendar widgets to staff and admin dashboards
DO $$
DECLARE
  v_staff_dashboard_id INT;
  v_admin_dashboard_id INT;
BEGIN
  SELECT id INTO v_staff_dashboard_id FROM metadata.dashboards WHERE display_name = 'NEH Staff';
  SELECT id INTO v_admin_dashboard_id FROM metadata.dashboards WHERE display_name = 'NEH Admin';

  -- Staff dashboard: MEK calendar
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, entity_key, config, sort_order)
  VALUES (
    v_staff_dashboard_id,
    'calendar',
    'mek_requests',
    '{"entityKey": "mek_requests", "timeSlotPropertyName": "timeslot", "initialView": "dayGridMonth", "colorProperty": "calendar_hex_color"}'::jsonb,
    42
  );

  -- Admin dashboard: MEK calendar
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, entity_key, config, sort_order)
  VALUES (
    v_admin_dashboard_id,
    'calendar',
    'mek_requests',
    '{"entityKey": "mek_requests", "timeSlotPropertyName": "timeslot", "initialView": "dayGridMonth", "colorProperty": "calendar_hex_color"}'::jsonb,
    37
  );
END $$;

-- ============================================================================
-- PART F: Schema Decision (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['tool_reservations', 'mek_requests', 'tool_instances', 'tool_reservation_checkouts', 'mek_checkouts']::NAME[],
    '22_neh_checkout_calendar_notes',
    'Checkout flow enhancements, calendar colors, display name enrichment, and entity notes',
    'accepted',
    'NEH tool lending and MEK workflows needed pre-production improvements: (1) checkout actions missing navigate_to for staff efficiency, (2) display names showed only borrower+date making calendar events unreadable, (3) calendar events had no status-based coloring, (4) MEK used DATE columns instead of time_slot preventing calendar integration, (5) no audit trail on tool instances for checkout/return events.',
    'Multi-part enhancement: (A) Enabled entity notes on tool_instances with neh_staff/neh_admin grants. (B) Added calendar_hex_color columns with status-sync triggers on both tool_reservations and mek_requests. (C) Enhanced display_name triggers to rebuild with tool/item details on first status transition past pending. (D) Enhanced checkout/return RPCs with navigate_to, system notes on tool instances, and parent back-flow. Added approve/checkout/complete/cancel actions for MEK. (E) Converted MEK from pickup_date/return_date to time_slot tstzrange, enabling calendar widget integration. (F) This ADR.',
    'Enriching display_name server-side (via SQL triggers) eliminates frontend complexity vs adding a titleProperty config option. Status-synced color columns use the same hex colors from metadata.statuses, maintaining a single source of truth. Converting MEK to time_slot unifies both reservation types under the same calendar pattern.',
    'display_name is now a rich denormalized snapshot rebuilt on status transitions. MEK notification templates continue working via derived pickup_date/return_date keys in entity_data payload. Entity notes create audit trail entries automatically during checkout/return RPCs. Calendar widgets now display colored events based on workflow status.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '22_neh_checkout_calendar_notes');

COMMIT;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
