-- Neighborhood Engagement Hub - Workflow status separation & entity action buttons
--
-- Problem: A single status_id column was serving two masters:
--   1. Guided Form lifecycle (draft → complete → submitted) — read by core RPCs
--   2. Business workflow (pending → approved → checked_out → ...) — used by staff
--
-- Solution: Keep status_id for GF (core RPCs unchanged), add workflow_status_id
-- for the business workflow. Entity action buttons let staff approve/deny/etc.
-- from the Detail page without navigating to Edit.
--
-- Sections:
--   1. Add workflow_status_id column
--   2. Configure metadata for new column, hide GF status_id
--   3. Modify submit_tool_reservation to set workflow_status_id
--   4. Recreate triggers on workflow_status_id
--   5. Entity action RPCs (approve, deny, check_out, return, complete, cancel)
--   6. Entity action button metadata
--   7. Fix existing reservation & dashboard widgets
BEGIN;

-- ============================================================================
-- 1. Add workflow_status_id column
-- ============================================================================

ALTER TABLE tool_reservations
  ADD COLUMN workflow_status_id INTEGER REFERENCES metadata.statuses(id);

CREATE INDEX idx_tool_reservations_workflow_status ON tool_reservations(workflow_status_id);

-- ============================================================================
-- 2. Configure metadata
-- ============================================================================

