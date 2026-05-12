-- Neighborhood Engagement Hub - Mobile Event Kit (MEK) Request GuidedForm
-- Allows community members to request event equipment (tables, chairs, tents,
-- PA systems, games) via a guided form. Follows the same pattern as
-- tool_reservations: precondition checks borrower approval, on_submit sets
-- status to pending, deny action button for staff.
--
-- GuidedForm: MEK Request
--   Step 0 (Parent): Event info, dates, responsibility acknowledgment
--   Step 1: Equipment selection (required) - M:M with tool_types filtered
--           to event_kit inventory module
--
-- Prerequisites:
--   03_neh_statuses.sql  - mek_requests status type + values
--   05_neh_options_rpcs.sql - check_borrower_approved(), get_borrowers_for_reservation()

-- ============================================================================
-- CATEGORIES
-- ============================================================================

-- MEK event type category group
INSERT INTO metadata.category_groups (entity_type, display_name)
VALUES ('mek_event_type', 'MEK Event Type')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order)
VALUES
  ('mek_event_type', 'Block Party',    'block_party',    '#22c55e', 1),
  ('mek_event_type', 'Community Fair', 'community_fair', '#3b82f6', 2),
  ('mek_event_type', 'Fundraiser',     'fundraiser',     '#f59e0b', 3),
  ('mek_event_type', 'Birthday Party', 'birthday_party', '#8b5cf6', 4),
  ('mek_event_type', 'Memorial',       'memorial',       '#6b7280', 5),
  ('mek_event_type', 'Other',          'other',          '#94a3b8', 6)
ON CONFLICT (entity_type, display_name) DO NOTHING;

