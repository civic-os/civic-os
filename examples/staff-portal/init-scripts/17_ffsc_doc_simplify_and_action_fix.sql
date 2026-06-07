-- =============================================================================
-- 17_ffsc_doc_simplify_and_action_fix.sql
-- FFSC Instance Patch (v0.46.1)
--
-- 1. Fix has_entity_action_permission() role_key bug
--    (display_name comparison broke when roles were renamed in script 13)
-- 2. Fix complete_staff_task & start_staff_task RPCs
--    (allow assignees to complete/start their own tasks without update permission)
-- 3. Simplify document requirements to 2 items
-- 4. Repopulate staff_documents for all existing staff
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: Fix has_entity_action_permission() — role_key vs display_name bug
-- =============================================================================
-- The function compared r.display_name to JWT role claims, but get_user_roles()
-- returns role_keys ('user', 'editor') not display_names ('Team Member', 'Site Leadership').
-- This caused ALL non-admin action buttons to be hidden.

CREATE OR REPLACE FUNCTION metadata.has_entity_action_permission(p_action_id INT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        -- Admin bypass: admins can execute any entity action
        public.is_admin()
        OR
        -- Check if user has a role that grants permission
        EXISTS (
            SELECT 1
            FROM metadata.entity_action_roles ear
            JOIN metadata.roles r ON r.id = ear.role_id
            WHERE ear.entity_action_id = p_action_id
            AND r.role_key = ANY(public.get_user_roles())
        )
$$;

-- =============================================================================
-- PART 2: Fix staff task RPCs — allow assignees to act on their own tasks
-- =============================================================================

-- Fix complete_staff_task: assignees should be able to complete their own tasks
-- (mirrors the assignment-check pattern from start_staff_task)
CREATE OR REPLACE FUNCTION complete_staff_task(p_entity_id BIGINT, p_completion_notes TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_completed_id INT;
  v_task RECORD;
  v_current_staff_id BIGINT;
  v_current_site_id BIGINT;
  v_current_role_id INT;
  v_is_assigned BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'in_progress';
  SELECT id INTO v_completed_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'completed';

  SELECT * INTO v_task FROM staff_tasks WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task not found');
  END IF;

  -- Check if current user is assigned (direct, site, or role) OR has update permission
  v_current_staff_id := get_current_staff_member_id();

  IF v_task.assigned_to_id IS NOT NULL AND v_task.assigned_to_id = v_current_staff_id THEN
    v_is_assigned := TRUE;
  END IF;

  IF v_task.assigned_to_site_id IS NOT NULL THEN
    v_current_site_id := get_current_staff_member_site_id();
    IF v_task.assigned_to_site_id = v_current_site_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  IF v_task.assigned_to_role_id IS NOT NULL THEN
    SELECT role_id INTO v_current_role_id FROM staff_members WHERE id = v_current_staff_id;
    IF v_task.assigned_to_role_id = v_current_role_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  -- Allow if assigned OR has update permission (managers/admins)
  IF NOT v_is_assigned AND NOT has_permission('staff_tasks', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  IF v_task.status_id NOT IN (v_open_id, v_in_progress_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open or in-progress tasks can be completed');
  END IF;

  UPDATE staff_tasks SET
    status_id = v_completed_id,
    completion_notes = COALESCE(p_completion_notes, completion_notes),
    completed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task completed.', 'refresh', true);
END;
$$;

-- Fix start_staff_task: same pattern — allow assignees without requiring update permission
CREATE OR REPLACE FUNCTION start_staff_task(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_task RECORD;
  v_current_staff_id BIGINT;
  v_current_site_id BIGINT;
  v_current_role_id INT;
  v_is_assigned BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'in_progress';

  SELECT * INTO v_task FROM staff_tasks WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task not found');
  END IF;

  -- Check if current user is assigned (direct, site, or role)
  v_current_staff_id := get_current_staff_member_id();

  IF v_task.assigned_to_id IS NOT NULL AND v_task.assigned_to_id = v_current_staff_id THEN
    v_is_assigned := TRUE;
  END IF;

  IF v_task.assigned_to_site_id IS NOT NULL THEN
    v_current_site_id := get_current_staff_member_site_id();
    IF v_task.assigned_to_site_id = v_current_site_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  IF v_task.assigned_to_role_id IS NOT NULL THEN
    SELECT role_id INTO v_current_role_id FROM staff_members WHERE id = v_current_staff_id;
    IF v_task.assigned_to_role_id = v_current_role_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  -- Allow if assigned OR has update permission (managers/admins)
  IF NOT v_is_assigned AND NOT has_permission('staff_tasks', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  IF v_task.status_id != v_open_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open tasks can be started');
  END IF;

  UPDATE staff_tasks SET status_id = v_in_progress_id WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task started.', 'refresh', true);
END;
$$;

-- Fix cancel_staff_task: same pattern for consistency
CREATE OR REPLACE FUNCTION cancel_staff_task(p_entity_id BIGINT, p_cancel_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_cancelled_id INT;
  v_task RECORD;
  v_current_staff_id BIGINT;
  v_current_site_id BIGINT;
  v_current_role_id INT;
  v_is_assigned BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'in_progress';
  SELECT id INTO v_cancelled_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND status_key = 'cancelled';

  SELECT * INTO v_task FROM staff_tasks WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task not found');
  END IF;

  -- Check if current user is assigned (direct, site, or role)
  v_current_staff_id := get_current_staff_member_id();

  IF v_task.assigned_to_id IS NOT NULL AND v_task.assigned_to_id = v_current_staff_id THEN
    v_is_assigned := TRUE;
  END IF;

  IF v_task.assigned_to_site_id IS NOT NULL THEN
    v_current_site_id := get_current_staff_member_site_id();
    IF v_task.assigned_to_site_id = v_current_site_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  IF v_task.assigned_to_role_id IS NOT NULL THEN
    SELECT role_id INTO v_current_role_id FROM staff_members WHERE id = v_current_staff_id;
    IF v_task.assigned_to_role_id = v_current_role_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  -- Allow if assigned OR has update permission (managers/admins)
  IF NOT v_is_assigned AND NOT has_permission('staff_tasks', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  IF v_task.status_id NOT IN (v_open_id, v_in_progress_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open or in-progress tasks can be cancelled');
  END IF;

  UPDATE staff_tasks SET
    status_id = v_cancelled_id,
    completion_notes = COALESCE(p_cancel_reason, completion_notes)
  WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task cancelled.', 'refresh', true);
END;
$$;

-- =============================================================================
-- PART 3: Simplify document requirements
-- =============================================================================

-- Delete all existing staff_documents (all are Pending or test data)
DELETE FROM staff_documents;

-- Delete junction table records
DELETE FROM document_requirement_roles;

-- Delete all old document requirements
DELETE FROM document_requirements;

-- Insert new simplified requirements
INSERT INTO document_requirements (id, display_name, description, requires_approval, sort_order)
VALUES
  (1, 'Drivers License or Passport', 'A valid government-issued photo ID. Provide either a current drivers license or a valid passport.', true, 1),
  (2, 'Birth Certificate or Social Security Card (or Passport)', 'Proof of identity/citizenship. Provide one of: birth certificate, Social Security card, or a valid passport (if not already used for ID above).', true, 2);

-- Reset the sequence
SELECT setval(pg_get_serial_sequence('document_requirements', 'id'), 2);

-- Assign both requirements to ALL staff roles (no role-specific filtering needed)
-- Actually, since these apply to everyone, we leave the junction table empty.
-- The trigger logic: "WHERE NOT EXISTS (junction record) OR role matches" means
-- requirements with NO junction records apply to ALL roles.

-- =============================================================================
-- PART 4: Populate staff_documents for all existing staff
-- =============================================================================

-- Create document records for all existing staff members with both new requirements
INSERT INTO staff_documents (staff_member_id, requirement_id, display_name)
SELECT sm.id, dr.id, dr.display_name
FROM staff_members sm
CROSS JOIN document_requirements dr;

-- =============================================================================
-- PART 5: Add user role to staff_tasks read permission
-- =============================================================================
-- Team Members need read permission so the entity appears in sidebar and they can
-- navigate to their task detail pages (RLS already restricts them to their own tasks).

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p, metadata.roles r
WHERE p.table_name = 'staff_tasks' AND p.permission = 'read'
  AND r.role_key = 'user'
ON CONFLICT DO NOTHING;

COMMIT;