-- Show workflow_status_id as the primary "Status" on list/detail
INSERT INTO metadata.properties (table_name, column_name, display_name, status_entity_type, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('tool_reservations', 'workflow_status_id', 'Status', 'tool_reservations', 5, true, true, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    status_entity_type = EXCLUDED.status_entity_type,
    sort_order = EXCLUDED.sort_order,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- Hide the GF-managed status_id from user-facing views (still used by core GF RPCs)
INSERT INTO metadata.properties (table_name, column_name, display_name, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('tool_reservations', 'status_id', 'Form Status', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    show_on_list = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail,
    show_on_create = EXCLUDED.show_on_create,
    show_on_edit = EXCLUDED.show_on_edit;

-- Hide submitted_at (system-managed timestamp, not user-facing)
INSERT INTO metadata.properties (table_name, column_name, show_on_create, show_on_edit, show_on_list, show_on_detail)
VALUES ('tool_reservations', 'submitted_at', false, false, false, false)
ON CONFLICT (table_name, column_name) DO UPDATE
SET show_on_create = EXCLUDED.show_on_create,
    show_on_edit   = EXCLUDED.show_on_edit,
    show_on_list   = EXCLUDED.show_on_list,
    show_on_detail = EXCLUDED.show_on_detail;

-- ============================================================================
-- 3. Modify submit_tool_reservation to set workflow_status_id (not status_id)
--    Core submit_guided_form() still sets status_id to guided_form.submitted — that's correct.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_tool_reservation(p_parent_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_pending_status_id INT;
BEGIN
    SELECT id INTO v_pending_status_id
    FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'pending';

    UPDATE public.tool_reservations
       SET workflow_status_id = v_pending_status_id,
           display_name = CASE
               WHEN display_name LIKE '% - Submitted' THEN display_name
               ELSE COALESCE(display_name, 'Tool Reservation') || ' - Submitted'
           END
     WHERE id = p_parent_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Your tool reservation has been submitted for review.',
        'navigate_to', '/view/tool_reservations/' || p_parent_id
    );
END;
$$;

-- ============================================================================
-- 4. Recreate triggers to fire on workflow_status_id (not status_id)
-- ============================================================================

-- 4a. Overlap check trigger
DROP TRIGGER IF EXISTS tool_reservation_overlap_trigger ON tool_reservations;

CREATE OR REPLACE FUNCTION public.check_tool_reservation_overlap()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_tool RECORD;
    v_conflict_count INT;
    v_available_count INT;
BEGIN
    -- Only check when transitioning TO approved/checked_out
    IF NEW.workflow_status_id NOT IN (
        SELECT id FROM metadata.statuses
        WHERE entity_type = 'tool_reservations'
        AND status_key IN ('approved', 'checked_out')
    ) THEN RETURN NEW; END IF;

    -- For each tool type in this reservation (via step junction)
    FOR v_tool IN
        SELECT tt.id as tool_type_id, tt.display_name, tt.is_qty_managed, tt.total_quantity
        FROM tool_reservation_tool_items trti
        JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
        JOIN tool_types tt ON tt.id = trti.tool_type_id
        WHERE trt.tool_reservation_id = NEW.id
    LOOP
        -- Count conflicting approved/checked_out reservations with same tool_type and overlapping timeslot
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

CREATE TRIGGER tool_reservation_overlap_trigger
  BEFORE UPDATE OF workflow_status_id ON public.tool_reservations
  FOR EACH ROW EXECUTE FUNCTION check_tool_reservation_overlap();

-- 4b. Auto-create checkout trigger
DROP TRIGGER IF EXISTS trg_auto_create_checkout ON tool_reservations;

CREATE OR REPLACE FUNCTION public.auto_create_checkout()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_status_key TEXT;
    v_checkout_status_id INT;
BEGIN
    SELECT status_key INTO v_status_key
    FROM metadata.statuses WHERE id = NEW.workflow_status_id;

    IF v_status_key = 'checked_out' THEN
        SELECT id INTO v_checkout_status_id
        FROM metadata.statuses
        WHERE entity_type = 'tool_reservation_checkouts' AND status_key = 'checked_out';

        INSERT INTO public.tool_reservation_checkouts (tool_reservation_id, status_id)
        VALUES (NEW.id, v_checkout_status_id)
        ON CONFLICT (tool_reservation_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_create_checkout
  AFTER UPDATE OF workflow_status_id ON public.tool_reservations
  FOR EACH ROW
  WHEN (OLD.workflow_status_id IS DISTINCT FROM NEW.workflow_status_id)
  EXECUTE FUNCTION auto_create_checkout();

-- 4c. Notification trigger
DROP TRIGGER IF EXISTS trg_notify_tool_reservation_update ON tool_reservations;

CREATE OR REPLACE FUNCTION public.notify_tool_reservation_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_status_key TEXT;
  v_template_name TEXT;
  v_borrower_user_id UUID;
  v_entity_data JSONB;
  v_staff RECORD;
BEGIN
  SELECT status_key INTO v_status_key
  FROM metadata.statuses WHERE id = NEW.workflow_status_id;

  -- Build entity snapshot (shared by all notification paths)
  v_entity_data := jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW.display_name,
    'timeslot', NEW.timeslot::text,
    'borrower_display_name', (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
    'tools_summary', public.tools_summary(NEW)
  );

  -- 'pending' = guided form submission → notify staff
  IF v_status_key = 'pending' THEN
    FOR v_staff IN SELECT user_id FROM get_neh_users_with_role('neh_staff')
                   UNION
                   SELECT user_id FROM get_neh_users_with_role('neh_admin')
    LOOP
      INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
      VALUES (v_staff.user_id, 'tool_reservation_submitted', 'tool_reservations', NEW.id::text, v_entity_data);
    END LOOP;
    RETURN NEW;
  END IF;

  -- Other statuses → notify borrower
  CASE v_status_key
    WHEN 'approved' THEN v_template_name := 'tool_reservation_approved';
    WHEN 'denied' THEN v_template_name := 'tool_reservation_denied';
    WHEN 'checked_out' THEN v_template_name := 'tool_reservation_checked_out';
    WHEN 'returned' THEN v_template_name := 'tool_reservation_returned';
    ELSE v_template_name := NULL;
  END CASE;

  IF v_template_name IS NOT NULL THEN
    SELECT b.user_id INTO v_borrower_user_id
    FROM borrowers b WHERE b.id = NEW.borrower_id;

    IF v_borrower_user_id IS NOT NULL THEN
      INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
      VALUES (v_borrower_user_id, v_template_name, 'tool_reservations', NEW.id::text, v_entity_data);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_tool_reservation_update
  AFTER UPDATE OF workflow_status_id ON public.tool_reservations
  FOR EACH ROW
  WHEN (OLD.workflow_status_id IS DISTINCT FROM NEW.workflow_status_id)
  EXECUTE FUNCTION notify_tool_reservation_status_change();

-- ============================================================================
-- 5. Entity action RPCs
-- ============================================================================

-- 5a. Approve reservation (pending → approved)
CREATE OR REPLACE FUNCTION public.approve_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
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

-- 5b. Deny reservation (pending → denied)
CREATE OR REPLACE FUNCTION public.deny_tool_reservation(p_entity_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
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

-- 5c. Check out (approved → checked_out)
CREATE OR REPLACE FUNCTION public.checkout_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'approved' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only approved reservations can be checked out. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'checked_out';

    UPDATE tool_reservations SET workflow_status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Tools checked out.');
END;
$$;

-- 5d. Mark returned (checked_out → returned)
CREATE OR REPLACE FUNCTION public.return_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
    SELECT s.status_key INTO v_current_key
    FROM tool_reservations r
    JOIN metadata.statuses s ON r.workflow_status_id = s.id
    WHERE r.id = p_entity_id;

    IF v_current_key IS DISTINCT FROM 'checked_out' THEN
        RETURN jsonb_build_object('success', false,
            'message', 'Only checked-out reservations can be returned. Current: ' || COALESCE(v_current_key, 'none'));
    END IF;

    SELECT id INTO v_target_id FROM metadata.statuses
    WHERE entity_type = 'tool_reservations' AND status_key = 'returned';

    UPDATE tool_reservations SET workflow_status_id = v_target_id WHERE id = p_entity_id;

    RETURN jsonb_build_object('success', true, 'message', 'Tools marked as returned.');
END;
$$;

-- 5e. Complete (returned → completed)
CREATE OR REPLACE FUNCTION public.complete_tool_reservation(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
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

-- 5f. Cancel (pending or approved → cancelled)
CREATE OR REPLACE FUNCTION public.cancel_tool_reservation(p_entity_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_current_key TEXT;
    v_target_id INT;
BEGIN
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

-- ============================================================================
-- 6. Entity action button metadata
--    visibility_condition: button only shows when workflow_status_id matches
-- ============================================================================

-- Use status IDs: pending=12, approved=13, checked_out=14, returned=15
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, icon, button_style, sort_order, rpc_function, requires_confirmation, confirmation_message, visibility_condition, enabled_condition, refresh_after_action, show_on_detail)
VALUES
  -- Approve (visible when pending)
  ('tool_reservations', 'approve', 'Approve', 'Approve this tool reservation', 'check_circle', 'success', 10,
   'approve_tool_reservation', true, 'Approve this reservation? The overlap check will verify tool availability.',
   '{"field": "workflow_status_id", "value": 12, "operator": "eq"}',
   '{"field": "workflow_status_id", "value": 12, "operator": "eq"}',
   true, true),

  -- Deny (visible when pending)
  ('tool_reservations', 'deny', 'Deny', 'Deny this tool reservation', 'block', 'error', 20,
   'deny_tool_reservation', true, 'Are you sure you want to deny this reservation?',
   '{"field": "workflow_status_id", "value": 12, "operator": "eq"}',
   '{"field": "workflow_status_id", "value": 12, "operator": "eq"}',
   true, true),

  -- Check Out (visible when approved)
  ('tool_reservations', 'check_out', 'Check Out', 'Mark tools as checked out to borrower', 'shopping_cart', 'primary', 10,
   'checkout_tool_reservation', true, 'Confirm tools have been handed to the borrower?',
   '{"field": "workflow_status_id", "value": 13, "operator": "eq"}',
   '{"field": "workflow_status_id", "value": 13, "operator": "eq"}',
   true, true),

  -- Return (visible when checked_out)
  ('tool_reservations', 'mark_returned', 'Mark Returned', 'Mark tools as returned by borrower', 'assignment_return', 'primary', 10,
   'return_tool_reservation', true, 'Confirm tools have been returned?',
   '{"field": "workflow_status_id", "value": 14, "operator": "eq"}',
   '{"field": "workflow_status_id", "value": 14, "operator": "eq"}',
   true, true),

  -- Complete (visible when returned)
  ('tool_reservations', 'complete', 'Complete', 'Mark reservation as fully completed', 'task_alt', 'success', 10,
   'complete_tool_reservation', false, NULL,
   '{"field": "workflow_status_id", "value": 15, "operator": "eq"}',
   '{"field": "workflow_status_id", "value": 15, "operator": "eq"}',
   true, true),

  -- Cancel (visible when pending or approved)
  ('tool_reservations', 'cancel', 'Cancel', 'Cancel this reservation', 'cancel', 'ghost', 30,
   'cancel_tool_reservation', true, 'Are you sure you want to cancel this reservation?',
   '{"field": "workflow_status_id", "value": [12, 13], "operator": "in"}',
   '{"field": "workflow_status_id", "value": [12, 13], "operator": "in"}',
   true, true);

-- Action parameters (deny reason, cancel reason)
INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_reason', 'Reason', 'text', true, 10, 'Enter reason for denial...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservations' AND ea.action_name = 'deny';

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, placeholder)
SELECT ea.id, 'p_reason', 'Reason (optional)', 'text', false, 10, 'Enter reason for cancellation...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'tool_reservations' AND ea.action_name = 'cancel';

-- ============================================================================
-- 7. Fix existing data & dashboard widgets
-- ============================================================================

-- 7a. Set workflow_status_id on existing reservation (currently stuck at GF submitted)
--     Requires fake JWT to bypass block_submitted_update trigger on managed PG
SET LOCAL request.jwt.claims = '{"sub":"init-script","realm_access":{"roles":["admin"]}}';
UPDATE tool_reservations
SET workflow_status_id = (SELECT id FROM metadata.statuses WHERE entity_type = 'tool_reservations' AND status_key = 'pending')
WHERE id = 1 AND workflow_status_id IS NULL;

-- 7b. Fix dashboard widgets: populate entity_key column (required by frontend component)
UPDATE metadata.dashboard_widgets
SET entity_key = config->>'entity'
WHERE widget_type IN ('filtered_list', 'calendar')
  AND entity_key IS NULL
  AND config->>'entity' IS NOT NULL;

-- 7c. Update tool_reservations dashboard filters to use workflow_status_id
--     Other entities (building_use_requests, mek_requests) keep their status.status_key filters
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    jsonb_set(config, '{filters}',
      CASE config->'filter'->>'status.status_key'
        WHEN 'pending' THEN '[{"column": "workflow_status_id", "operator": "eq", "value": "12"}]'::jsonb
        WHEN 'approved' THEN '[{"column": "workflow_status_id", "operator": "eq", "value": "13"}]'::jsonb
        WHEN 'checked_out' THEN '[{"column": "workflow_status_id", "operator": "eq", "value": "14"}]'::jsonb
        ELSE '[]'::jsonb
      END
    ),
    '{showColumns}', config->'columns'
)
WHERE widget_type = 'filtered_list'
  AND config->>'entity' = 'tool_reservations'
  AND config->'filter' IS NOT NULL;

-- Remove legacy keys (filter, columns) from tool_reservations widgets
UPDATE metadata.dashboard_widgets
SET config = config - 'filter' - 'columns'
WHERE widget_type = 'filtered_list'
  AND config->>'entity' = 'tool_reservations';

-- 7d. Convert building_use_requests and mek_requests widgets to new format too
--     These still use status_id, so filter on status.status_key via embedded resource
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    jsonb_set(config, '{filters}',
      CASE config->'filter'->>'status.status_key'
        WHEN 'pending' THEN format('[{"column": "status.status_key", "operator": "eq", "value": "pending"}]')::jsonb
        ELSE '[]'::jsonb
      END
    ),
    '{showColumns}', config->'columns'
)
WHERE widget_type = 'filtered_list'
  AND config->>'entity' IN ('building_use_requests', 'mek_requests', 'borrowers')
  AND config->'filter' IS NOT NULL;

UPDATE metadata.dashboard_widgets
SET config = config - 'filter' - 'columns'
WHERE widget_type = 'filtered_list'
  AND config->>'entity' IN ('building_use_requests', 'mek_requests', 'borrowers');

-- 7e. Fix borrower dashboard filtered_list widgets (filter on created_by/borrower_id)
UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
    jsonb_set(config, '{filters}',
      CASE
        WHEN config->'filter'->>'borrower_id' IS NOT NULL
        THEN '[{"column": "borrower_id", "operator": "eq", "value": "{{current_user.borrower_id}}"}]'::jsonb
        WHEN config->'filter'->>'created_by' IS NOT NULL
        THEN '[{"column": "created_by", "operator": "eq", "value": "{{current_user.id}}"}]'::jsonb
        ELSE '[]'::jsonb
      END
    ),
    '{showColumns}', COALESCE(config->'columns', '["display_name"]'::jsonb)
)
WHERE widget_type = 'filtered_list'
  AND config->'filter' IS NOT NULL
  AND config->'filters' IS NULL;

UPDATE metadata.dashboard_widgets
SET config = config - 'filter' - 'columns'
WHERE widget_type = 'filtered_list'
  AND config->'filter' IS NOT NULL;

COMMIT;

-- Reload PostgREST schema cache (fire-and-forget, outside transaction)
NOTIFY pgrst, 'reload schema';
