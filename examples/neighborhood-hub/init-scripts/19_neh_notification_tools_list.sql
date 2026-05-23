-- Neighborhood Engagement Hub - Notification Enhancement: Tools List in Approved Email
-- Enhances the tool_reservation_approved notification to show each tool individually
-- using Go template {{range}} loop instead of just the summary string.
--
-- Context: tool_reservations has two status columns:
--   status_id           = "Form Status" (guided form lifecycle: draft/submitted)
--   workflow_status_id  = "Status" (business rules: pending/approved/denied/checked_out/returned)
-- The notification trigger fires on workflow_status_id (the business status).
--
-- Changes:
-- 1. Update trigger function to include 'tools' array in entity_data
-- 2. Update template to loop over tools in HTML/text body
BEGIN;

-- ============================================================================
-- 1. Update trigger to include tools array in entity_data
-- ============================================================================

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
  FROM metadata.statuses WHERE id = NEW.workflow_status_id;

  -- Build entity snapshot with both tools_summary (string) and tools (array)
  -- The tools array enables {{range}} loops in Go templates
  v_entity_data := jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW.display_name,
    'timeslot', NEW.timeslot::text,
    'borrower_display_name', (SELECT display_name FROM borrowers WHERE id = NEW.borrower_id),
    'tools_summary', public.tools_summary(NEW),
    'tools', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('name', tt.display_name) ORDER BY tt.display_name)
       FROM tool_reservation_tool_items trti
       JOIN tool_reservation_tools trt ON trt.id = trti.tool_reservation_tools_id
       JOIN tool_types tt ON tt.id = trti.tool_type_id
       WHERE trt.tool_reservation_id = NEW.id),
      '[]'::jsonb
    )
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

-- ============================================================================
-- 2. Recreate trigger on workflow_status_id (business status)
--    The original trigger was correct; re-creating here to ensure consistency
--    with the updated function above.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_notify_tool_reservation_update ON public.tool_reservations;
CREATE TRIGGER trg_notify_tool_reservation_update
  AFTER UPDATE OF workflow_status_id ON public.tool_reservations
  FOR EACH ROW WHEN (OLD.workflow_status_id IS DISTINCT FROM NEW.workflow_status_id)
  EXECUTE FUNCTION public.notify_tool_reservation_status_change();

-- ============================================================================
-- 3. Update approved template to use {{range}} loop for tools
-- ============================================================================

UPDATE metadata.notification_templates
SET html_template = '<p>Your tool reservation on {{formatTimeSlot .Entity.timeslot}} has been approved!</p><p><strong>Tools reserved:</strong></p><ul>{{range .Entity.tools}}<li>{{.name}}</li>{{end}}</ul><p><a href="{{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}">View Reservation</a></p>',
    text_template = 'Your tool reservation on {{formatTimeSlot .Entity.timeslot}} has been approved.

Tools reserved:
{{range .Entity.tools}}- {{.name}}
{{end}}
View your reservation: {{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}'
WHERE name = 'tool_reservation_approved';

-- ============================================================================
-- Schema Decision (ADR)
-- ============================================================================

INSERT INTO metadata.schema_decisions (
    entity_types, migration_id,
    title, status, context, decision, rationale, consequences, decided_date
)
SELECT
    ARRAY['tool_reservations']::NAME[],
    '19_neh_notification_tools_list',
    'Notification entity_data includes structured arrays for Go template range loops',
    'accepted',
    'The approved notification previously showed tools_summary as a comma-separated string. User requested individual tool listing in the email body for clarity.',
    'The notify_tool_reservation_status_change trigger now includes a tools JSON array in entity_data alongside the existing tools_summary string. The tool_reservation_approved template uses Go {{range .Entity.tools}} to render each tool as a list item. The trigger fires on workflow_status_id (business status), not status_id (form status).',
    'Including both tools_summary (backwards-compatible string) and tools (structured array) lets simple templates use the string while rich templates iterate. The Go template engine natively supports {{range}} over JSON arrays unmarshaled from entity_data JSONB.',
    'entity_data payload is slightly larger (array vs string). Other notification templates (submitted, denied, checked_out, returned) also receive the tools array and could adopt {{range}} in the future without trigger changes.',
    CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM metadata.schema_decisions WHERE migration_id = '19_neh_notification_tools_list');

COMMIT;
