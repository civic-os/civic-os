-- Neighborhood Engagement Hub - Notification Templates & Triggers
-- Follows the community-center notification pattern:
--   1. Helper function to resolve role → user_ids
--   2. Templates with correct column names (name, subject_template, html/text/sms_template)
--   3. Trigger functions that INSERT into metadata.notifications with user_id

-- ============================================================================
-- HELPER: get_users_with_role (same pattern as community-center)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_neh_users_with_role(p_role_name TEXT)
RETURNS TABLE (user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT u.id
  FROM metadata.civic_os_users u
  INNER JOIN metadata.user_roles ur ON ur.user_id = u.id
  INNER JOIN metadata.roles r ON r.id = ur.role_id
  WHERE r.role_key = p_role_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_neh_users_with_role(TEXT) TO authenticated;

-- ============================================================================
-- NOTIFICATION TEMPLATES
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template, sms_template
) VALUES
  -- Tool reservation submitted (staff notification)
  ('tool_reservation_submitted',
   'Sent to staff when a new tool reservation is submitted',
   'New Tool Reservation Request',
   '<p>A new tool reservation has been submitted by <strong>{{.Entity.borrower_display_name}}</strong> for <strong>{{.Entity.tools_summary}}</strong> on {{formatTimeSlot .Entity.timeslot}}.</p><p><a href="{{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}">View Request</a></p>',
   'A new tool reservation has been submitted by {{.Entity.borrower_display_name}} for {{.Entity.tools_summary}} on {{formatTimeSlot .Entity.timeslot}}.',
   NULL),

  -- Tool reservation approved (borrower notification)
  ('tool_reservation_approved',
   'Sent to borrower when their tool reservation is approved',
   'Tool Reservation Approved',
   '<p>Your tool reservation for <strong>{{.Entity.tools_summary}}</strong> on {{formatTimeSlot .Entity.timeslot}} has been approved.</p><p><a href="{{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}">View Reservation</a></p>',
   'Your tool reservation for {{.Entity.tools_summary}} on {{formatTimeSlot .Entity.timeslot}} has been approved.',
   'Your tool reservation for {{.Entity.tools_summary}} has been approved.'),

  -- Tool reservation denied (borrower notification)
  ('tool_reservation_denied',
   'Sent to borrower when their tool reservation is denied',
   'Tool Reservation Denied',
   '<p>Your tool reservation for <strong>{{.Entity.tools_summary}}</strong> on {{formatTimeSlot .Entity.timeslot}} has been denied.</p>',
   'Your tool reservation for {{.Entity.tools_summary}} on {{formatTimeSlot .Entity.timeslot}} has been denied.',
   'Your tool reservation for {{.Entity.tools_summary}} has been denied.'),

  -- Tool checked out (borrower notification)
  ('tool_reservation_checked_out',
   'Sent to borrower when their tool is checked out',
   'Tool Checked Out',
   '<p>Your tool <strong>{{.Entity.tools_summary}}</strong> has been checked out for your reservation on {{formatTimeSlot .Entity.timeslot}}.</p>',
   'Your tool {{.Entity.tools_summary}} has been checked out for your reservation on {{formatTimeSlot .Entity.timeslot}}.',
   'Your tool {{.Entity.tools_summary}} has been checked out.'),

  -- Tool returned (borrower notification)
  ('tool_reservation_returned',
   'Sent to borrower when their tool is returned',
   'Tool Returned',
   '<p>Thank you for returning <strong>{{.Entity.tools_summary}}</strong> from your reservation on {{formatTimeSlot .Entity.timeslot}}.</p>',
   'Thank you for returning {{.Entity.tools_summary}} from your reservation on {{formatTimeSlot .Entity.timeslot}}.',
   NULL),

  -- Building use request submitted (staff notification)
  ('building_use_request_submitted',
   'Sent to staff when a new building use request is submitted',
   'New Building Use Request',
   '<p>A new building use request has been submitted by <strong>{{.Entity.contact_name}}</strong> for <strong>{{.Entity.group_name}}</strong>.</p><p><a href="{{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}">View Request</a></p>',
   'A new building use request has been submitted by {{.Entity.contact_name}} for {{.Entity.group_name}}.',
   NULL),

  -- Building use request approved (requester notification)
  ('building_use_request_approved',
   'Sent to requester when their building use request is approved',
   'Building Use Request Approved',
   '<p>Your building use request for <strong>{{.Entity.group_name}}</strong> has been approved.</p><p><a href="{{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}">View Request</a></p>',
   'Your building use request for {{.Entity.group_name}} has been approved.',
   'Your building use request for {{.Entity.group_name}} has been approved.'),

  -- Building use request denied (requester notification)
  ('building_use_request_denied',
   'Sent to requester when their building use request is denied',
   'Building Use Request Denied',
   '<p>Your building use request for <strong>{{.Entity.group_name}}</strong> has been denied.</p>',
   'Your building use request for {{.Entity.group_name}} has been denied.',
   'Your building use request for {{.Entity.group_name}} has been denied.'),

  -- Borrower approved
  ('borrower_approved',
   'Sent to borrower when their account is approved',
   'Borrower Account Approved',
   '<p>Your borrower account has been approved! You can now reserve tools from the Neighborhood Engagement Hub.</p><p><a href="{{.Metadata.site_url}}/guided-form/tool_reservation">Reserve Tools</a></p>',
   'Your borrower account has been approved! You can now reserve tools from the Neighborhood Engagement Hub.',
   'Your NEH borrower account has been approved. You can now reserve tools.'),

  -- Borrower rejected
  ('borrower_rejected',
   'Sent to borrower when their account is rejected',
   'Borrower Account Not Approved',
   '<p>Your borrower account application has not been approved. Please contact NEH staff for more information.</p>',
   'Your borrower account application has not been approved. Please contact NEH staff for more information.',
   'Your NEH borrower account was not approved. Contact staff for details.'),

  -- Borrower barred
  ('borrower_barred',
   'Sent to borrower when their account is barred',
   'Borrower Account Suspended',
   '<p>Your borrower account has been suspended. Please contact NEH staff for more information.</p>',
   'Your borrower account has been suspended. Please contact NEH staff for more information.',
   'Your NEH borrower account has been suspended. Contact staff for details.')