-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mek_requests (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(255),
    submitted_at TIMESTAMPTZ,
    borrower_id BIGINT NOT NULL DEFAULT current_borrower_id() REFERENCES borrowers(id),
    organization_name VARCHAR(255),
    event_type INTEGER REFERENCES metadata.categories(id),
    event_location VARCHAR(500),
    event_dates TEXT,
    pickup_date DATE NOT NULL,
    return_date DATE NOT NULL,
    responsibility_acknowledged BOOLEAN DEFAULT false,
    notes TEXT,
    decision_notes TEXT,
    status_id INT REFERENCES metadata.statuses(id) DEFAULT get_initial_status('guided_form'),
    created_by UUID DEFAULT current_user_id(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mek_return_after_pickup CHECK (return_date >= pickup_date)
);

-- Equipment selection step entity (child of mek_requests)
CREATE TABLE IF NOT EXISTS public.mek_request_equipment (
    id BIGSERIAL PRIMARY KEY,
    mek_request_id BIGINT NOT NULL REFERENCES mek_requests(id) ON DELETE CASCADE,
    equipment_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rich junction: equipment selection <-> tool_types (M:M with quantity)
CREATE TABLE IF NOT EXISTS public.mek_request_equipment_items (
    mek_request_equipment_id BIGINT NOT NULL REFERENCES mek_request_equipment(id) ON DELETE CASCADE,
    tool_type_id INT NOT NULL REFERENCES tool_types(id),
    quantity INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mek_request_equipment_id, tool_type_id)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_mek_requests_borrower ON mek_requests(borrower_id);
CREATE INDEX IF NOT EXISTS idx_mek_requests_event_type ON mek_requests(event_type);
CREATE INDEX IF NOT EXISTS idx_mek_requests_status ON mek_requests(status_id);
CREATE INDEX IF NOT EXISTS idx_mek_requests_pickup ON mek_requests(pickup_date);
CREATE INDEX IF NOT EXISTS idx_mek_requests_return ON mek_requests(return_date);
CREATE INDEX IF NOT EXISTS idx_mek_request_equipment_request ON mek_request_equipment(mek_request_id);
CREATE INDEX IF NOT EXISTS idx_mek_request_equipment_items_equip ON mek_request_equipment_items(mek_request_equipment_id);
CREATE INDEX IF NOT EXISTS idx_mek_request_equipment_items_type ON mek_request_equipment_items(tool_type_id);

-- ============================================================================
-- GRANTS
-- ============================================================================

-- Grant to web_anon (read-only public access)
GRANT SELECT ON mek_requests TO web_anon;
GRANT SELECT ON mek_request_equipment TO web_anon;
GRANT SELECT ON mek_request_equipment_items TO web_anon;

-- Grant to authenticated (full CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON mek_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mek_request_equipment TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mek_request_equipment_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE mek_requests_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE mek_request_equipment_id_seq TO authenticated;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-generate display_name as "Borrower Name - YYYY-MM-DD"
CREATE OR REPLACE FUNCTION public.mek_request_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.borrower_id IS DISTINCT FROM NEW.borrower_id THEN
        NEW.display_name := COALESCE(
            (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
            'Event Kit Request'
        ) || ' - ' || TO_CHAR(COALESCE(NEW.created_at, NOW()), 'YYYY-MM-DD');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_mek_request_display_name
    BEFORE INSERT OR UPDATE ON public.mek_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.mek_request_display_name();

-- MEK status change notification trigger (function defined in 09_neh_notifications.sql)
CREATE OR REPLACE TRIGGER trg_mek_request_status_change
    AFTER UPDATE OF status_id ON public.mek_requests
    FOR EACH ROW
    WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
    EXECUTE FUNCTION public.notify_mek_request_status_change();

-- ============================================================================
-- RPCs
-- ============================================================================

-- Precondition: block form start if current user's borrower isn't approved
-- Same logic as check_borrower_approved() but with MEK-specific messaging
CREATE OR REPLACE FUNCTION public.check_borrower_approved_mek(p_guided_form_key NAME)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
    v_borrower_id BIGINT;
    v_status_key TEXT;
BEGIN
    -- Staff and admin bypass: they create requests on behalf of borrowers
    IF 'neh_staff' = ANY(get_user_roles()) OR 'neh_admin' = ANY(get_user_roles()) OR is_admin() THEN
        RETURN jsonb_build_object('success', true);
    END IF;

    SELECT b.id INTO v_borrower_id
    FROM borrowers b WHERE b.user_id = current_user_id();

    IF v_borrower_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You must have a borrower account to request event kit equipment. Please contact NEH staff.'
        );
    END IF;

    SELECT s.status_key INTO v_status_key
    FROM borrowers b
    JOIN metadata.statuses s ON b.status_id = s.id
    WHERE b.id = v_borrower_id;

    IF v_status_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Your borrower account must be approved before you can request event kit equipment. Current status: ' || COALESCE(v_status_key, 'pending')
        );
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.check_borrower_approved_mek(NAME) IS
    'Precondition RPC for mek_request guided form. Blocks start if borrower is not approved.';

GRANT EXECUTE ON FUNCTION public.check_borrower_approved_mek(NAME) TO authenticated;

-- On-submit: set status to Pending and record submission timestamp
CREATE OR REPLACE FUNCTION public.submit_mek_request(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_pending_status_id INT;
BEGIN
    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'pending';

    UPDATE public.mek_requests
       SET status_id = v_pending_status_id,
           submitted_at = NOW(),
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Event Kit Request') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your event kit request has been submitted for review.',
        'navigate_to', '/view/mek_requests/' || p_parent_id
    );
END;
$$;

COMMENT ON FUNCTION public.submit_mek_request(BIGINT) IS
    'On-submit RPC for mek_request guided form. Sets status to Pending and appends Submitted to display_name.';

GRANT EXECUTE ON FUNCTION public.submit_mek_request(BIGINT) TO authenticated;

-- Options RPC: returns tool_types that belong to the event_kit inventory module
CREATE OR REPLACE FUNCTION public.get_available_mek_items(p_id TEXT DEFAULT NULL, p_depends_on JSONB DEFAULT '{}')
RETURNS TABLE (id INT, display_name TEXT)
LANGUAGE SQL STABLE AS $$
    SELECT tt.id, tt.display_name::TEXT
    FROM tool_types tt
    JOIN metadata.categories c ON tt.inventory_module_id = c.id
    WHERE c.entity_type = 'inventory_module' AND c.category_key = 'event_kit'
    ORDER BY tt.display_name;
$$;

COMMENT ON FUNCTION public.get_available_mek_items(TEXT, JSONB) IS
    'Options RPC for MEK equipment selection. Returns tool_types in the event_kit inventory module.';

GRANT EXECUTE ON FUNCTION public.get_available_mek_items(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_available_mek_items(TEXT, JSONB) TO web_anon;

-- ============================================================================
-- DENY ACTION BUTTON
-- ============================================================================

CREATE OR REPLACE FUNCTION public.deny_mek_request(p_entity_id BIGINT, p_decision_notes TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, metadata, pg_catalog
AS $$
DECLARE
    v_current_status TEXT;
    v_denied_status_id INT;
BEGIN
    -- Verify current status is pending
    SELECT s.status_key INTO v_current_status
    FROM public.mek_requests r
    JOIN metadata.statuses s ON r.status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_status IS DISTINCT FROM 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Only pending requests can be denied. Current status: ' || COALESCE(v_current_status, 'unknown')
        );
    END IF;

    -- Check permissions
    IF NOT (
        'neh_staff' = ANY(get_user_roles()) OR
        'neh_admin' = ANY(get_user_roles()) OR
        is_admin()
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You do not have permission to deny event kit requests.'
        );
    END IF;

    SELECT id INTO v_denied_status_id
    FROM metadata.statuses
    WHERE entity_type = 'mek_requests' AND status_key = 'denied';

    UPDATE public.mek_requests
    SET status_id = v_denied_status_id,
        decision_notes = p_decision_notes
    WHERE id = p_entity_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Event kit request has been denied.'
    );
END;
$$;

COMMENT ON FUNCTION public.deny_mek_request(BIGINT, TEXT) IS
    'Deny a pending MEK request with decision notes.';

GRANT EXECUTE ON FUNCTION public.deny_mek_request(BIGINT, TEXT) TO authenticated;

-- Register deny action button
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description, rpc_function,
  icon, button_style, sort_order,
  requires_confirmation, confirmation_message,
  visibility_condition, enabled_condition, disabled_tooltip,
  refresh_after_action, show_on_detail
) VALUES (
  'mek_requests',
  'deny_request',
  'Deny Request',
  'Deny this event kit request',
  'deny_mek_request',
  'block',
  'error',
  10,
  TRUE,
  'Are you sure you want to deny this event kit request?',
  (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
   FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'pending'),
  (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id)
   FROM metadata.statuses WHERE entity_type = 'mek_requests' AND status_key = 'pending'),
  'Only pending requests can be denied',
  TRUE,
  TRUE
)
ON CONFLICT (table_name, action_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  rpc_function = EXCLUDED.rpc_function,
  icon = EXCLUDED.icon,
  button_style = EXCLUDED.button_style,
  sort_order = EXCLUDED.sort_order,
  requires_confirmation = EXCLUDED.requires_confirmation,
  confirmation_message = EXCLUDED.confirmation_message,
  visibility_condition = EXCLUDED.visibility_condition,
  enabled_condition = EXCLUDED.enabled_condition,
  disabled_tooltip = EXCLUDED.disabled_tooltip,
  refresh_after_action = EXCLUDED.refresh_after_action,
  show_on_detail = EXCLUDED.show_on_detail;

-- Register action parameter: decision_notes (required text field)
INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder
)
SELECT ea.id, 'p_decision_notes', 'Reason for Denial', 'text', TRUE, 10, 'Enter reason for denial...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'mek_requests' AND ea.action_name = 'deny_request'
ON CONFLICT DO NOTHING;

