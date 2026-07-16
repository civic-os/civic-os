-- =============================================================================
-- User Profile Client Actions — Surface client actions on /profile page
-- =============================================================================
-- The profile page (v0.65.0+) renders entity actions for civic_os_users.
-- ECS's client actions (activate, deactivate, reactivate, refer) are
-- registered on the clients table, so they don't appear on /profile.
--
-- This script creates thin wrapper RPCs that accept a user UUID, resolve the
-- linked client record, and delegate to the existing client action RPCs.
-- Entity actions are registered on civic_os_users with visibility conditions
-- that reference the client extension's status via dot-notation:
--   enrichedUserData.clients.status_id.status_key
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. WRAPPER RPCs
-- =============================================================================

-- 1. activate_client_by_user(UUID) → activate_client(BIGINT)
CREATE OR REPLACE FUNCTION activate_client_by_user(p_entity_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM activate_client(v_client_id);
END;
$$;

-- 2. deactivate_client_by_user(UUID) → deactivate_client(BIGINT)
CREATE OR REPLACE FUNCTION deactivate_client_by_user(p_entity_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM deactivate_client(v_client_id);
END;
$$;

-- 3. reactivate_client_by_user(UUID) → reactivate_client(BIGINT)
CREATE OR REPLACE FUNCTION reactivate_client_by_user(p_entity_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM reactivate_client(v_client_id);
END;
$$;

-- 4. refer_client_by_user(UUID, ...) → refer_client(BIGINT, ...)
CREATE OR REPLACE FUNCTION refer_client_by_user(
  p_entity_id UUID,
  p_partner_id BIGINT,
  p_referral_type_id INT,
  p_referral_date DATE DEFAULT CURRENT_DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM refer_client(v_client_id, p_partner_id, p_referral_type_id, p_referral_date);
END;
$$;

GRANT EXECUTE ON FUNCTION activate_client_by_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION deactivate_client_by_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reactivate_client_by_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION refer_client_by_user(UUID, BIGINT, INT, DATE) TO authenticated;


-- =============================================================================
-- B. REGISTER ENTITY ACTIONS ON civic_os_users
-- =============================================================================
-- Visibility conditions use dot-notation into the enriched extension data:
--   enrichedUserData.clients.status_id.status_key
-- The condition evaluator traverses: data → clients → status_id → status_key

INSERT INTO metadata.entity_actions
  (table_name, action_name, display_name, icon, button_style, sort_order,
   rpc_function, requires_confirmation, confirmation_message,
   visibility_condition, default_success_message, show_on_detail)
VALUES
  ('civic_os_users', 'activate_client', 'Activate Client', 'check_circle', 'success', 10,
   'activate_client_by_user', true,
   'Activate this client? This confirms their intake assessment is complete.',
   '{"field": "clients.status_id.status_key", "operator": "eq", "value": "intake_pending"}',
   'Client activated successfully.', true),

  ('civic_os_users', 'reactivate_client', 'Reactivate Client', 'restart_alt', 'primary', 11,
   'reactivate_client_by_user', true,
   'Reactivate this client?',
   '{"field": "clients.status_id.status_key", "operator": "eq", "value": "inactive"}',
   'Client reactivated.', true),

  ('civic_os_users', 'refer_client', 'Refer Client', 'send', 'primary', 15,
   'refer_client_by_user', false, NULL,
   '{"field": "clients.status_id.status_key", "operator": "eq", "value": "active"}',
   'Referral created successfully.', true),

  ('civic_os_users', 'deactivate_client', 'Deactivate Client', 'archive', 'warning', 20,
   'deactivate_client_by_user', true,
   'Deactivate this client? Their referral history will be preserved.',
   '{"field": "clients.status_id.status_key", "operator": "eq", "value": "active"}',
   'Client deactivated.', true);


-- =============================================================================
-- C. ACTION PARAMETERS (refer only — mirrors clients.refer params)
-- =============================================================================

INSERT INTO metadata.entity_action_params
  (entity_action_id, param_name, display_name, param_type, required, sort_order,
   join_table, join_column, category_entity_type)
VALUES
  ((SELECT id FROM metadata.entity_actions WHERE table_name = 'civic_os_users' AND action_name = 'refer_client'),
   'p_partner_id', 'Partner', 'foreign_key', true, 1, 'partners', 'id', NULL),

  ((SELECT id FROM metadata.entity_actions WHERE table_name = 'civic_os_users' AND action_name = 'refer_client'),
   'p_referral_type_id', 'Referral Type', 'category', true, 2, NULL, NULL, 'referral_type'),

  ((SELECT id FROM metadata.entity_actions WHERE table_name = 'civic_os_users' AND action_name = 'refer_client'),
   'p_referral_date', 'Referral Date', 'date', true, 3, NULL, NULL, NULL);


-- =============================================================================
-- D. ROLE PERMISSIONS (ecs_staff + admin, same as client actions)
-- =============================================================================

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'civic_os_users'
  AND ea.action_name IN ('activate_client', 'reactivate_client', 'refer_client', 'deactivate_client')
  AND r.role_key IN ('ecs_staff', 'admin')
ON CONFLICT DO NOTHING;


NOTIFY pgrst, 'reload schema';

COMMIT;
