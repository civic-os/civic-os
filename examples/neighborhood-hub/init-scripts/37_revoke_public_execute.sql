-- 37_revoke_public_execute.sql
-- Neighborhood Hub example: revoke PUBLIC EXECUTE, guard staff actions, restore lost grants.
--
-- Findings addressed:
--   - Tool-reservation and checkout action RPCs (approve/deny/checkout/complete/cancel, return and
--     confirm for tool and event-kit checkouts, complete/cancel MEK request, update_borrower_address)
--     were SECURITY DEFINER with no authorization check; the neh_staff/neh_admin restriction only
--     existed in the UI. They also had no GRANT at all, so with PUBLIC gone nobody could call them.
--   - current_borrower_id, format_parcel_id, parcel_search_tokens, add_mek_checkout_item and
--     boundary_text had no (or a lost) grant but are evaluated as the calling role (column DEFAULT,
--     generated column, action RPC, PostgREST computed field) and need an explicit one.
--   - get_neh_users_with_role returned the ids of every staff/admin/borrower to any caller.
--
-- Companion to core migration v0-76-5-revoke-public-execute. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so a bare GRANT ... TO authenticated never removed anonymous
-- (web_anon) access. This script revokes PUBLIC from this example's non-anonymous functions,
-- restores grants that the new default privileges would otherwise remove, and adds in-body
-- authorization checks to SECURITY DEFINER RPCs that had none.
--
-- Safe to re-run: REVOKE/GRANT are idempotent and CREATE OR REPLACE keeps existing ACLs.

BEGIN;

-- ===========================================================================
-- 1. Authorization guards (CREATE OR REPLACE keeps the existing ACL)
-- Same role set as the entity_action_roles rows for these actions: neh_staff, neh_admin, admin.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.approve_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to approve tool reservations';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'pending' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only pending reservations can be approved. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'approved';

    UPDATE tool_reservations SET workflow_status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Reservation approved.');
END;
$$;

