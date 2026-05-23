-- Neighborhood Engagement Hub - Fix overlap trigger + add MEK overlap check
--                              + grant neh_admin user management permissions
--
-- Problem: check_tool_reservation_overlap fires on tool_reservations UPDATE
-- for both 'approved' and 'checked_out' transitions. But confirm_checkout marks
-- instances as 'checked_out' BEFORE updating the reservation status, so by the
-- time the trigger fires, the instances are no longer 'in_service' and the
-- trigger sees 0 available → blocks the confirm.
--
-- Fix: Only run the overlap check for 'approved' transitions. The 'checked_out'
-- transition is a downstream effect of confirm_checkout, and availability was
-- already validated at approval time.
--
-- Also adds the same overlap protection to MEK requests, which had no
-- availability check at all.
--
-- Also grants neh_admin user management permissions (read/create/update on
-- civic_os_users_private) and role delegation (neh_admin can assign neh_staff
-- and neh_admin roles).
--
-- Requires: v0.55.0+ (script 25 checkout lifecycle)

BEGIN;

-- ============================================================================
-- 1. FIX tool_reservation overlap trigger
--    Remove 'checked_out' from the gate check
-- ============================================================================

CREATE OR REPLACE FUNCTION check_tool_reservation_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tool RECORD;
    v_conflict_count INT;
    v_available_count INT;
BEGIN
    -- Only check when transitioning TO approved (not checked_out).
    -- checked_out is a downstream effect of confirm_checkout — availability
    -- was already validated at approval time, and instances are already
    -- marked checked_out by the confirm function before this trigger fires.
    IF NEW.workflow_status_id NOT IN (
        SELECT id FROM metadata.statuses
        WHERE entity_type = 'tool_reservations'
        AND status_key = 'approved'
    ) THEN RETURN NEW; END IF;

    -- For each tool type in this reservation (via step junction)
    FOR v_tool IN
        SELECT tt.id as tool_type_id, tt.display_name, tt.is_qty_managed, tt.total_quantity
        FROM tool_reservation_tool_items trti
        JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
        JOIN tool_types tt ON tt.id = trti.tool_type_id
        WHERE trt.tool_reservation_id = NEW.id
    LOOP
        -- Count conflicting approved/checked_out reservations with same tool_type
        SELECT COUNT(*) INTO v_conflict_count
        FROM tool_reservation_tool_items trti2
        JOIN tool_reservation_tools trt2 ON trt2.id = trti2.tool_reservation_tools_id
        JOIN tool_reservations tr2 ON tr2.id = trt2.tool_reservation_id
        WHERE trti2.tool_type_id = v_tool.tool_type_id
          AND tr2.id != NEW.id
          AND tr2.timeslot && NEW.timeslot
          AND tr2.workflow_status_id IN (
              SELECT id FROM metadata.statuses
              WHERE entity_type = 'tool_reservations'
              AND status_key IN ('approved', 'checked_out')
          );

        -- Determine available count
        IF v_tool.is_qty_managed THEN
            v_available_count := COALESCE(v_tool.total_quantity, 0);
        ELSE
            SELECT COUNT(*) INTO v_available_count
            FROM tool_instances ti
            JOIN metadata.statuses s ON ti.status_id = s.id
            WHERE ti.tool_type_id = v_tool.tool_type_id
              AND s.status_key = 'in_service';
        END IF;

        IF v_conflict_count >= v_available_count THEN
            RAISE EXCEPTION '% is fully reserved for this time window (% available, % conflicting)',
                v_tool.display_name, v_available_count, v_conflict_count;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. ADD MEK overlap trigger
--    Same logic, approved-only gate, MEK inventory only
-- ============================================================================

CREATE OR REPLACE FUNCTION check_mek_request_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tool RECORD;
    v_conflict_count INT;
    v_available_count INT;
