-- ============================================================================
-- MOTT PARK RECREATION AREA - TIMEZONE-AWARE NOTIFICATION TEMPLATES
-- Part 20: Fix notification date formatting to use Go template functions
-- ============================================================================
--
-- ISSUE: Notification templates were using pre-formatted date strings from SQL
-- (using to_char() with server timezone), bypassing the Go renderer's timezone-
-- aware formatting functions.
--
-- SOLUTION:
-- 1. Pass raw time_slot (tstzrange) to templates
-- 2. Use {{formatTimeSlot .Entity.time_slot}} for timezone-aware formatting
-- 3. Use {{formatDate .Entity.due_date}} for date-only fields
--
-- The Go renderer converts timestamps to the configured TIMEZONE (America/Detroit)
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: UPDATE NOTIFICATION TEMPLATES
-- ============================================================================

-- Payment reminder (7 days before due)
-- Change: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
-- Change: {{.Entity.due_date}} -> {{formatDate .Entity.due_date}}
UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #F59E0B;">⏰ Payment Reminder</h2>
    <p>This is a friendly reminder that your <strong>{{.Entity.payment_type}}</strong> payment of <strong>{{.Entity.amount}}</strong> is due on <strong>{{formatDate .Entity.due_date}}</strong> (7 days from now).</p>
    <h3>Reservation Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Make Payment
      </a>
    </p>
  </div>',
  text_template = 'PAYMENT REMINDER

Your {{.Entity.payment_type}} payment of {{.Entity.amount}} is due on {{formatDate .Entity.due_date}} (7 days from now).

Event: {{.Entity.event_type}}
Date: {{formatTimeSlot .Entity.time_slot}}

Make payment at: {{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}'
WHERE name = 'payment_reminder_7day';

-- Payment due today
-- Change: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #EF4444;">📅 Payment Due Today</h2>
    <p>Your <strong>{{.Entity.payment_type}}</strong> payment of <strong>{{.Entity.amount}}</strong> is due <strong>TODAY</strong>.</p>
    <h3>Reservation Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}"
         style="display: inline-block; background-color: #EF4444; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Pay Now
      </a>
    </p>
    <p style="color: #6b7280; font-size: 12px;">Failure to pay may result in cancellation of your reservation.</p>
  </div>',
  text_template = 'PAYMENT DUE TODAY

Your {{.Entity.payment_type}} payment of {{.Entity.amount}} is due TODAY.

Event: {{.Entity.event_type}}
Date: {{formatTimeSlot .Entity.time_slot}}

Pay now at: {{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}

Failure to pay may result in cancellation of your reservation.'
WHERE name = 'payment_due_today';

-- Payment overdue
-- Change: {{.Entity.due_date}} -> {{formatDate .Entity.due_date}}
-- Change: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #DC2626;">⚠️ Payment Overdue</h2>
    <p>Your <strong>{{.Entity.payment_type}}</strong> payment of <strong>{{.Entity.amount}}</strong> was due on <strong>{{formatDate .Entity.due_date}}</strong> and is now <strong>{{.Entity.days_overdue}} days overdue</strong>.</p>
    <p style="color: #DC2626; font-weight: bold;">Your reservation may be cancelled if payment is not received promptly.</p>
    <h3>Reservation Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}"
         style="display: inline-block; background-color: #DC2626; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Pay Immediately
      </a>
    </p>
    <p style="color: #6b7280; font-size: 12px;">If you have questions, please contact the Mott Park Recreation Association.</p>
  </div>',
  text_template = 'PAYMENT OVERDUE

Your {{.Entity.payment_type}} payment of {{.Entity.amount}} was due on {{formatDate .Entity.due_date}} and is now {{.Entity.days_overdue}} days overdue.

YOUR RESERVATION MAY BE CANCELLED IF PAYMENT IS NOT RECEIVED PROMPTLY.

Event: {{.Entity.event_type}}
Date: {{formatTimeSlot .Entity.time_slot}}

