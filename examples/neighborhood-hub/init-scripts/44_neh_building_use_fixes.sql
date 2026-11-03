-- Neighborhood Engagement Hub - Building use request limits, Cancel and Complete, orphan cleanup
--
-- Three repairs found while auditing the deployed configuration.
--
--   1. Request cap. check_no_pending_building_use_request (script 07) blocked a
--      non-staff user from starting a new building use request once they could
--      see 5 requests in any status. Completed, denied and cancelled requests
--      counted, so a group that had used the building five times could never
--      ask again without deleting history. Since script 43 the count also took
--      in requests staff created that name the user as borrower. The cap now
--      counts only the user's own open requests: submitted, created by them,
--      and either pending or approved with an event that has not ended. Drafts
--      do not count. Staff, NEH admins and admins still bypass it.
--
--   2. Cancel and Complete. building_use_requests has Cancelled and Completed
--      statuses but only Approve and Deny actions, so those statuses were
--      reachable only by editing the record. Two staff actions are added, in
--      the shape of the event kit Cancel and Complete:
--        - Cancel: pending or approved, optional reason appended to
--          decision_notes. Cancelling an approved request frees its rooms,
--          because the overlap checks only look at approved requests.
--        - Complete: approved, and only once the time slot has ended.
--      Requesters cannot cancel their own requests yet. The guided form lock
--      (metadata.block_submitted_update) checks the caller's JWT permissions,
--      so even a SECURITY DEFINER function cannot update a submitted request
--      for a user without update permission. That needs a framework change.
--      Neither action sends a notification; no template exists for either
--      status and the status trigger ignores them.
--
--   3. Orphan metadata. Script 17 dropped the checkout_instances table but left
--      its metadata.entities row, 2 metadata.properties rows and 4 permissions
--      with their role grants. They are deleted.
--
-- Safe to re-run: functions are replaced, actions and grants upsert, and the
-- cleanup deletes nothing once the rows are gone.

BEGIN;

-- ===========================================================================
-- 1. Request cap: the user's own open requests, at most 5
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.check_no_pending_building_use_request(p_guided_form_key NAME)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata, public, pg_catalog
AS $$
DECLARE
    v_open INTEGER;
BEGIN
    -- Staff and admin bypass the cap
    IF 'neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin() THEN
        RETURN jsonb_build_object('success', true);
    END IF;

    SELECT COUNT(*) INTO v_open
    FROM public.building_use_requests r
    JOIN metadata.statuses s ON s.id = r.status_id
    WHERE r.created_by = current_user_id()
      AND r.submitted_at IS NOT NULL
      AND (s.status_key = 'pending'
           OR (s.status_key = 'approved'
               AND (r.time_slot IS NULL OR upper_inf(r.time_slot) OR upper(r.time_slot) > now())));

    IF v_open >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You already have 5 open building use requests (waiting for a decision, '
                    || 'or approved for an event that has not happened yet). Once staff decide on one '
                    || 'or one of your events has taken place, you can start a new request.'
        );
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.check_no_pending_building_use_request(NAME) IS
    'Precondition RPC for the building_use_request guided form. Blocks a non-staff user who already has '
    '5 open requests of their own: submitted, and pending or approved with an event that has not ended.';