BEGIN
    -- Only check when transitioning TO approved (not checked_out).
    IF NEW.status_id NOT IN (
        SELECT id FROM metadata.statuses
        WHERE entity_type = 'mek_requests'
        AND status_key = 'approved'
    ) THEN RETURN NEW; END IF;

    -- For each tool type in this MEK request (via equipment junction)
    FOR v_tool IN
        SELECT tt.id as tool_type_id, tt.display_name, tt.is_qty_managed, tt.total_quantity
        FROM mek_request_equipment_items mrei
        JOIN mek_request_equipment mre ON mre.id = mrei.mek_request_equipment_id
        JOIN tool_types tt ON tt.id = mrei.tool_type_id
        WHERE mre.mek_request_id = NEW.id
    LOOP
        -- Count conflicting approved/checked_out MEK requests with same tool_type
        SELECT COUNT(*) INTO v_conflict_count
        FROM mek_request_equipment_items mrei2
        JOIN mek_request_equipment mre2 ON mre2.id = mrei2.mek_request_equipment_id
        JOIN mek_requests mr2 ON mr2.id = mre2.mek_request_id
        WHERE mrei2.tool_type_id = v_tool.tool_type_id
          AND mr2.id != NEW.id
          AND mr2.timeslot && NEW.timeslot
          AND mr2.status_id IN (
              SELECT id FROM metadata.statuses
              WHERE entity_type = 'mek_requests'
              AND status_key IN ('approved', 'checked_out')
          );

        -- Determine available count
        IF v_tool.is_qty_managed THEN
            v_available_count := COALESCE(v_tool.total_quantity, 0);
        ELSE
            SELECT COUNT(*) INTO v_available_count
            FROM tool_instances ti
            JOIN metadata.statuses s ON ti.status_id = s.id
            WHERE ti.tool_type_id = v_tool.tool_type_id
              AND s.status_key = 'in_service';
        END IF;

        IF v_conflict_count >= v_available_count THEN
            RAISE EXCEPTION '% is fully reserved for this time window (% available, % conflicting)',
                v_tool.display_name, v_available_count, v_conflict_count;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

-- Create the MEK overlap trigger (BEFORE UPDATE on mek_requests)
DROP TRIGGER IF EXISTS mek_request_overlap_trigger ON mek_requests;
CREATE TRIGGER mek_request_overlap_trigger
    BEFORE UPDATE ON mek_requests
    FOR EACH ROW
    EXECUTE FUNCTION check_mek_request_overlap();

-- ============================================================================
-- 3. GRANT neh_admin user management permissions
--    read + create + update on civic_os_users_private so neh_admin can
--    see the User Management page and add/edit users
-- ============================================================================

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, get_role_id('neh_admin')
FROM metadata.permissions p
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission IN ('read', 'create', 'update')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. ROLE DELEGATION
--    neh_admin can assign neh_staff and neh_admin roles
--    admin can assign neh_admin and neh_staff roles
-- ============================================================================

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT get_role_id('neh_admin'), get_role_id('neh_staff')
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.role_can_manage
    WHERE manager_role_id = get_role_id('neh_admin')
      AND managed_role_id = get_role_id('neh_staff')
);

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT get_role_id('neh_admin'), get_role_id('neh_admin')
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.role_can_manage
    WHERE manager_role_id = get_role_id('neh_admin')
      AND managed_role_id = get_role_id('neh_admin')
);

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT get_role_id('admin'), get_role_id('neh_admin')
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.role_can_manage
    WHERE manager_role_id = get_role_id('admin')
      AND managed_role_id = get_role_id('neh_admin')
);

INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
SELECT get_role_id('admin'), get_role_id('neh_staff')
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.role_can_manage
    WHERE manager_role_id = get_role_id('admin')
      AND managed_role_id = get_role_id('neh_staff')
);

-- ============================================================================
-- ADR
-- ============================================================================

INSERT INTO metadata.schema_decisions (title, decision, entity_types, status, decided_date)
VALUES (
    'Overlap triggers only check on approved transition; neh_admin user management',
    'Three fixes: (1) check_tool_reservation_overlap was blocking confirm_checkout because '
        'confirm marks instances checked_out before updating reservation status — trigger saw '
        '0 in_service instances. Fix: only fire on approved, not checked_out. (2) MEK requests '
        'had no overlap check. Added check_mek_request_overlap with the same approved-only gate. '
        'Each system checks only within its own inventory pool. (3) Granted neh_admin read/create/update '
        'on civic_os_users_private so NEH admins can manage users. Added role delegation so neh_admin '
        'can assign neh_staff and neh_admin roles.',
    ARRAY['tool_reservations', 'mek_requests']::name[],
    'accepted',
    CURRENT_DATE
);

COMMIT;
