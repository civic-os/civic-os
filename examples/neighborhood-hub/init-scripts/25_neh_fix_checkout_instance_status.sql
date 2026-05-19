-- Neighborhood Engagement Hub - Fix checkout instance status timing
--
-- The checkout workflow had instance status changes in the wrong phase:
--
--   add_checkout_item eagerly marked instances 'checked_out' at add time,
--   but confirm_checkout later updates the reservation status which fires
--   the overlap trigger — it sees 0 in_service instances and blocks.
--
--   remove_checkout_item only allowed removal from 'checked_out' checkouts,
--   but Add/Remove are preparing-phase actions (building the cart).
--
--   add_checkout_item also checked for status_key = 'available' which doesn't
--   exist — the correct key is 'in_service'.
--
-- Correct lifecycle:
--   preparing:  Add/Remove build the cart. Instances stay in_service.
--   confirm:    Instances go in_service → checked_out (commit point).
--   returned:   Instances go checked_out → in_service (mark_returned).

BEGIN;

-- ============================================================================
-- 1. FIX add_checkout_item
--    - 'available' → 'in_service'
--    - Remove eager instance status change (moved to confirm)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_checkout_item(
    p_entity_id BIGINT,
    p_tool_type_id INT,
    p_tool_instance_id INT DEFAULT NULL,
    p_quantity INT DEFAULT 1,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_type_name TEXT;
    v_is_qty_managed BOOLEAN;
    v_instance_name TEXT;
    v_instance_status_key TEXT;
    v_display_name TEXT;
BEGIN
    SELECT display_name, is_qty_managed INTO v_type_name, v_is_qty_managed
    FROM tool_types WHERE id = p_tool_type_id;

    IF v_type_name IS NULL THEN
        RAISE EXCEPTION 'Tool type not found' USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_qty_managed THEN
        IF p_tool_instance_id IS NULL THEN
            RAISE EXCEPTION 'Serial tool "%" requires a specific instance to be selected.', v_type_name
                USING ERRCODE = 'P0001';
        END IF;

        SELECT ti.display_name, s.status_key INTO v_instance_name, v_instance_status_key
        FROM tool_instances ti
        JOIN metadata.statuses s ON s.id = ti.status_id
        WHERE ti.id = p_tool_instance_id AND ti.tool_type_id = p_tool_type_id;

        IF v_instance_name IS NULL THEN
            RAISE EXCEPTION 'Tool instance not found.' USING ERRCODE = 'P0001';
        END IF;

        IF v_instance_status_key != 'in_service' THEN
            RETURN jsonb_build_object('success', false,
                'message', v_instance_name || ' is not available (current status: ' || v_instance_status_key || ').');
        END IF;

        p_quantity := 1;
    END IF;

    IF p_tool_instance_id IS NOT NULL THEN
        v_display_name := v_type_name || ' (' || COALESCE(v_instance_name, '#' || p_tool_instance_id) || ')';
    ELSE
        v_display_name := v_type_name || ' x' || p_quantity;
    END IF;

    INSERT INTO checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes, display_name)
    VALUES (p_entity_id, p_tool_type_id, p_tool_instance_id, p_quantity, p_notes, v_display_name);

    RETURN jsonb_build_object('success', true,
        'message', v_type_name || ' added to checkout.');
END;
$$;