-- Grant deny action to staff and admin roles
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'mek_requests'
  AND ea.action_name = 'deny_request'
  AND r.role_key IN ('neh_staff', 'neh_admin', 'admin')
ON CONFLICT (entity_action_id, role_id) DO NOTHING;

-- ============================================================================
-- ENTITY METADATA
-- ============================================================================

-- Parent entity: mek_requests
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('mek_requests', 'Event Kit Requests', 'Mobile Event Kit requests for community events', 11, true)
ON CONFLICT (table_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      show_in_sidebar = EXCLUDED.show_in_sidebar;

-- Step entity: mek_request_equipment (hidden from sidebar)
INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar)
VALUES ('mek_request_equipment', 'Equipment Selection', false)
ON CONFLICT (table_name) DO UPDATE SET show_in_sidebar = false;

-- Rich junction entity: mek_request_equipment_items (has quantity extra column)
INSERT INTO metadata.entities (table_name, display_name, is_rich_junction, show_in_sidebar)
VALUES ('mek_request_equipment_items', 'Equipment Items', true, false)
ON CONFLICT (table_name) DO UPDATE SET is_rich_junction = true, show_in_sidebar = false;

-- ============================================================================
-- PROPERTY METADATA - mek_requests (parent)
-- ============================================================================