CREATE OR REPLACE FUNCTION public.deny_tool_reservation(p_entity_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to deny tool reservations';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'pending' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only pending reservations can be denied. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'denied';

    UPDATE tool_reservations
    SET workflow_status_id = v_target_id,
        notes = CASE WHEN p_reason IS NOT NULL
                     THEN COALESCE(notes || E'\n', '') || 'Denied: ' || p_reason
                     ELSE notes END
    WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Reservation denied.');
END;
$$;

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
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to start a tool checkout';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

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

CREATE OR REPLACE FUNCTION public.complete_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to complete tool reservations';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'returned' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only returned reservations can be completed. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'completed';

    UPDATE tool_reservations SET workflow_status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Reservation completed.');
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_tool_reservation(p_entity_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to cancel tool reservations';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key NOT IN ('pending', 'approved') THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only pending or approved reservations can be cancelled. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'cancelled';

    UPDATE tool_reservations
    SET workflow_status_id = v_target_id,
        notes = CASE WHEN p_reason IS NOT NULL
                     THEN COALESCE(notes || E'\n', '') || 'Cancelled: ' || p_reason
                     ELSE notes END
    WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Reservation cancelled.');
END;
$$;

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
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to complete event kit requests';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

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
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to cancel event kit requests';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

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

CREATE OR REPLACE FUNCTION public.return_checkout(
    p_entity_id BIGINT,
    p_return_photos UUID DEFAULT NULL,
    p_damage_reported BOOLEAN DEFAULT FALSE,
    p_return_notes TEXT DEFAULT NULL
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
    v_maintenance_status_id INT;
    v_reservation_returned_id INT;
    v_items_count INT;
    v_reservation_name TEXT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to return a tool checkout';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

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

    SELECT id INTO v_maintenance_status_id FROM metadata.statuses
    WHERE entity_type = 'tool_instances' AND status_key = 'maintenance';

    SELECT id INTO v_reservation_returned_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'returned';

    SELECT tr.display_name INTO v_reservation_name
    FROM tool_reservations tr
    WHERE tr.id = v_checkout.tool_reservation_id;

    -- Return serial instances: to maintenance if damaged, to in_service otherwise
    IF COALESCE(p_damage_reported, FALSE) THEN
        UPDATE tool_instances ti
        SET status_id = v_maintenance_status_id
        FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id = ti.id;
    ELSE
        UPDATE tool_instances ti
        SET status_id = v_in_service_status_id
        FROM checkout_items ci
        WHERE ci.checkout_id = p_entity_id
          AND ci.tool_instance_id = ti.id;
    END IF;

    GET DIAGNOSTICS v_items_count = ROW_COUNT;

    -- Insert system notes on returned tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', ci.tool_instance_id::text,
        CASE WHEN COALESCE(p_damage_reported, FALSE)
            THEN 'Returned (DAMAGED) — Reservation: '
            ELSE 'Returned — Reservation: '
        END || COALESCE(v_reservation_name, '#' || v_checkout.tool_reservation_id),
        'system', current_user_id()
    FROM checkout_items ci
    WHERE ci.checkout_id = p_entity_id
      AND ci.tool_instance_id IS NOT NULL;

    -- Mark checkout as returned + store damage/notes
    UPDATE tool_reservation_checkouts
    SET status_id = v_returned_status_id,
        damage_reported = COALESCE(p_damage_reported, FALSE),
        return_notes = p_return_notes
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
                THEN ' ' || v_items_count || ' instance(s) returned to ' ||
                    CASE WHEN COALESCE(p_damage_reported, FALSE) THEN 'maintenance.' ELSE 'service.' END
                ELSE ''
            END);
END;
$$;

CREATE OR REPLACE FUNCTION public.return_mek_checkout(
    p_entity_id BIGINT,
    p_return_photos UUID DEFAULT NULL,
    p_damage_reported BOOLEAN DEFAULT FALSE,
    p_return_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_returned_status_id INT;
    v_in_service_status_id INT;
    v_maintenance_status_id INT;
    v_released INT := 0;
    v_request_name TEXT;
    v_mek_request_id BIGINT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to return an event kit checkout';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT id INTO v_returned_status_id
    FROM metadata.statuses WHERE entity_type = 'mek_checkouts' AND status_key = 'returned';

    SELECT id INTO v_in_service_status_id
    FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'in_service';

    SELECT id INTO v_maintenance_status_id
    FROM metadata.statuses WHERE entity_type = 'tool_instances' AND status_key = 'maintenance';

    SELECT mc.mek_request_id, mr.display_name INTO v_mek_request_id, v_request_name
    FROM mek_checkouts mc
    JOIN mek_requests mr ON mr.id = mc.mek_request_id
    WHERE mc.id = p_entity_id;

    -- Mark checkout as returned + store damage/notes
    UPDATE mek_checkouts
    SET status_id = v_returned_status_id,
        damage_reported = COALESCE(p_damage_reported, FALSE),
        return_notes = p_return_notes,
        updated_at = now()
    WHERE id = p_entity_id;

    -- Release serial instances: to maintenance if damaged, to in_service otherwise
    IF COALESCE(p_damage_reported, FALSE) THEN
        UPDATE tool_instances
        SET status_id = v_maintenance_status_id
        WHERE id IN (
            SELECT tool_instance_id FROM mek_checkout_items
            WHERE checkout_id = p_entity_id AND tool_instance_id IS NOT NULL
        );
    ELSE
        UPDATE tool_instances
        SET status_id = v_in_service_status_id
        WHERE id IN (
            SELECT tool_instance_id FROM mek_checkout_items
            WHERE checkout_id = p_entity_id AND tool_instance_id IS NOT NULL
        );
    END IF;
    GET DIAGNOSTICS v_released = ROW_COUNT;

    -- Insert system notes on returned tool instances
    INSERT INTO metadata.entity_notes (entity_type, entity_id, content, note_type, author_id)
    SELECT 'tool_instances', mci.tool_instance_id::text,
        CASE WHEN COALESCE(p_damage_reported, FALSE)
            THEN 'Returned (DAMAGED, MEK) — Request: '
            ELSE 'Returned (MEK) — Request: '
        END || COALESCE(v_request_name, '#' || v_mek_request_id),
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
        'Checkout marked as returned. ' || v_released || ' instance(s) returned to ' ||
            CASE WHEN COALESCE(p_damage_reported, FALSE) THEN 'maintenance.' ELSE 'service.' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_checkout(
    p_entity_id BIGINT,
    p_checkout_photos UUID DEFAULT NULL,
    p_checkout_notes TEXT DEFAULT NULL
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
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to confirm a tool checkout';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

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

    -- Transition checkout to checked_out + store notes
    UPDATE tool_reservation_checkouts
    SET status_id = v_checked_out_status_id,
        checkout_notes = p_checkout_notes
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

CREATE OR REPLACE FUNCTION public.confirm_mek_checkout(
    p_entity_id BIGINT,
    p_checkout_photos UUID DEFAULT NULL,
    p_checkout_notes TEXT DEFAULT NULL
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
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to confirm an event kit checkout';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

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

    -- Transition checkout to checked_out + store notes
    UPDATE mek_checkouts
    SET status_id = v_checked_out_status_id,
        checkout_notes = p_checkout_notes
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

CREATE OR REPLACE FUNCTION public.update_borrower_address(
    p_entity_id BIGINT,
    p_street VARCHAR DEFAULT NULL,
    p_city VARCHAR DEFAULT NULL,
    p_state VARCHAR DEFAULT NULL,
    p_zip VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_old RECORD;
    v_note TEXT := 'Address updated:';
    v_has_changes BOOLEAN := FALSE;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to update borrower addresses';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT street, city, state, zip INTO v_old FROM borrowers WHERE id = p_entity_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Borrower not found.');
    END IF;

    -- Build change note tracking old → new values
    IF p_street IS NOT NULL AND p_street IS DISTINCT FROM v_old.street THEN
        v_note := v_note || E'\n- Street: "' || COALESCE(v_old.street, '') || '" → "' || p_street || '"';
        v_has_changes := TRUE;
    END IF;
    IF p_city IS NOT NULL AND p_city IS DISTINCT FROM v_old.city THEN
        v_note := v_note || E'\n- City: "' || COALESCE(v_old.city, '') || '" → "' || p_city || '"';
        v_has_changes := TRUE;
    END IF;
    IF p_state IS NOT NULL AND p_state IS DISTINCT FROM v_old.state THEN
        v_note := v_note || E'\n- State: "' || COALESCE(v_old.state, '') || '" → "' || p_state || '"';
        v_has_changes := TRUE;
    END IF;
    IF p_zip IS NOT NULL AND p_zip IS DISTINCT FROM v_old.zip THEN
        v_note := v_note || E'\n- Zip: "' || COALESCE(v_old.zip, '') || '" → "' || p_zip || '"';
        v_has_changes := TRUE;
    END IF;

    IF NOT v_has_changes THEN
        RETURN jsonb_build_object('success', true, 'message', 'No address changes detected.', 'refresh', true);
    END IF;

    -- Update only the fields that were provided (COALESCE preserves existing values)
    UPDATE borrowers
    SET street = COALESCE(p_street, street),
        city = COALESCE(p_city, city),
        state = COALESCE(p_state, state),
        zip = COALESCE(p_zip, zip),
        updated_at = NOW()
    WHERE id = p_entity_id;

    -- Create audit note
    PERFORM create_entity_note('borrowers', p_entity_id::TEXT, v_note, 'system');

    RETURN jsonb_build_object('success', true, 'message', 'Address updated.', 'refresh', true);
END;
$$;

-- ===========================================================================
-- 2. REVOKE EXECUTE FROM PUBLIC - authenticated-only functions
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.get_borrower_for_current_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_borrowers_for_reservation(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_borrower_approved(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_borrower_approved_mek(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_no_pending_building_use_request(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_tool_reservation(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_mek_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_building_use_submitted(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enrich_parcels_lmi_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enrich_parcels_land_bank(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_building_use_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_building_use_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_mek_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_mek_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.checkout_mek_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_mek_request(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_mek_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_tool_reservation(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deny_tool_reservation(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.checkout_tool_reservation(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.return_tool_reservation(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_tool_reservation(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_tool_reservation(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_checkout_item(bigint, integer, integer, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.remove_checkout_item(bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_mek_checkout_item(bigint, integer, integer, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.remove_mek_checkout_item(bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.return_checkout(bigint, uuid, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.return_mek_checkout(bigint, uuid, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_checkout(bigint, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_mek_checkout(bigint, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_checkout_items_options(bigint, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_mek_checkout_items_options(bigint, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_tool_instance_options(bigint, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_mek_tool_instance_options(bigint, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_instances_for_type(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_event_kit_tool_types(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_borrower_address(bigint, character varying, character varying, character varying, character varying) FROM PUBLIC;

-- ===========================================================================
-- 3. Functions evaluated as the calling role that never got (or lost) a grant
-- authenticated: borrower_id column DEFAULTs, GENERATED ALWAYS parcel columns, the MEK add-item
-- action (its grant was lost when script 20 dropped and recreated the function), and the
-- staff action RPCs that were never granted at all.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.current_borrower_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.format_parcel_id(genesee_parcel_id) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.parcel_search_tokens(genesee_parcel_id) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_borrower_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.format_parcel_id(genesee_parcel_id) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parcel_search_tokens(genesee_parcel_id) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_tool_reservation(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deny_tool_reservation(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_tool_reservation(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_tool_reservation(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_tool_reservation(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_tool_reservation(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_mek_checkout_item(bigint, integer, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_checkout(bigint, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_mek_checkout(bigint, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_checkout(bigint, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_mek_checkout(bigint, uuid, text) TO authenticated;

-- boundary_text() is the GeoPolygon text companion for anon-readable tables (parcels, census_block_groups).
-- PUBLIC is intentionally left in place; the explicit grants survive the new default privileges.

GRANT EXECUTE ON FUNCTION public.boundary_text(parcels) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boundary_text(census_block_groups) TO web_anon, authenticated;

-- ===========================================================================
-- 4. Internal helper - only called by SECURITY DEFINER notification triggers (run as owner)
-- ===========================================================================

-- Returns the user ids of every staff/admin/borrower: must not be callable through the API.
REVOKE EXECUTE ON FUNCTION public.get_neh_users_with_role(text) FROM PUBLIC, authenticated;

-- ===========================================================================
-- 5. Internal trigger functions
-- Trigger functions: EXECUTE is only checked when a trigger is created, never when it fires,
-- so revoking PUBLIC here does not affect the triggers.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.tool_reservation_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_tool_reservation_overlap() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_create_checkout() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cascade_damage_to_instances() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.building_use_request_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_building_use_room_overlap() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_building_use_approval_overlap() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_borrower_on_user_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_borrower_on_private_upsert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_tool_reservation_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_building_use_request_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_borrower_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_mek_request_status_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mek_request_display_name() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_create_mek_checkout() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_create_checkout_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_create_mek_checkout_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_reservation_calendar_color() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_mek_calendar_color() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_mek_request_overlap() FROM PUBLIC;

-- The options RPCs get_available_tool_types, get_eligible_parcels_new, get_available_mek_items,
-- get_room_options and get_approved_borrowers are INVOKER (RLS applies) and keep their explicit
-- grants to web_anon and authenticated.

COMMIT;