Pay immediately at: {{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}

If you have questions, please contact the Mott Park Recreation Association.'
WHERE name = 'payment_overdue';

-- Manager pre-event reminder (1 day before)
-- Change: {{.Entity.time_slot_display}} -> {{formatTimeSlot .Entity.time_slot}}
UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #2563eb;">📋 Event Tomorrow</h2>
    <p>Reminder: There is a reservation at the clubhouse tomorrow.</p>
    <h3>Event Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Organizer:</strong> {{.Entity.requestor_name}}</p>
    {{if .Entity.organization_name}}<p><strong>Organization:</strong> {{.Entity.organization_name}}</p>{{end}}
    <p><strong>Time:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p><strong>Attendees:</strong> {{.Entity.attendee_count}}</p>
    <p><strong>Food:</strong> {{if .Entity.is_food_served}}Yes{{else}}No{{end}}</p>
    <h3>Pre-Event Checklist</h3>
    <ul>
      <li>☐ Verify all payments received</li>
      <li>☐ Confirm contact info for organizer</li>
      <li>☐ Check facility is clean and ready</li>
      <li>☐ Ensure supplies are stocked (paper towels, etc.)</li>
      <li>☐ Test locks and lights</li>
    </ul>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Reservation
      </a>
    </p>
  </div>',
  text_template = 'EVENT TOMORROW

Reminder: There is a reservation at the clubhouse tomorrow.

Event: {{.Entity.event_type}}
Organizer: {{.Entity.requestor_name}}
{{if .Entity.organization_name}}Organization: {{.Entity.organization_name}}{{end}}
Time: {{formatTimeSlot .Entity.time_slot}}
Attendees: {{.Entity.attendee_count}}
Food: {{if .Entity.is_food_served}}Yes{{else}}No{{end}}

PRE-EVENT CHECKLIST:
[ ] Verify all payments received
[ ] Confirm contact info for organizer
[ ] Check facility is clean and ready
[ ] Ensure supplies are stocked
[ ] Test locks and lights

View reservation: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
WHERE name = 'manager_pre_event_reminder';

-- Manager post-event reminder
-- Change: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #8B5CF6;">✓ Event Completed - Assessment Needed</h2>
    <p>The following event has ended and requires post-event assessment:</p>
    <h3>Event Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Organizer:</strong> {{.Entity.requestor_name}}</p>
    <p><strong>Date:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <h3>Post-Event Checklist</h3>
    <ul>
      <li>☐ Inspect facility for damages</li>
      <li>☐ Verify facility was left clean</li>
      <li>☐ Document any issues with photos</li>
      <li>☐ Determine deposit refund amount</li>
      <li>☐ Process refund or note deductions</li>
      <li>☐ Update status to "Closed"</li>
    </ul>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #8B5CF6; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Complete Assessment
      </a>
    </p>
  </div>',
  text_template = 'EVENT COMPLETED - ASSESSMENT NEEDED

The following event has ended and requires post-event assessment:

Event: {{.Entity.event_type}}
Organizer: {{.Entity.requestor_name}}
Date: {{formatTimeSlot .Entity.time_slot}}

POST-EVENT CHECKLIST:
[ ] Inspect facility for damages
[ ] Verify facility was left clean
[ ] Document any issues with photos
[ ] Determine deposit refund amount
[ ] Process refund or note deductions
[ ] Update status to "Closed"

Complete assessment: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
WHERE name = 'manager_post_event_reminder';

-- ============================================================================
-- SECTION 2: UPDATE SCHEDULED NOTIFICATION FUNCTIONS
-- Pass raw time_slot instead of pre-formatted event_date
-- ============================================================================

-- Function: Send payment reminders (7 days before due)
CREATE OR REPLACE FUNCTION send_payment_reminders_7day()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_payment RECORD;
  v_payment_data JSONB;
  v_count INT := 0;
BEGIN
  -- Find pending payments due in exactly 7 days
  FOR v_payment IN
    SELECT
      rp.id,
      rp.reservation_request_id,
      rp.amount,
      rp.due_date,
      rpt.display_name as payment_type,
      rr.requestor_id,
      rr.event_type,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_payments rp
    JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
    JOIN reservation_requests rr ON rp.reservation_request_id = rr.id
    JOIN metadata.statuses ps ON rp.status_id = ps.id
    WHERE ps.display_name = 'Pending'
      AND rp.due_date = CURRENT_DATE + INTERVAL '7 days'
  LOOP
    v_payment_data := jsonb_build_object(
      'id', v_payment.id,
      'reservation_id', v_payment.reservation_request_id,
      'amount', v_payment.amount::TEXT,
      'due_date', v_payment.due_date,  -- formatDate handles this
      'payment_type', v_payment.payment_type,
      'event_type', v_payment.event_type,
      'time_slot', v_payment.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    PERFORM create_notification(
      p_user_id := v_payment.requestor_id,
      p_template_name := 'payment_reminder_7day',
      p_entity_type := 'reservation_payments',
      p_entity_id := v_payment.id::text,
      p_entity_data := v_payment_data,
      p_channels := ARRAY['email']::TEXT[]
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Function: Send payment due today notifications
CREATE OR REPLACE FUNCTION send_payment_due_today()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_payment RECORD;
  v_payment_data JSONB;
  v_count INT := 0;
BEGIN
  FOR v_payment IN
    SELECT
      rp.id,
      rp.reservation_request_id,
      rp.amount,
      rp.due_date,
      rpt.display_name as payment_type,
      rr.requestor_id,
      rr.event_type,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_payments rp
    JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
    JOIN reservation_requests rr ON rp.reservation_request_id = rr.id
    JOIN metadata.statuses ps ON rp.status_id = ps.id
    WHERE ps.display_name = 'Pending'
      AND rp.due_date = CURRENT_DATE
  LOOP
    v_payment_data := jsonb_build_object(
      'id', v_payment.id,
      'reservation_id', v_payment.reservation_request_id,
      'amount', v_payment.amount::TEXT,
      'due_date', v_payment.due_date,
      'payment_type', v_payment.payment_type,
      'event_type', v_payment.event_type,
      'time_slot', v_payment.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    PERFORM create_notification(
      p_user_id := v_payment.requestor_id,
      p_template_name := 'payment_due_today',
      p_entity_type := 'reservation_payments',
      p_entity_id := v_payment.id::text,
      p_entity_data := v_payment_data,
      p_channels := ARRAY['email']::TEXT[]
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Function: Send overdue payment notifications (daily for each day overdue, up to 7 days)
CREATE OR REPLACE FUNCTION send_payment_overdue_notifications()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_payment RECORD;
  v_payment_data JSONB;
  v_count INT := 0;
BEGIN
  FOR v_payment IN
    SELECT
      rp.id,
      rp.reservation_request_id,
      rp.amount,
      rp.due_date,
      (CURRENT_DATE - rp.due_date) as days_overdue,
      rpt.display_name as payment_type,
      rr.requestor_id,
      rr.event_type,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_payments rp
    JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
    JOIN reservation_requests rr ON rp.reservation_request_id = rr.id
    JOIN metadata.statuses ps ON rp.status_id = ps.id
    WHERE ps.display_name = 'Pending'
      AND rp.due_date < CURRENT_DATE
      AND (CURRENT_DATE - rp.due_date) <= 7  -- Only notify for first 7 days overdue
  LOOP
    v_payment_data := jsonb_build_object(
      'id', v_payment.id,
      'reservation_id', v_payment.reservation_request_id,
      'amount', v_payment.amount::TEXT,
      'due_date', v_payment.due_date,  -- formatDate handles this
      'days_overdue', v_payment.days_overdue,
      'payment_type', v_payment.payment_type,
      'event_type', v_payment.event_type,
      'time_slot', v_payment.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    PERFORM create_notification(
      p_user_id := v_payment.requestor_id,
      p_template_name := 'payment_overdue',
      p_entity_type := 'reservation_payments',
      p_entity_id := v_payment.id::text,
      p_entity_data := v_payment_data,
      p_channels := ARRAY['email']::TEXT[]
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Function: Send pre-event reminders to managers (1 day before)
CREATE OR REPLACE FUNCTION send_pre_event_reminders()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request RECORD;
  v_request_data JSONB;
  v_manager_id UUID;
  v_count INT := 0;
  v_approved_status_id INT;
BEGIN
  SELECT id INTO v_approved_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  FOR v_request IN
    SELECT
      rr.id,
      rr.requestor_name,
      rr.organization_name,
      rr.event_type,
      rr.attendee_count,
      rr.is_food_served,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_requests rr
    WHERE rr.status_id = v_approved_status_id
      AND lower(rr.time_slot)::DATE = CURRENT_DATE + INTERVAL '1 day'
  LOOP
    v_request_data := jsonb_build_object(
      'id', v_request.id,
      'requestor_name', v_request.requestor_name,
      'organization_name', v_request.organization_name,
      'event_type', v_request.event_type,
      'attendee_count', v_request.attendee_count,
      'is_food_served', v_request.is_food_served,
      'time_slot', v_request.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    -- Send to all managers
    FOR v_manager_id IN
      SELECT DISTINCT u.id
      FROM metadata.civic_os_users u
      JOIN metadata.user_roles ur ON u.id = ur.user_id
      JOIN metadata.roles r ON ur.role_id = r.id
      WHERE r.display_name IN ('manager', 'admin')
    LOOP
      PERFORM create_notification(
        p_user_id := v_manager_id,
        p_template_name := 'manager_pre_event_reminder',
        p_entity_type := 'reservation_requests',
        p_entity_id := v_request.id::text,
        p_entity_data := v_request_data,
        p_channels := ARRAY['email']::TEXT[]
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Function: Auto-transition to Completed and notify managers for post-event assessment
CREATE OR REPLACE FUNCTION auto_complete_past_events()
RETURNS INT
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request RECORD;
  v_request_data JSONB;
  v_manager_id UUID;
  v_count INT := 0;
  v_approved_status_id INT;
  v_completed_status_id INT;
BEGIN
  SELECT id INTO v_approved_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  SELECT id INTO v_completed_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Completed';

  FOR v_request IN
    SELECT
      rr.id,
      rr.requestor_name,
      rr.event_type,
      rr.time_slot  -- Pass raw time_slot for timezone-aware formatting
    FROM reservation_requests rr
    WHERE rr.status_id = v_approved_status_id
      AND upper(rr.time_slot) < NOW()  -- Event has ended
  LOOP
    -- Update status to Completed
    UPDATE reservation_requests
    SET status_id = v_completed_status_id
    WHERE id = v_request.id;

    v_request_data := jsonb_build_object(
      'id', v_request.id,
      'requestor_name', v_request.requestor_name,
      'event_type', v_request.event_type,
      'time_slot', v_request.time_slot::TEXT  -- formatTimeSlot handles timezone
    );

    -- Send post-event assessment reminder to managers
    FOR v_manager_id IN
      SELECT DISTINCT u.id
      FROM metadata.civic_os_users u
      JOIN metadata.user_roles ur ON u.id = ur.user_id
      JOIN metadata.roles r ON ur.role_id = r.id
      WHERE r.display_name IN ('manager', 'admin')
    LOOP
      PERFORM create_notification(
        p_user_id := v_manager_id,
        p_template_name := 'manager_post_event_reminder',
        p_entity_type := 'reservation_requests',
        p_entity_id := v_request.id::text,
        p_entity_data := v_request_data,
        p_channels := ARRAY['email']::TEXT[]
      );
    END LOOP;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;

/*
MIGRATION SUMMARY
=================

This migration fixes timezone handling in notification templates by:

1. TEMPLATE CHANGES:
   - payment_reminder_7day: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
                            {{.Entity.due_date}} -> {{formatDate .Entity.due_date}}
   - payment_due_today: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
   - payment_overdue: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}
                      {{.Entity.due_date}} -> {{formatDate .Entity.due_date}}
   - manager_pre_event_reminder: {{.Entity.time_slot_display}} -> {{formatTimeSlot .Entity.time_slot}}
   - manager_post_event_reminder: {{.Entity.event_date}} -> {{formatTimeSlot .Entity.time_slot}}

2. FUNCTION CHANGES:
   - All scheduled notification functions now pass raw `time_slot` (tstzrange)
     instead of pre-formatted `event_date` string
   - The Go renderer's formatTimeSlot() converts to the configured TIMEZONE
     (default: America/Detroit for Mott Park)

3. WHY THIS MATTERS:
   - Previously, to_char() in SQL formatted dates using the database server's
     timezone setting, which could differ from the user's expected timezone
   - Now, the Go renderer handles timezone conversion consistently using the
     TIMEZONE environment variable
   - This ensures all notification emails show times in Eastern Time (America/Detroit)

ROLLBACK (if needed):
  The previous templates and functions can be restored by running the original
  03_mpra_manager_automation.sql INSERT statements.
*/