-- Hide timestamps, auto-generated, and framework-managed fields
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES
  ('mek_requests', 'display_name',              NULL,                  NULL, NULL, true,  false, false, false),
  ('mek_requests', 'decision_notes',            'Decision Notes',      -10,  2,    false, true,  false, false),
  ('mek_requests', 'submitted_at',              NULL,                  NULL, NULL, false, false, false, false),
  ('mek_requests', 'created_by',                NULL,                  NULL, NULL, false, false, false, false),
  ('mek_requests', 'created_at',                NULL,                  NULL, NULL, false, false, false, false),
  ('mek_requests', 'updated_at',                NULL,                  NULL, NULL, false, false, false, false),
  ('mek_requests', 'organization_name',         'Organization Name',   10,   2,    false, true,  true,  true),
  ('mek_requests', 'event_type',                'Event Type',          15,   1,    true,  true,  true,  true),  -- category_entity_type set below
  ('mek_requests', 'event_location',            'Event Location',      16,   2,    false, true,  true,  true),
  ('mek_requests', 'event_dates',               'Event Date(s)',       20,   2,    false, true,  true,  true),
  ('mek_requests', 'pickup_date',               'Pickup Date',         21,   1,    true,  true,  true,  true),
  ('mek_requests', 'return_date',               'Return Date',         22,   1,    true,  true,  true,  true),
  ('mek_requests', 'responsibility_acknowledged','I Accept Responsibility', 30, 2, false, true,  true,  false),
  ('mek_requests', 'notes',                     'Notes',               35,   2,    false, true,  true,  true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      sort_order = EXCLUDED.sort_order,
      column_width = EXCLUDED.column_width,
      show_on_list = EXCLUDED.show_on_list,
      show_on_detail = EXCLUDED.show_on_detail,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- Configure status_id as Status property
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES ('mek_requests', 'status_id', 'Status', 'mek_requests', 1, true, false, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      status_entity_type = EXCLUDED.status_entity_type,
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- Configure event_type as Category property
INSERT INTO metadata.properties (table_name, column_name, display_name, category_entity_type)
VALUES ('mek_requests', 'event_type', 'Event Type', 'mek_event_type')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      category_entity_type = EXCLUDED.category_entity_type;

-- Configure borrower_id FK with search modal and role-aware options RPC
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, join_table, options_source_rpc, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES ('mek_requests', 'borrower_id', true, 'borrowers', 'get_borrowers_for_reservation', 5, true, true, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true,
      join_table = 'borrowers',
      options_source_rpc = 'get_borrowers_for_reservation',
      sort_order = EXCLUDED.sort_order,
      show_on_list = EXCLUDED.show_on_list,
      show_on_create = EXCLUDED.show_on_create,
      show_on_edit = EXCLUDED.show_on_edit;

-- ============================================================================
-- PROPERTY METADATA - mek_request_equipment (step entity)
-- ============================================================================

-- Hide FK and timestamps (framework-managed, not user-facing)
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('mek_request_equipment', 'mek_request_id', false, false, false, false),
  ('mek_request_equipment', 'created_at',     false, false, false, false),
  ('mek_request_equipment', 'updated_at',     false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

-- ============================================================================
-- PROPERTY METADATA - mek_request_equipment_items (rich junction)
-- ============================================================================

-- Configure quantity column display
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order)
VALUES ('mek_request_equipment_items', 'quantity', 'Quantity', 2)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = 'Quantity', sort_order = 2;

-- Hide timestamps on junction table
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES ('mek_request_equipment_items', 'created_at', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET show_on_list = false, show_on_create = false, show_on_edit = false, show_on_detail = false;

-- ============================================================================
-- M:M SEARCH MODAL + INLINE POSITIONING
-- ============================================================================

-- Enable search modal, inline positioning, and event_kit options RPC on equipment M:M
INSERT INTO metadata.properties (table_name, column_name, fk_search_modal, show_inline, options_source_rpc)
VALUES ('mek_request_equipment', 'mek_request_equipment_items_m2m', true, true, 'get_available_mek_items')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET fk_search_modal = true, show_inline = true, options_source_rpc = 'get_available_mek_items';

-- ============================================================================
-- GUIDED FORM REGISTRATION
-- ============================================================================

-- Unregister existing guided form first to allow parameter changes on re-runs
DELETE FROM metadata.guided_form_progress WHERE guided_form_key = 'mek_request';
DELETE FROM metadata.guided_form_step_conditions WHERE guided_form_step_id IN (
    SELECT id FROM metadata.guided_form_steps WHERE guided_form_key = 'mek_request'
);
DELETE FROM metadata.guided_form_steps WHERE guided_form_key = 'mek_request';
-- Clear guided_form_key from entities first (FK constraint)
UPDATE metadata.entities SET guided_form_key = NULL WHERE guided_form_key = 'mek_request';
DELETE FROM metadata.guided_forms WHERE guided_form_key = 'mek_request';

-- Remove stale triggers (will be recreated by register_guided_form)
DROP TRIGGER IF EXISTS trg_block_submitted_update ON public.mek_requests;
DROP TRIGGER IF EXISTS trg_guided_form_lock ON public.mek_requests;

DO $$DECLARE v_result JSONB; BEGIN
    v_result := public.register_guided_form(
        'mek_request'::name,
        'mek_requests'::name,
        'Request Mobile Event Kit equipment for your community event.'::text,
        'submit_mek_request'::name,           -- on_submit_rpc
        'Event Information'::varchar,
        'Request Mobile Event Kit equipment for your community event.'::text,
        TRUE,                                  -- lock_on_submit
        'check_borrower_approved_mek'::name    -- precondition_rpc
    );
    IF NOT (v_result->>'success')::boolean THEN
        RAISE EXCEPTION 'register_guided_form failed: %', v_result->>'message';
    END IF;
END $$;

-- ============================================================================
-- GUIDED FORM STEPS
-- ============================================================================

-- Step 1: Equipment selection (required - must pick at least one item)
SELECT public.add_guided_form_step(
    'mek_request'::name,
    'equipment'::name,
    'Select Equipment'::varchar,
    1,
    'mek_request_equipment'::name,
    'mek_request_id'::name,
    'Choose the equipment items and quantities you need.'::text,
    FALSE   -- can_skip = FALSE
);

-- ============================================================================
-- GUIDED FORM PERMISSIONS
-- ============================================================================

-- Admin: full access to all operations
SELECT public.grant_guided_form_permissions('mek_request', (SELECT id FROM metadata.roles WHERE role_key = 'admin'), ARRAY['read', 'create', 'update', 'delete']);
-- NEH Admin: full access
SELECT public.grant_guided_form_permissions('mek_request', (SELECT id FROM metadata.roles WHERE role_key = 'neh_admin'), ARRAY['read', 'create', 'update', 'delete']);
-- NEH Staff: full access
SELECT public.grant_guided_form_permissions('mek_request', (SELECT id FROM metadata.roles WHERE role_key = 'neh_staff'), ARRAY['read', 'create', 'update', 'delete']);
-- NEH Borrower: create (start guided form); sees/edits own records via ownership RLS
SELECT public.grant_guided_form_permissions('mek_request', (SELECT id FROM metadata.roles WHERE role_key = 'neh_borrower'), ARRAY['create']);

-- ============================================================================
-- VALIDATIONS
-- ============================================================================

-- Clear existing validations for idempotent re-runs
DELETE FROM metadata.validations WHERE table_name IN ('mek_requests', 'mek_request_equipment', 'mek_request_equipment_items');

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('mek_requests', 'pickup_date',               'required', NULL, 'Pickup date is required',                              1),
  ('mek_requests', 'return_date',               'required', NULL, 'Return date is required',                              2),
  ('mek_requests', 'responsibility_acknowledged','required', NULL, 'You must acknowledge responsibility for the equipment', 3);

-- Rebuild CHECK constraints from validations
SELECT metadata.rebuild_guided_form_constraints('mek_requests');

-- Human-readable error messages for constraints not covered by workflow validations
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('mek_return_after_pickup', 'mek_requests', 'return_date',
   'Return date must be on or after the pickup date'),
  ('mek_request_equipment_items_pkey', 'mek_request_equipment_items', 'tool_type_id',
   'This equipment item has already been added')
ON CONFLICT (constraint_name) DO UPDATE
  SET error_message = EXCLUDED.error_message;

-- ============================================================================
-- RBAC PERMISSIONS
-- ============================================================================

-- Register RBAC permissions for MEK tables (mirrors tool_reservation pattern)
DO $$
DECLARE
  tables TEXT[] := ARRAY['mek_requests', 'mek_request_equipment', 'mek_request_equipment_items'];
  perms TEXT[] := ARRAY['read', 'create', 'update', 'delete'];
  t TEXT;
  p TEXT;
  v_admin_id INT;
  v_neh_admin_id INT;
  v_staff_id INT;
  v_borrower_id INT;
  v_editor_id INT;
  v_perm_id INT;
BEGIN
  SELECT id INTO v_admin_id FROM metadata.roles WHERE role_key = 'admin';
  SELECT id INTO v_neh_admin_id FROM metadata.roles WHERE role_key = 'neh_admin';
  SELECT id INTO v_staff_id FROM metadata.roles WHERE role_key = 'neh_staff';
  SELECT id INTO v_borrower_id FROM metadata.roles WHERE role_key = 'neh_borrower';
  SELECT id INTO v_editor_id FROM metadata.roles WHERE role_key = 'editor';

  FOREACH t IN ARRAY tables LOOP
    FOREACH p IN ARRAY perms LOOP
      INSERT INTO metadata.permissions (table_name, permission)
      VALUES (t, p::metadata.permission)
      ON CONFLICT (table_name, permission) DO NOTHING
      RETURNING id INTO v_perm_id;
      IF v_perm_id IS NULL THEN
        SELECT id INTO v_perm_id FROM metadata.permissions WHERE table_name = t AND permission = p::metadata.permission;
      END IF;

      -- Admin always gets all permissions
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_admin_id) ON CONFLICT (permission_id, role_id) DO NOTHING;
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_editor_id) ON CONFLICT (permission_id, role_id) DO NOTHING;

      -- NEH Admin gets all permissions
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_neh_admin_id) ON CONFLICT (permission_id, role_id) DO NOTHING;

      -- NEH Staff gets all permissions
      INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_staff_id) ON CONFLICT (permission_id, role_id) DO NOTHING;

      -- NEH Borrower: limited permissions
      IF t = 'mek_requests' AND p IN ('read', 'create', 'update') THEN
        -- Borrowers can create/read/update their own requests
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT (permission_id, role_id) DO NOTHING;
      ELSIF t IN ('mek_request_equipment', 'mek_request_equipment_items') AND p IN ('read', 'create', 'update', 'delete') THEN
        -- Borrowers can manage guided form step data (full CRUD for M:M editing)
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT (permission_id, role_id) DO NOTHING;
      ELSIF p = 'read' THEN
        -- Borrowers can read reference data
        INSERT INTO metadata.permission_roles (permission_id, role_id) VALUES (v_perm_id, v_borrower_id) ON CONFLICT (permission_id, role_id) DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- FINAL
-- ============================================================================

NOTIFY pgrst, 'reload schema';
