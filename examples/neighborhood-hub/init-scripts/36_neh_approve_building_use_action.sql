-- ============================================================================
-- NEH: Approve Building Use Request entity action
-- ============================================================================
-- Mirrors the existing "Deny Request" pattern (deny_building_use_request RPC +
-- entity action) but transitions to 'approved' status.
--
-- When status changes to 'approved', the existing trigger
-- check_building_use_approval_overlap fires and validates that none of the
-- requested rooms have overlapping time slots with other approved requests.
-- If conflicts exist, the trigger raises an EXCEPTION and the approval fails.
-- ============================================================================

BEGIN;

-- ── 1. Create the approve RPC ──
CREATE OR REPLACE FUNCTION approve_building_use_request(
  p_entity_id BIGINT,
  p_decision_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_status TEXT;
    v_approved_status_id INT;
BEGIN
    -- Verify current status is pending
    SELECT s.status_key INTO v_current_status
    FROM public.building_use_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_status IS DISTINCT FROM 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Only pending requests can be approved. Current status: ' || COALESCE(v_current_status, 'unknown')
        );
    END IF;

    -- Check permissions (same roles as deny)
    IF NOT (
        'neh_staff' = ANY(get_user_roles()) OR
        'neh_admin' = ANY(get_user_roles()) OR
        is_admin()
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You do not have permission to approve building use requests.'
        );
    END IF;

    SELECT id INTO v_approved_status_id
    FROM metadata.statuses
    WHERE entity_type = 'building_use_requests' AND status_key = 'approved';

    -- This UPDATE triggers check_building_use_approval_overlap.
    -- If rooms conflict, the trigger raises an EXCEPTION and this
    -- entire transaction rolls back — PostgREST returns a 400.
    UPDATE public.building_use_requests
    SET status_id = v_approved_status_id,
        decision_notes = COALESCE(p_decision_notes, decision_notes)
    WHERE id = p_entity_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Building use request has been approved.'
    );
END;
$$;

-- Grant execute to authenticated (RPC does its own role check internally)
GRANT EXECUTE ON FUNCTION approve_building_use_request(BIGINT, TEXT) TO authenticated;

-- Register for introspection
SELECT metadata.auto_register_function(
  'approve_building_use_request',
  'Approve a building use request with room conflict validation'
);


-- ── 2. Create the entity action ──
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description, icon, button_style,
  rpc_function, requires_confirmation, confirmation_message,
  visibility_condition, enabled_condition, refresh_after_action, sort_order
) VALUES (
  'building_use_requests',
  'approve_request',
  'Approve Request',
  'Approve this building use request. Checks for room scheduling conflicts.',
  'check_circle',
  'success',
  'approve_building_use_request',
  true,
  'Are you sure you want to approve this building use request? Room availability will be validated.',
  '{"field": "status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb,
  '{"field": "status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb,
  true,
  5  -- Sort before Deny (sort_order=10)
);

-- ── 3. Add optional decision_notes param to the approve action ──
INSERT INTO metadata.entity_action_params (
  entity_action_id,
  param_name, display_name, param_type, required, sort_order, placeholder
) VALUES (
  (SELECT id FROM metadata.entity_actions
   WHERE table_name = 'building_use_requests' AND action_name = 'approve_request'),
  'p_decision_notes',
  'Notes (optional)',
  'text',
  false,
  10,
  'Enter any approval notes...'
);


-- ── 4. Also update the Deny action to use dot-notation status_key ──
-- (Currently uses numeric status_id = 22 which isn't portable across environments)
UPDATE metadata.entity_actions
SET visibility_condition = '{"field": "status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb,
    enabled_condition = '{"field": "status_id.status_key", "value": "pending", "operator": "eq"}'::jsonb
WHERE table_name = 'building_use_requests' AND action_name = 'deny_request';


COMMIT;
