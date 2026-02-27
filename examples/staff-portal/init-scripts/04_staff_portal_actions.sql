-- ============================================================================
-- ENTITY ACTION BUTTONS FOR STAFF PORTAL
-- ============================================================================
-- Demonstrates: Multi-entity workflow actions using Entity Actions (v0.18.0)
--
-- Features:
--   - Clock in/out actions on staff_members
--   - Approve/Deny workflow for time_off_requests
--   - Approve/Request Revision workflow for staff_documents
--   - Approve/Deny workflow for reimbursements
--   - Conditional visibility and enablement based on status
--   - Navigation to edit pages for actions requiring notes
--   - Confirmation modals before approval/denial actions
--
-- Entities & Actions:
--   | Entity              | Actions                      |
--   |---------------------|------------------------------|
--   | staff_members       | Clock In, Clock Out          |
--   | time_off_requests   | Approve, Deny                |
--   | staff_documents     | Approve, Request Revision    |
--   | reimbursements      | Approve, Deny                |
-- ============================================================================

-- ============================================================================
-- 1. RPC FUNCTIONS FOR WORKFLOW ACTIONS
-- ============================================================================

-- CLOCK IN: Creates a clock_in time entry for the staff member
CREATE OR REPLACE FUNCTION public.staff_clock_in(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_time_text TEXT;
BEGIN
  -- Verify caller is the staff member (prevent clocking in for others)
  IF p_entity_id <> get_current_staff_member_id() THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'You can only clock in for yourself'
    );
  END IF;

  -- Create time entry (denormalize trigger fills staff_name and site_name)
  INSERT INTO time_entries (staff_member_id, entry_type, entry_time)
  VALUES (p_entity_id, 'clock_in', NOW());

  v_time_text := TO_CHAR(NOW(), 'HH:MI AM');

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Clocked in at ' || v_time_text,
    'refresh', true
  );
END;
$$;

-- CLOCK OUT: Creates a clock_out time entry for the staff member
CREATE OR REPLACE FUNCTION public.staff_clock_out(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_time_text TEXT;
BEGIN
  -- Verify caller is the staff member (prevent clocking out for others)
  IF p_entity_id <> get_current_staff_member_id() THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'You can only clock out for yourself'
    );
  END IF;

  -- Create time entry (denormalize trigger fills staff_name and site_name)
  INSERT INTO time_entries (staff_member_id, entry_type, entry_time)
  VALUES (p_entity_id, 'clock_out', NOW());

  v_time_text := TO_CHAR(NOW(), 'HH:MI AM');

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Clocked out at ' || v_time_text,
    'refresh', true
  );
END;
$$;