ON CONFLICT (name) DO UPDATE
  SET subject_template = EXCLUDED.subject_template,
      html_template = EXCLUDED.html_template,
      text_template = EXCLUDED.text_template,
      sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- TRIGGER FUNCTIONS
-- ============================================================================

-- Notify on tool reservation status change (staff for 'pending', borrower for others)
CREATE OR REPLACE FUNCTION public.notify_tool_reservation_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
  v_status_key TEXT;
  v_template_name TEXT;
  v_borrower_user_id UUID;
  v_entity_data JSONB;
  v_staff RECORD;
BEGIN
  SELECT status_key INTO v_status_key
  FROM metadata.statuses WHERE id = NEW.status_id;

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

-- Notify on building use request status change
-- Handles both staff notification (pending) and requester notification (approved/denied)
CREATE OR REPLACE FUNCTION public.notify_building_use_request_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
  v_status_key TEXT;
  v_template_name TEXT;
  v_entity_data JSONB;
  v_staff RECORD;
BEGIN
  SELECT status_key INTO v_status_key
  FROM metadata.statuses WHERE id = NEW.status_id;

  v_entity_data := jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW.display_name,
    'group_name', NEW.group_name,
    'contact_name', NEW.contact_name
  );

  -- 'pending' = submission → notify staff
  IF v_status_key = 'pending' THEN
    FOR v_staff IN SELECT user_id FROM get_neh_users_with_role('neh_staff')
                   UNION
                   SELECT user_id FROM get_neh_users_with_role('neh_admin')
    LOOP
      INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
      VALUES (v_staff.user_id, 'building_use_request_submitted', 'building_use_requests', NEW.id::text, v_entity_data);
    END LOOP;
    RETURN NEW;
  END IF;

  -- Other statuses → notify requester
  CASE v_status_key
    WHEN 'approved' THEN v_template_name := 'building_use_request_approved';
    WHEN 'denied' THEN v_template_name := 'building_use_request_denied';
    ELSE v_template_name := NULL;
  END CASE;

  IF v_template_name IS NOT NULL AND NEW.created_by IS NOT NULL THEN
    INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
    VALUES (NEW.created_by, v_template_name, 'building_use_requests', NEW.id::text, v_entity_data);
  END IF;

  RETURN NEW;
END;
$$;

-- Notify borrower on borrower status change (approved, rejected, barred)
CREATE OR REPLACE FUNCTION public.notify_borrower_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, pg_temp
AS $$
DECLARE
  v_status_key TEXT;
  v_template_name TEXT;
  v_entity_data JSONB;
BEGIN
  SELECT status_key INTO v_status_key
  FROM metadata.statuses WHERE id = NEW.status_id;

  CASE v_status_key
    WHEN 'approved' THEN v_template_name := 'borrower_approved';
    WHEN 'rejected' THEN v_template_name := 'borrower_rejected';
    WHEN 'barred' THEN v_template_name := 'borrower_barred';
    ELSE v_template_name := NULL;
  END CASE;

  IF v_template_name IS NOT NULL AND NEW.user_id IS NOT NULL THEN
    v_entity_data := jsonb_build_object(
      'id', NEW.id,
      'display_name', NEW.display_name
    );

    INSERT INTO metadata.notifications (user_id, template_name, entity_type, entity_id, entity_data)
    VALUES (NEW.user_id, v_template_name, 'borrowers', NEW.id::text, v_entity_data);
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- No INSERT trigger for tool_reservations — drafts should not notify.
-- Submission fires via status_change 'pending' case in the UPDATE trigger.
DROP TRIGGER IF EXISTS trg_notify_tool_reservation_insert ON public.tool_reservations;

DROP TRIGGER IF EXISTS trg_notify_tool_reservation_update ON public.tool_reservations;
CREATE TRIGGER trg_notify_tool_reservation_update
  AFTER UPDATE OF status_id ON public.tool_reservations
  FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
  EXECUTE FUNCTION public.notify_tool_reservation_status_change();

-- No INSERT trigger for building_use_requests — drafts should not notify.
-- Submission fires via on_submit_rpc setting status to 'pending', which fires the status_change trigger.
DROP TRIGGER IF EXISTS trg_notify_building_use_request_insert ON public.building_use_requests;

DROP TRIGGER IF EXISTS trg_notify_building_use_request_update ON public.building_use_requests;
CREATE TRIGGER trg_notify_building_use_request_update
  AFTER UPDATE OF status_id ON public.building_use_requests
  FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
  EXECUTE FUNCTION public.notify_building_use_request_status_change();

-- Borrower status change notifications
DROP TRIGGER IF EXISTS trg_notify_borrower_status_change ON public.borrowers;
CREATE TRIGGER trg_notify_borrower_status_change
  AFTER UPDATE OF status_id ON public.borrowers
  FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
  EXECUTE FUNCTION public.notify_borrower_status_change();