REVOKE EXECUTE ON FUNCTION public.check_no_pending_building_use_request(NAME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_no_pending_building_use_request(NAME) TO authenticated;

-- ===========================================================================
-- 2a. Cancel: staff, pending or approved
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.cancel_building_use_request(p_entity_id BIGINT, p_reason TEXT DEFAULT NULL)
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
            USING HINT = 'Must be logged in to cancel building use requests';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT s.status_key INTO v_current_key
    FROM building_use_requests r
    JOIN metadata.statuses s ON s.id = r.status_id
    WHERE r.id = p_entity_id;

    IF v_current_key IS NULL OR v_current_key NOT IN ('pending', 'approved') THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only pending or approved requests can be cancelled. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'building_use_requests' AND status_key = 'cancelled';

    UPDATE building_use_requests
    SET status_id = v_target_id,
        decision_notes = CASE WHEN NULLIF(btrim(p_reason), '') IS NOT NULL
                         THEN COALESCE(decision_notes || E'\n', '') || 'Cancelled: ' || btrim(p_reason)
                         ELSE decision_notes END
    WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Building use request cancelled.');
END;
$$;

COMMENT ON FUNCTION public.cancel_building_use_request(BIGINT, TEXT) IS
    'Entity action RPC: staff cancel a pending or approved building use request, with an optional reason '
    'appended to decision_notes. Cancelling an approved request frees its rooms.';

REVOKE EXECUTE ON FUNCTION public.cancel_building_use_request(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_building_use_request(BIGINT, TEXT) TO authenticated;

SELECT metadata.auto_register_function(
    'cancel_building_use_request',
    'Cancel a pending or approved building use request (staff only)'
);

-- ===========================================================================
-- 2b. Complete: staff, approved, after the event has ended
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.complete_building_use_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_current_key TEXT;
    v_time_slot TSTZRANGE;
    v_target_id INT;
BEGIN
    -- Authorization guard: NEH staff, NEH admin or Civic OS admin only
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to complete building use requests';
    END IF;
    IF NOT ('neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin()) THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires the neh_staff, neh_admin or admin role';
    END IF;

    SELECT s.status_key, r.time_slot INTO v_current_key, v_time_slot
    FROM building_use_requests r
    JOIN metadata.statuses s ON s.id = r.status_id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only approved requests can be completed. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    IF v_time_slot IS NULL OR upper_inf(v_time_slot) THEN
        RETURN jsonb_build_object('success', false,
            'message', 'This request has no end time, so it cannot be marked completed.');
    END IF;

    IF upper(v_time_slot) > now() THEN
        RETURN jsonb_build_object('success', false,
            'message', 'This request can be completed after the event ends.');
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'building_use_requests' AND status_key = 'completed';

    UPDATE building_use_requests SET status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Building use request completed.');
END;
$$;

COMMENT ON FUNCTION public.complete_building_use_request(BIGINT) IS
    'Entity action RPC: staff mark an approved building use request completed once its time slot has ended.';

REVOKE EXECUTE ON FUNCTION public.complete_building_use_request(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_building_use_request(BIGINT) TO authenticated;

SELECT metadata.auto_register_function(
    'complete_building_use_request',
    'Mark an approved building use request completed after its event ends (staff only)'
);

-- ===========================================================================
-- 2c. Entity actions, parameter and roles
-- Sort after Approve (5) and Deny (10), as on event kit requests.
-- ===========================================================================

INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, icon, button_style,
    rpc_function, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, refresh_after_action, sort_order
) VALUES
(
    'building_use_requests', 'complete', 'Complete',
    'Mark this request completed after the event has taken place',
    'task_alt', 'success', 'complete_building_use_request', false, NULL,
    '{"field": "status_id.status_key", "value": "approved", "operator": "eq"}'::jsonb,
    '{"field": "status_id.status_key", "value": "approved", "operator": "eq"}'::jsonb,
    true, 20
),
(
    'building_use_requests', 'cancel', 'Cancel',
    'Cancel this building use request',
    'cancel', 'ghost', 'cancel_building_use_request', true,
    'Are you sure you want to cancel this request? Approved rooms become available again.',
    '{"field": "status_id.status_key", "value": ["pending", "approved"], "operator": "in"}'::jsonb,
    '{"field": "status_id.status_key", "value": ["pending", "approved"], "operator": "in"}'::jsonb,
    true, 30
)
ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name          = EXCLUDED.display_name,
    description           = EXCLUDED.description,
    icon                  = EXCLUDED.icon,
    button_style          = EXCLUDED.button_style,
    rpc_function          = EXCLUDED.rpc_function,
    requires_confirmation = EXCLUDED.requires_confirmation,
    confirmation_message  = EXCLUDED.confirmation_message,
    visibility_condition  = EXCLUDED.visibility_condition,
    enabled_condition     = EXCLUDED.enabled_condition,
    refresh_after_action  = EXCLUDED.refresh_after_action,
    sort_order            = EXCLUDED.sort_order;

INSERT INTO metadata.entity_action_params (
    entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder
)
SELECT ea.id, 'p_reason', 'Reason (optional)', 'text', false, 10, 'Enter reason for cancellation...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'building_use_requests' AND ea.action_name = 'cancel'
  AND NOT EXISTS (
      SELECT 1 FROM metadata.entity_action_params p
      WHERE p.entity_action_id = ea.id AND p.param_name = 'p_reason'
  );

-- Same role set as Approve and Deny, and as the guards inside both functions
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'building_use_requests'
  AND ea.action_name IN ('cancel', 'complete')
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin')
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 3. Orphan metadata for the dropped checkout_instances table
-- ===========================================================================

DO $$
DECLARE
    v_grants INT;
    v_perms  INT;
    v_props  INT;
    v_ents   INT;
BEGIN
    IF to_regclass('public.checkout_instances') IS NOT NULL THEN
        RAISE EXCEPTION 'public.checkout_instances exists; refusing to delete its metadata';
    END IF;

    DELETE FROM metadata.permission_roles pr
    USING metadata.permissions p
    WHERE p.id = pr.permission_id
      AND (p.table_name = 'checkout_instances' OR p.table_name LIKE 'checkout\_instances:%');
    GET DIAGNOSTICS v_grants = ROW_COUNT;

    DELETE FROM metadata.permissions
    WHERE table_name = 'checkout_instances' OR table_name LIKE 'checkout\_instances:%';
    GET DIAGNOSTICS v_perms = ROW_COUNT;

    DELETE FROM metadata.properties WHERE table_name = 'checkout_instances';
    GET DIAGNOSTICS v_props = ROW_COUNT;

    DELETE FROM metadata.entities WHERE table_name = 'checkout_instances';
    GET DIAGNOSTICS v_ents = ROW_COUNT;

    RAISE NOTICE 'checkout_instances cleanup: % role grants, % permissions, % properties, % entities',
        v_grants, v_perms, v_props, v_ents;
END $$;

-- ===========================================================================
-- 4. Closing assertions
-- ===========================================================================

DO $$
DECLARE
    v_actions INT;
    v_roles   INT;
    v_public  INT;
BEGIN
    SELECT count(*) INTO v_actions FROM metadata.entity_actions
    WHERE table_name = 'building_use_requests'
      AND action_name IN ('approve_request', 'deny_request', 'complete', 'cancel');
    IF v_actions <> 4 THEN
        RAISE EXCEPTION 'Expected 4 building use actions, found %', v_actions;
    END IF;

    SELECT count(*) INTO v_roles
    FROM metadata.entity_action_roles ear
    JOIN metadata.entity_actions ea ON ea.id = ear.entity_action_id
    WHERE ea.table_name = 'building_use_requests' AND ea.action_name IN ('complete', 'cancel');
    IF v_roles <> 6 THEN
        RAISE EXCEPTION 'Expected 6 role grants on Cancel and Complete, found %', v_roles;
    END IF;

    SELECT count(*) INTO v_public FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('check_no_pending_building_use_request', 'cancel_building_use_request',
                        'complete_building_use_request')
      AND has_function_privilege('public', p.oid, 'EXECUTE');
    IF v_public <> 0 THEN
        RAISE EXCEPTION '% building use functions are still executable by PUBLIC', v_public;
    END IF;

    IF EXISTS (SELECT 1 FROM metadata.entities WHERE table_name = 'checkout_instances')
       OR EXISTS (SELECT 1 FROM metadata.permissions WHERE table_name = 'checkout_instances') THEN
        RAISE EXCEPTION 'checkout_instances metadata remains';
    END IF;
END $$;

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['building_use_requests']::NAME[],
    'neh-44-building-use-fixes',
    'Building use cap counts open requests; staff Cancel and Complete actions',
    'accepted',
    'The building use precondition blocked users who could see 5 requests in any status, so past use '
    'counted against new requests. Cancelled and Completed statuses had no actions. Metadata for the '
    'dropped checkout_instances table was still registered.',
    'The precondition counts only the caller''s own submitted requests that are pending, or approved '
    'with an event that has not ended, capped at 5. Staff get Cancel (pending or approved, optional '
    'reason) and Complete (approved, after the time slot ends). Orphan checkout_instances metadata is '
    'deleted.',
    'The cap exists to limit outstanding demand on staff and rooms, which past requests do not create. '
    'Cancel and Complete follow the event kit actions. Requester self-cancel needs the framework guided '
    'form lock to let SECURITY DEFINER functions through, so it is deferred.',
    'Repeat requesters are no longer locked out. Staff can close out and cancel requests without '
    'editing records; a cancelled approved request frees its rooms. Neither action notifies the '
    'requester.',
    CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions WHERE migration_id = 'neh-44-building-use-fixes'
);

COMMIT;