-- APPROVE TIME OFF: Changes time_off_request status to Approved
CREATE OR REPLACE FUNCTION public.approve_time_off(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_pending_id INT;
  v_request RECORD;
  v_my_staff_id BIGINT;
BEGIN
  -- Permission check: requires time_off_requests:update permission
  IF NOT has_permission('time_off_requests', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to approve time off requests');
  END IF;

  -- Get status IDs
  SELECT id INTO v_approved_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Approved';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Pending';

  -- Get current request
  SELECT * INTO v_request FROM time_off_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Time off request not found');
  END IF;

  -- Prevent self-approval: cannot approve your own time-off request
  v_my_staff_id := get_current_staff_member_id();
  IF v_my_staff_id IS NOT NULL AND v_request.staff_member_id = v_my_staff_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot approve your own time off request');
  END IF;

  -- Validate state
  IF v_request.status_id != v_pending_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be approved');
  END IF;

  -- Update status
  UPDATE time_off_requests SET
    status_id = v_approved_id,
    responded_by = current_user_id(),
    responded_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Time off request approved.',
    'refresh', true
  );
END;
$$;

-- DENY TIME OFF: Changes time_off_request status to Denied
CREATE OR REPLACE FUNCTION public.deny_time_off(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_denied_id INT;
  v_pending_id INT;
  v_request RECORD;
  v_my_staff_id BIGINT;
BEGIN
  -- Permission check: requires time_off_requests:update permission
  IF NOT has_permission('time_off_requests', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to deny time off requests');
  END IF;

  SELECT id INTO v_denied_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Denied';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Pending';

  SELECT * INTO v_request FROM time_off_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Time off request not found');
  END IF;

  -- Prevent self-denial: cannot deny your own time-off request
  v_my_staff_id := get_current_staff_member_id();
  IF v_my_staff_id IS NOT NULL AND v_request.staff_member_id = v_my_staff_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot deny your own time off request');
  END IF;

  IF v_request.status_id != v_pending_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be denied');
  END IF;

  UPDATE time_off_requests SET
    status_id = v_denied_id,
    responded_by = current_user_id(),
    responded_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Time off request denied.',
    'navigate', '/edit/time_off_requests/' || p_entity_id
  );
END;
$$;

-- APPROVE DOCUMENT: Changes staff_document status to Approved
CREATE OR REPLACE FUNCTION public.approve_staff_document(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_submitted_id INT;
  v_document RECORD;
  v_my_staff_id BIGINT;
BEGIN
  -- Permission check: requires staff_documents:update permission
  IF NOT has_permission('staff_documents', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to approve documents');
  END IF;

  SELECT id INTO v_approved_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Approved';
  SELECT id INTO v_submitted_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Submitted';

  SELECT * INTO v_document FROM staff_documents WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Document not found');
  END IF;

  -- Prevent self-approval: staff cannot approve their own documents
  v_my_staff_id := get_current_staff_member_id();
  IF v_my_staff_id IS NOT NULL AND v_document.staff_member_id = v_my_staff_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot approve your own documents');
  END IF;

  IF v_document.status_id != v_submitted_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only submitted documents can be approved');
  END IF;

  -- Update status (trg_update_onboarding_status trigger recalculates onboarding status)
  UPDATE staff_documents SET
    status_id = v_approved_id,
    reviewed_by = current_user_id(),
    reviewed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Document approved.',
    'refresh', true
  );
END;
$$;

-- REQUEST DOCUMENT REVISION: Changes staff_document status to Needs Revision
CREATE OR REPLACE FUNCTION public.request_document_revision(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_needs_revision_id INT;
  v_submitted_id INT;
  v_document RECORD;
  v_my_staff_id BIGINT;
BEGIN
  -- Permission check: requires staff_documents:update permission
  IF NOT has_permission('staff_documents', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to request document revisions');
  END IF;

  SELECT id INTO v_needs_revision_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Needs Revision';
  SELECT id INTO v_submitted_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Submitted';

  SELECT * INTO v_document FROM staff_documents WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Document not found');
  END IF;

  -- Prevent self-action: staff cannot request revision on their own documents
  v_my_staff_id := get_current_staff_member_id();
  IF v_my_staff_id IS NOT NULL AND v_document.staff_member_id = v_my_staff_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot request revision on your own documents');
  END IF;

  IF v_document.status_id != v_submitted_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only submitted documents can be sent back for revision');
  END IF;

  UPDATE staff_documents SET
    status_id = v_needs_revision_id
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Document sent back for revision.',
    'navigate', '/edit/staff_documents/' || p_entity_id
  );
END;
$$;

-- APPROVE REIMBURSEMENT: Changes reimbursement status to Approved
CREATE OR REPLACE FUNCTION public.approve_reimbursement(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_pending_id INT;
  v_reimbursement RECORD;
  v_my_staff_id BIGINT;
BEGIN
  -- Permission check: requires reimbursements:update permission
  IF NOT has_permission('reimbursements', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to approve reimbursements');
  END IF;

  SELECT id INTO v_approved_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Approved';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Pending';

  SELECT * INTO v_reimbursement FROM reimbursements WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reimbursement not found');
  END IF;

  -- Prevent self-approval: cannot approve your own reimbursement
  v_my_staff_id := get_current_staff_member_id();
  IF v_my_staff_id IS NOT NULL AND v_reimbursement.staff_member_id = v_my_staff_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot approve your own reimbursement');
  END IF;

  IF v_reimbursement.status_id != v_pending_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending reimbursements can be approved');
  END IF;

  UPDATE reimbursements SET
    status_id = v_approved_id,
    responded_by = current_user_id(),
    responded_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Reimbursement approved.',
    'refresh', true
  );
END;
$$;

-- DENY REIMBURSEMENT: Changes reimbursement status to Denied
CREATE OR REPLACE FUNCTION public.deny_reimbursement(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_denied_id INT;
  v_pending_id INT;
  v_reimbursement RECORD;
  v_my_staff_id BIGINT;
BEGIN
  -- Permission check: requires reimbursements:update permission
  IF NOT has_permission('reimbursements', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to deny reimbursements');
  END IF;

  SELECT id INTO v_denied_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Denied';
  SELECT id INTO v_pending_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Pending';

  SELECT * INTO v_reimbursement FROM reimbursements WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reimbursement not found');
  END IF;

  -- Prevent self-denial: cannot deny your own reimbursement
  v_my_staff_id := get_current_staff_member_id();
  IF v_my_staff_id IS NOT NULL AND v_reimbursement.staff_member_id = v_my_staff_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot deny your own reimbursement');
  END IF;

  IF v_reimbursement.status_id != v_pending_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending reimbursements can be denied');
  END IF;

  UPDATE reimbursements SET
    status_id = v_denied_id,
    responded_by = current_user_id(),
    responded_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Reimbursement denied.',
    'navigate', '/edit/reimbursements/' || p_entity_id
  );
END;
$$;


-- ============================================================================
-- 2. GRANT EXECUTE PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.staff_clock_in(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_clock_out(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_time_off(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deny_time_off(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_staff_document(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_document_revision(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_reimbursement(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deny_reimbursement(BIGINT) TO authenticated;


-- ============================================================================
-- 3. ENTITY ACTIONS CONFIGURATION
-- ============================================================================
-- Use DO block to dynamically reference status IDs

DO $$
DECLARE
  -- time_off_request statuses
  v_tor_pending_id INT;
  v_tor_approved_id INT;
  v_tor_denied_id INT;
  -- staff_document statuses
  v_sd_submitted_id INT;
  v_sd_approved_id INT;
  v_sd_needs_revision_id INT;
  -- reimbursement statuses
  v_re_pending_id INT;
  v_re_approved_id INT;
  v_re_denied_id INT;
BEGIN
  -- ==============================
  -- Look up status IDs
  -- ==============================

  -- time_off_request statuses
  SELECT id INTO v_tor_pending_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Pending';
  SELECT id INTO v_tor_approved_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Approved';
  SELECT id INTO v_tor_denied_id FROM metadata.statuses
  WHERE entity_type = 'time_off_request' AND display_name = 'Denied';

  -- staff_document statuses
  SELECT id INTO v_sd_submitted_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Submitted';
  SELECT id INTO v_sd_approved_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Approved';
  SELECT id INTO v_sd_needs_revision_id FROM metadata.statuses
  WHERE entity_type = 'staff_document' AND display_name = 'Needs Revision';

  -- reimbursement statuses
  SELECT id INTO v_re_pending_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Pending';
  SELECT id INTO v_re_approved_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Approved';
  SELECT id INTO v_re_denied_id FROM metadata.statuses
  WHERE entity_type = 'reimbursement' AND display_name = 'Denied';

  -- ==============================
  -- staff_members actions
  -- ==============================

  -- CLOCK IN action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_members',
    'clock_in',
    'Clock In',
    'Record clock-in time for this staff member',
    'staff_clock_in',
    'login',
    'primary',
    10,
    FALSE,
    'Clocked in successfully.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;

  -- CLOCK OUT action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_members',
    'clock_out',
    'Clock Out',
    'Record clock-out time for this staff member',
    'staff_clock_out',
    'logout',
    'warning',
    20,
    FALSE,
    'Clocked out successfully.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;

  -- ==============================
  -- time_off_requests actions
  -- ==============================

  -- APPROVE TIME OFF action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'time_off_requests',
    'approve',
    'Approve',
    'Approve this time off request',
    'approve_time_off',
    'check_circle',
    'primary',
    10,
    TRUE,
    'Are you sure you want to approve this time off request?',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_tor_approved_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_tor_pending_id),
    'Only pending requests can be approved',
    'Time off request approved.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- DENY TIME OFF action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'time_off_requests',
    'deny',
    'Deny',
    'Deny this time off request',
    'deny_time_off',
    'cancel',
    'error',
    20,
    TRUE,
    'Are you sure you want to deny this time off request?',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_tor_denied_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_tor_pending_id),
    'Only pending requests can be denied',
    'Time off request denied.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- ==============================
  -- staff_documents actions
  -- ==============================

  -- APPROVE DOCUMENT action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_documents',
    'approve',
    'Approve',
    'Approve this submitted document',
    'approve_staff_document',
    'check_circle',
    'primary',
    10,
    TRUE,
    'Are you sure you want to approve this document?',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_sd_approved_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_sd_submitted_id),
    'Only submitted documents can be approved',
    'Document approved.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- REQUEST REVISION action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_documents',
    'request_revision',
    'Request Revision',
    'Send this document back for revision',
    'request_document_revision',
    'edit_note',
    'warning',
    20,
    FALSE,
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_sd_needs_revision_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_sd_submitted_id),
    'Only submitted documents can be sent back for revision',
    'Document sent back for revision.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- ==============================
  -- reimbursements actions
  -- ==============================

  -- APPROVE REIMBURSEMENT action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'reimbursements',
    'approve',
    'Approve',
    'Approve this reimbursement request',
    'approve_reimbursement',
    'check_circle',
    'primary',
    10,
    TRUE,
    'Are you sure you want to approve this reimbursement?',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_re_approved_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_re_pending_id),
    'Only pending reimbursements can be approved',
    'Reimbursement approved.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- DENY REIMBURSEMENT action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'reimbursements',
    'deny',
    'Deny',
    'Deny this reimbursement request',
    'deny_reimbursement',
    'cancel',
    'error',
    20,
    TRUE,
    'Are you sure you want to deny this reimbursement?',
    jsonb_build_object('field', 'status_id', 'operator', 'ne', 'value', v_re_denied_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_re_pending_id),
    'Only pending reimbursements can be denied',
    'Reimbursement denied.',
    TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

END $$;


-- ============================================================================
-- 4. GRANT ENTITY ACTION PERMISSIONS TO ROLES
-- ============================================================================
-- Must be done after entity_actions are inserted (section 3).

-- Clock in/out: user, site_lead, manager, admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'staff_members'
  AND ea.action_name IN ('clock_in', 'clock_out')
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Time off approve/deny: site_lead, manager, admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'time_off_requests'
  AND ea.action_name IN ('approve', 'deny')
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Document approve/request_revision: manager, admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'staff_documents'
  AND ea.action_name IN ('approve', 'request_revision')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- Reimbursement approve/deny: manager, admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reimbursements'
  AND ea.action_name IN ('approve', 'deny')
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 5. NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';