-- ============================================================================
-- 2. FIX add_mek_checkout_item (same changes)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_mek_checkout_item(
    p_entity_id BIGINT,
    p_tool_type_id INT,
    p_tool_instance_id INT DEFAULT NULL,
    p_quantity INT DEFAULT 1,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_type_name TEXT;
    v_is_qty_managed BOOLEAN;
    v_instance_name TEXT;
    v_instance_status_key TEXT;
    v_display_name TEXT;
BEGIN
    SELECT display_name, is_qty_managed INTO v_type_name, v_is_qty_managed
    FROM tool_types WHERE id = p_tool_type_id;

    IF v_type_name IS NULL THEN
        RAISE EXCEPTION 'Tool type not found' USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_qty_managed THEN
        IF p_tool_instance_id IS NULL THEN
            RAISE EXCEPTION 'Serial tool "%" requires a specific instance to be selected.', v_type_name
                USING ERRCODE = 'P0001';
        END IF;

        SELECT ti.display_name, s.status_key INTO v_instance_name, v_instance_status_key
        FROM tool_instances ti
        JOIN metadata.statuses s ON s.id = ti.status_id
        WHERE ti.id = p_tool_instance_id AND ti.tool_type_id = p_tool_type_id;

        IF v_instance_name IS NULL THEN
            RAISE EXCEPTION 'Tool instance not found.' USING ERRCODE = 'P0001';
        END IF;

        IF v_instance_status_key != 'in_service' THEN
            RETURN jsonb_build_object('success', false,
                'message', v_instance_name || ' is not available (current status: ' || v_instance_status_key || ').');
        END IF;

        p_quantity := 1;
    END IF;

    IF p_tool_instance_id IS NOT NULL THEN
        v_display_name := v_type_name || ' (' || COALESCE(v_instance_name, '#' || p_tool_instance_id) || ')';
    ELSE
        v_display_name := v_type_name || ' x' || p_quantity;
    END IF;

    IF NOT v_is_qty_managed THEN
        INSERT INTO mek_checkout_items (checkout_id, tool_type_id, tool_instance_id, quantity, notes, display_name)
        VALUES (p_entity_id, p_tool_type_id, p_tool_instance_id, 1, p_notes, v_display_name);
    ELSE
        INSERT INTO mek_checkout_items (checkout_id, tool_type_id, quantity, notes, display_name)
        VALUES (p_entity_id, p_tool_type_id, p_quantity, p_notes, v_display_name);
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', v_type_name || ' added to checkout.');
END;
$$;


-- ============================================================================
-- 3. FIX remove_checkout_item
--    - Allow during 'preparing' (not 'checked_out')
--    - Don't touch instance status (instances are still in_service)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_checkout_item(
    p_entity_id BIGINT,
    p_checkout_item_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_checkout_status_key TEXT;
    v_item RECORD;
BEGIN
    SELECT s.status_key INTO v_checkout_status_key
    FROM tool_reservation_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout_status_key != 'preparing' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Items can only be removed while checkout is being prepared.');
    END IF;

    SELECT ci.*, tt.display_name AS type_name, ti.display_name AS instance_name
    INTO v_item
    FROM checkout_items ci
    JOIN tool_types tt ON ci.tool_type_id = tt.id
    LEFT JOIN tool_instances ti ON ci.tool_instance_id = ti.id
    WHERE ci.id = p_checkout_item_id AND ci.checkout_id = p_entity_id;

    IF v_item IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Checkout item not found.');
    END IF;

    DELETE FROM checkout_items WHERE id = p_checkout_item_id;

    RETURN jsonb_build_object('success', true,
        'message', COALESCE(v_item.instance_name, v_item.type_name) || ' removed from checkout.');
END;
$$;


-- ============================================================================
-- 4. FIX remove_mek_checkout_item (same changes)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_mek_checkout_item(
    p_entity_id BIGINT,
    p_checkout_item_id BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    v_checkout_status_key TEXT;
    v_item RECORD;
BEGIN
    SELECT s.status_key INTO v_checkout_status_key
    FROM mek_checkouts c
    JOIN metadata.statuses s ON c.status_id = s.id
    WHERE c.id = p_entity_id;

    IF v_checkout_status_key != 'preparing' THEN
        RETURN json_build_object('success', false,
            'message', 'Items can only be removed while checkout is being prepared.');
    END IF;

    SELECT ci.id, ci.tool_instance_id, tt.display_name as tool_name
    INTO v_item
    FROM mek_checkout_items ci
    JOIN tool_types tt ON tt.id = ci.tool_type_id
    WHERE ci.id = p_checkout_item_id AND ci.checkout_id = p_entity_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Checkout item not found on this checkout record.' USING ERRCODE = 'P0001';
    END IF;

    DELETE FROM mek_checkout_items WHERE id = p_checkout_item_id;

    RETURN json_build_object('success', true, 'message', v_item.tool_name || ' removed from checkout.');
END;
$$;


-- ============================================================================
-- 5. FIX confirm_checkout — mark serial instances as checked_out here
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
    v_instance_checked_out_id INT;
BEGIN
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

    IF NOT EXISTS (SELECT 1 FROM checkout_items WHERE checkout_id = p_entity_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Add at least one item before confirming checkout.');
    END IF;

    SELECT id INTO v_checked_out_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_parent_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'checked_out';

    SELECT id INTO v_instance_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Mark serial tool instances as checked_out (commit point)
    UPDATE tool_instances SET status_id = v_instance_checked_out_id
    WHERE id IN (
        SELECT ci.tool_instance_id FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id IS NOT NULL
    );

    UPDATE tool_reservation_checkouts SET status_id = v_checked_out_status_id
    WHERE id = p_entity_id;

    UPDATE tool_reservations SET workflow_status_id = v_parent_checked_out_id
    WHERE id = v_checkout.tool_reservation_id;

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
-- 6. FIX confirm_mek_checkout (same changes)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_mek_checkout(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
    v_instance_checked_out_id INT;
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

    SELECT id INTO v_instance_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Mark serial tool instances as checked_out (commit point)
    UPDATE tool_instances SET status_id = v_instance_checked_out_id
    WHERE id IN (
        SELECT mci.tool_instance_id FROM mek_checkout_items mci
        WHERE mci.checkout_id = p_entity_id
          AND mci.tool_instance_id IS NOT NULL
    );

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
-- PHOTO GALLERY ACTION PARAMS (v0.55.0)
-- Requires: v0-55-0-photo-gallery-action-param migration
--
-- Adds photo_gallery action params to confirm_checkout and mark_returned
-- actions for both tool_reservation_checkouts and mek_checkouts.
-- Gallery columns are made visible on detail+edit pages.
-- RPCs updated to accept gallery UUID and link via link_gallery_to_entity.
-- ============================================================================


-- ============================================================================
-- 7. PROPERTY VISIBILITY — ensure gallery columns visible on detail+edit
-- ============================================================================

UPDATE metadata.properties SET show_on_detail = true, show_on_edit = true
WHERE table_name = 'tool_reservation_checkouts'
  AND column_name IN ('checkout_photos', 'return_photos');

UPDATE metadata.properties SET show_on_detail = true, show_on_edit = true
WHERE table_name = 'mek_checkouts'
  AND column_name IN ('checkout_photos', 'return_photos');


-- ============================================================================
-- 8. PHOTO GALLERY ACTION PARAMS
-- ============================================================================

-- 8a. confirm_checkout → p_checkout_photos (optional)
INSERT INTO metadata.entity_action_params (
    entity_action_id, param_name, display_name, param_type,
    target_column, required, sort_order
)
SELECT ea.id, 'p_checkout_photos', 'Checkout Photos', 'photo_gallery',
       'checkout_photos', FALSE, 20
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts'
  AND ea.action_name = 'confirm_checkout';

-- 8b. mark_returned → p_return_photos (optional)
INSERT INTO metadata.entity_action_params (
    entity_action_id, param_name, display_name, param_type,
    target_column, required, sort_order
)
SELECT ea.id, 'p_return_photos', 'Return Photos', 'photo_gallery',
       'return_photos', FALSE, 20
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservation_checkouts'
  AND ea.action_name = 'mark_returned';

-- 8c. confirm_checkout (mek) → p_checkout_photos (optional)
-- Note: action_name is 'confirm_checkout', rpc_function is 'confirm_mek_checkout'
INSERT INTO metadata.entity_action_params (
    entity_action_id, param_name, display_name, param_type,
    target_column, required, sort_order
)
SELECT ea.id, 'p_checkout_photos', 'Checkout Photos', 'photo_gallery',
       'checkout_photos', FALSE, 20
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_checkouts'
  AND ea.action_name = 'confirm_checkout';

-- 8d. mark_returned (mek) → p_return_photos (optional)
INSERT INTO metadata.entity_action_params (
    entity_action_id, param_name, display_name, param_type,
    target_column, required, sort_order
)
SELECT ea.id, 'p_return_photos', 'Return Photos', 'photo_gallery',
       'return_photos', FALSE, 20
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_checkouts'
  AND ea.action_name = 'mark_returned';


-- ============================================================================
-- 9. UPDATE RPCs TO ACCEPT GALLERY UUID
-- ============================================================================

-- Drop old 1-arg overloads before creating 2-arg versions (PostgreSQL identifies
-- functions by (name, arg types), so CREATE OR REPLACE won't replace them).
DROP FUNCTION IF EXISTS public.confirm_checkout(BIGINT);
DROP FUNCTION IF EXISTS public.confirm_mek_checkout(BIGINT);

-- 9a. confirm_checkout — accept p_checkout_photos UUID
CREATE OR REPLACE FUNCTION public.confirm_checkout(
    p_entity_id BIGINT,
    p_checkout_photos UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
    v_instance_checked_out_id INT;
BEGIN
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

    IF NOT EXISTS (SELECT 1 FROM checkout_items WHERE checkout_id = p_entity_id) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Add at least one item before confirming checkout.');
    END IF;

    SELECT id INTO v_checked_out_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

    SELECT id INTO v_parent_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'checked_out';

    SELECT id INTO v_instance_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Mark serial tool instances as checked_out (commit point)
    UPDATE tool_instances SET status_id = v_instance_checked_out_id
    WHERE id IN (
        SELECT ci.tool_instance_id FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id IS NOT NULL
    );

    UPDATE tool_reservation_checkouts SET status_id = v_checked_out_status_id
    WHERE id = p_entity_id;

    UPDATE tool_reservations SET workflow_status_id = v_parent_checked_out_id
    WHERE id = v_checkout.tool_reservation_id;

    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        'Checked out — Reservation: ' || COALESCE(v_checkout.reservation_name, '#' || v_checkout.tool_reservation_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id IS NOT NULL;

    -- Link checkout photos gallery if provided (v0.55.0)
    IF p_checkout_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_checkout_photos,
            'tool_reservation_checkouts',
            p_entity_id::TEXT,
            'checkout_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout confirmed. Tools are now checked out.');
END;
$$;


-- 9b. confirm_mek_checkout — accept p_checkout_photos UUID
CREATE OR REPLACE FUNCTION public.confirm_mek_checkout(
    p_entity_id BIGINT,
    p_checkout_photos UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_checked_out_status_id INT;
    v_parent_checked_out_id INT;
    v_instance_checked_out_id INT;
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

    SELECT id INTO v_instance_checked_out_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'checked_out';

    -- Mark serial tool instances as checked_out (commit point)
    UPDATE tool_instances SET status_id = v_instance_checked_out_id
    WHERE id IN (
        SELECT mci.tool_instance_id FROM mek_checkout_items mci
        WHERE mci.checkout_id = p_entity_id
          AND mci.tool_instance_id IS NOT NULL
    );

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

    -- Link checkout photos gallery if provided (v0.55.0)
    IF p_checkout_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_checkout_photos,
            'mek_checkouts',
            p_entity_id::TEXT,
            'checkout_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout confirmed. Items are now checked out.');
END;
$$;


-- 9c. return_checkout — accept p_return_photos UUID
DROP FUNCTION IF EXISTS public.return_checkout(BIGINT);
CREATE OR REPLACE FUNCTION public.return_checkout(
    p_entity_id BIGINT,
    p_return_photos UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'metadata', 'pg_temp'
AS $$
DECLARE
    v_checkout RECORD;
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_reservation_returned_id INT;
    v_items_count INT;
    v_reservation_name TEXT;
BEGIN
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

    SELECT id INTO v_returned_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    SELECT id INTO v_reservation_returned_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'returned';

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

    -- Link return photos gallery if provided (v0.55.0)
    IF p_return_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_return_photos,
            'tool_reservation_checkouts',
            p_entity_id::TEXT,
            'return_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true,
        'message', 'Checkout marked as returned.' ||
            CASE WHEN v_items_count > 0
                THEN ' ' || v_items_count || ' instance(s) returned to service.'
                ELSE ''
            END);
END;
$$;


-- 9d. return_mek_checkout — accept p_return_photos UUID
DROP FUNCTION IF EXISTS public.return_mek_checkout(BIGINT);
CREATE OR REPLACE FUNCTION public.return_mek_checkout(
    p_entity_id BIGINT,
    p_return_photos UUID DEFAULT NULL
)
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

    -- Link return photos gallery if provided (v0.55.0)
    IF p_return_photos IS NOT NULL THEN
        PERFORM link_gallery_to_entity(
            p_return_photos,
            'mek_checkouts',
            p_entity_id::TEXT,
            'return_photos'
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'message',
        'Checkout marked as returned. ' || v_released || ' instance(s) returned to service.');
END;
$$;


-- ============================================================================
-- 10. ADR — Document the photo gallery action param addition
-- ============================================================================

-- Direct INSERT (not create_schema_decision RPC) because init scripts run
-- without JWT context.
INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, decision, decided_date
) VALUES (
    ARRAY['tool_reservation_checkouts', 'mek_checkouts']::NAME[], 'neh-25-photo-gallery-params',
    'Add photo_gallery action param type (v0.55.0)',
    'accepted',
    'Staff need to capture photos during checkout/return workflows via action buttons rather than editing records directly. Added photo_gallery as a new entity action param type with target_column for gallery config lookup. Gallery always starts blank in action modal; RPC receives draft gallery UUID and links via link_gallery_to_entity. Applied to confirm_checkout and mark_returned actions for both tool_reservation_checkouts and mek_checkouts.',
    CURRENT_DATE
);


COMMIT;

NOTIFY pgrst, 'reload schema';
