-- ============================================================================
-- MOTT PARK RECREATION AREA - MANAGER AUTOMATION
-- Part 3: Validations, Payment Reminders, Auto-Transitions
-- ============================================================================
-- Run AFTER Part 1 (schema) and Part 2 (holidays/dashboard)
-- ============================================================================

-- Wrap in transaction for atomic execution
BEGIN;

-- ============================================================================
-- SECTION 1: MINIMUM ADVANCE BOOKING (10 days per policy)
-- ============================================================================

-- Add validation to prevent bookings less than 10 days out
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES (
  'reservation_requests',
  'time_slot',
  'min',
  '10',  -- Will need custom handling - see CHECK constraint below
  'Reservations must be made at least 10 days in advance per facility policy.',
  1
) ON CONFLICT (table_name, column_name, validation_type) DO UPDATE SET
  error_message = EXCLUDED.error_message;

-- CHECK constraint for backend enforcement
ALTER TABLE reservation_requests
  ADD CONSTRAINT min_advance_booking
  CHECK (
    lower(time_slot)::DATE >= (CURRENT_DATE + INTERVAL '10 days')::DATE
  );

-- Friendly error message for constraint
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'min_advance_booking',
  'reservation_requests',
  'time_slot',
  'Reservations must be made at least 10 days in advance. Please select a date that is 10 or more days from today.'
) ON CONFLICT (constraint_name) DO UPDATE SET
  error_message = EXCLUDED.error_message;

-- Also enforce maximum 1 year in advance
ALTER TABLE reservation_requests
  ADD CONSTRAINT max_advance_booking
  CHECK (
    lower(time_slot)::DATE <= (CURRENT_DATE + INTERVAL '1 year')::DATE
  );

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'max_advance_booking',
  'reservation_requests',
  'time_slot',
  'Reservations cannot be made more than 1 year in advance.'
) ON CONFLICT (constraint_name) DO UPDATE SET
  error_message = EXCLUDED.error_message;

-- ============================================================================
-- SECTION 2: REQUEST AGE TRACKING
-- ============================================================================

-- NOTE: These can't be GENERATED columns because NOW() is not immutable.
-- They're regular columns updated by triggers on INSERT/UPDATE.
-- For real-time accuracy in queries, use calculated expressions in SELECT.
ALTER TABLE reservation_requests
  ADD COLUMN IF NOT EXISTS request_age_days INT DEFAULT 0;

ALTER TABLE reservation_requests
  ADD COLUMN IF NOT EXISTS days_until_event INT DEFAULT 0;

-- Trigger to update age/days columns
CREATE OR REPLACE FUNCTION update_request_age_columns()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.request_age_days := EXTRACT(DAY FROM (NOW() - NEW.created_at))::INT;
  NEW.days_until_event := EXTRACT(DAY FROM (lower(NEW.time_slot) - NOW()))::INT;
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_request_age_trigger
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_request_age_columns();

-- Configure these for display
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, filterable)
VALUES
  ('reservation_requests', 'request_age_days', 'Request Age (Days)', 'Days since request was submitted', 92, TRUE, FALSE, FALSE, TRUE, FALSE),
  ('reservation_requests', 'days_until_event', 'Days Until Event', 'Days remaining before event date', 93, TRUE, FALSE, FALSE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- ============================================================================
-- SECTION 3: PAYMENT TRACKING ENHANCEMENTS
-- ============================================================================

-- Add days until due calculation to payments
-- NOTE: Can't use GENERATED because CURRENT_DATE is not immutable
ALTER TABLE reservation_payments
  ADD COLUMN IF NOT EXISTS days_until_due INT DEFAULT NULL;

-- Add overdue flag (maintained by trigger since generated columns can't use subqueries)
ALTER TABLE reservation_payments
  ADD COLUMN IF NOT EXISTS is_overdue BOOLEAN NOT NULL DEFAULT FALSE;

-- Function to compute is_overdue status and days_until_due
CREATE OR REPLACE FUNCTION update_payment_overdue_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_pending_status_id INT;
BEGIN
  -- Get the Pending status ID
  SELECT id INTO v_pending_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_payment' AND display_name = 'Pending';

  -- Compute days_until_due
  IF NEW.due_date IS NOT NULL THEN
    NEW.days_until_due := (NEW.due_date - CURRENT_DATE);
  ELSE
    NEW.days_until_due := NULL;
  END IF;

  -- Compute is_overdue
  NEW.is_overdue := (
    NEW.status_id = v_pending_status_id
    AND NEW.due_date IS NOT NULL
    AND NEW.due_date < CURRENT_DATE
  );

  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS payment_overdue_status_trigger ON reservation_payments;
CREATE TRIGGER payment_overdue_status_trigger
  BEFORE INSERT OR UPDATE ON reservation_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_payment_overdue_status();

-- Configure for display
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, filterable)
VALUES
  ('reservation_payments', 'days_until_due', 'Days Until Due', 'Days remaining before payment is due (negative = overdue)', 15, TRUE, FALSE, FALSE, TRUE, FALSE),
  ('reservation_payments', 'is_overdue', 'Overdue?', 'Whether this payment is past due', 16, TRUE, FALSE, FALSE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  show_on_list = EXCLUDED.show_on_list,
  filterable = EXCLUDED.filterable;

-- ============================================================================
-- SECTION 4: NOTIFICATION TEMPLATES FOR AUTOMATED REMINDERS
-- ============================================================================

-- Payment reminder (7 days before due)
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'payment_reminder_7day',
  'Reminder sent 7 days before payment due date',
  'reservation_payments',
  'Payment Reminder: {{.Entity.payment_type}} due in 7 days',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #F59E0B;">⏰ Payment Reminder</h2>
    <p>This is a friendly reminder that your <strong>{{.Entity.payment_type}}</strong> payment of <strong>{{.Entity.amount}}</strong> is due on <strong>{{.Entity.due_date}}</strong> (7 days from now).</p>
    <h3>Reservation Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date:</strong> {{.Entity.event_date}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Make Payment
      </a>
    </p>
  </div>',
  'PAYMENT REMINDER

Your {{.Entity.payment_type}} payment of {{.Entity.amount}} is due on {{.Entity.due_date}} (7 days from now).

Event: {{.Entity.event_type}}
Date: {{.Entity.event_date}}

Make payment at: {{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Payment due today
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'payment_due_today',
  'Notification sent on payment due date',
  'reservation_payments',
  'Payment Due Today: {{.Entity.payment_type}}',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #EF4444;">📅 Payment Due Today</h2>
    <p>Your <strong>{{.Entity.payment_type}}</strong> payment of <strong>{{.Entity.amount}}</strong> is due <strong>TODAY</strong>.</p>
    <h3>Reservation Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date:</strong> {{.Entity.event_date}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}"
         style="display: inline-block; background-color: #EF4444; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Pay Now
      </a>
    </p>
    <p style="color: #6b7280; font-size: 12px;">Failure to pay may result in cancellation of your reservation.</p>
  </div>',
  'PAYMENT DUE TODAY

Your {{.Entity.payment_type}} payment of {{.Entity.amount}} is due TODAY.

Event: {{.Entity.event_type}}
Date: {{.Entity.event_date}}

Pay now at: {{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}

Failure to pay may result in cancellation of your reservation.'
) ON CONFLICT (name) DO UPDATE SET
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Payment overdue
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'payment_overdue',
  'Notification sent when payment is past due',
  'reservation_payments',
  '⚠️ OVERDUE: {{.Entity.payment_type}} Payment Required',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #DC2626;">⚠️ Payment Overdue</h2>
    <p>Your <strong>{{.Entity.payment_type}}</strong> payment of <strong>{{.Entity.amount}}</strong> was due on <strong>{{.Entity.due_date}}</strong> and is now <strong>{{.Entity.days_overdue}} days overdue</strong>.</p>
    <p style="color: #DC2626; font-weight: bold;">Your reservation may be cancelled if payment is not received promptly.</p>
    <h3>Reservation Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date:</strong> {{.Entity.event_date}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}"
         style="display: inline-block; background-color: #DC2626; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Pay Immediately
      </a>
    </p>
    <p style="color: #6b7280; font-size: 12px;">If you have questions, please contact the Mott Park Recreation Association.</p>
  </div>',
  'PAYMENT OVERDUE

Your {{.Entity.payment_type}} payment of {{.Entity.amount}} was due on {{.Entity.due_date}} and is now {{.Entity.days_overdue}} days overdue.

YOUR RESERVATION MAY BE CANCELLED IF PAYMENT IS NOT RECEIVED PROMPTLY.

Event: {{.Entity.event_type}}
Date: {{.Entity.event_date}}

Pay immediately at: {{.Metadata.site_url}}/view/reservation_payments/{{.Entity.id}}

If you have questions, please contact the Mott Park Recreation Association.'
) ON CONFLICT (name) DO UPDATE SET
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Pre-event reminder to manager (1 day before)
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'manager_pre_event_reminder',
  'Reminder to managers 1 day before an event',
  'reservation_requests',
  'Tomorrow: {{.Entity.event_type}} at Clubhouse',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #2563eb;">📋 Event Tomorrow</h2>
    <p>Reminder: There is a reservation at the clubhouse tomorrow.</p>
    <h3>Event Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Organizer:</strong> {{.Entity.requestor_name}}</p>
    {{if .Entity.organization_name}}<p><strong>Organization:</strong> {{.Entity.organization_name}}</p>{{end}}
    <p><strong>Time:</strong> {{.Entity.time_slot_display}}</p>
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
  'EVENT TOMORROW

Reminder: There is a reservation at the clubhouse tomorrow.

Event: {{.Entity.event_type}}
Organizer: {{.Entity.requestor_name}}
{{if .Entity.organization_name}}Organization: {{.Entity.organization_name}}{{end}}
Time: {{.Entity.time_slot_display}}
Attendees: {{.Entity.attendee_count}}
Food: {{if .Entity.is_food_served}}Yes{{else}}No{{end}}

PRE-EVENT CHECKLIST:
[ ] Verify all payments received
[ ] Confirm contact info for organizer
[ ] Check facility is clean and ready
[ ] Ensure supplies are stocked
[ ] Test locks and lights

View reservation: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Post-event reminder to manager (transition to Completed)
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'manager_post_event_reminder',
  'Reminder to managers after event to assess and close',
  'reservation_requests',
  'Action Required: {{.Entity.event_type}} - Post-Event Assessment',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #8B5CF6;">✓ Event Completed - Assessment Needed</h2>
    <p>The following event has ended and requires post-event assessment:</p>
    <h3>Event Details</h3>
    <p><strong>Event:</strong> {{.Entity.event_type}}</p>
    <p><strong>Organizer:</strong> {{.Entity.requestor_name}}</p>
    <p><strong>Date:</strong> {{.Entity.event_date}}</p>
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
  'EVENT COMPLETED - ASSESSMENT NEEDED

The following event has ended and requires post-event assessment:

Event: {{.Entity.event_type}}
Organizer: {{.Entity.requestor_name}}
Date: {{.Entity.event_date}}

POST-EVENT CHECKLIST:
[ ] Inspect facility for damages
[ ] Verify facility was left clean
[ ] Document any issues with photos
[ ] Determine deposit refund amount
[ ] Process refund or note deductions
[ ] Update status to "Closed"

Complete assessment: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- SECTION 5: SCHEDULED NOTIFICATION FUNCTIONS
-- These would be called by a cron job or scheduled task
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
  v_requestor_id UUID;
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
      to_char(lower(rr.time_slot), 'Mon DD, YYYY') as event_date
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
      'due_date', v_payment.due_date,
      'payment_type', v_payment.payment_type,
      'event_type', v_payment.event_type,
      'event_date', v_payment.event_date
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
      to_char(lower(rr.time_slot), 'Mon DD, YYYY') as event_date
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
      'event_date', v_payment.event_date
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
      to_char(lower(rr.time_slot), 'Mon DD, YYYY') as event_date
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
      'due_date', v_payment.due_date,
      'days_overdue', v_payment.days_overdue,
      'payment_type', v_payment.payment_type,
      'event_type', v_payment.event_type,
      'event_date', v_payment.event_date
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
      to_char(lower(rr.time_slot), 'Mon DD, YYYY HH:MI AM') || ' - ' || 
        to_char(upper(rr.time_slot), 'HH:MI AM') as time_slot_display,
      to_char(lower(rr.time_slot), 'Mon DD, YYYY') as event_date
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
      'time_slot_display', v_request.time_slot_display,
      'event_date', v_request.event_date
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
      to_char(lower(rr.time_slot), 'Mon DD, YYYY') as event_date
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
      'event_date', v_request.event_date
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

-- Grant execute to authenticated for manual runs or cron jobs
GRANT EXECUTE ON FUNCTION send_payment_reminders_7day() TO authenticated;
GRANT EXECUTE ON FUNCTION send_payment_due_today() TO authenticated;
GRANT EXECUTE ON FUNCTION send_payment_overdue_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION send_pre_event_reminders() TO authenticated;
GRANT EXECUTE ON FUNCTION auto_complete_past_events() TO authenticated;

-- ============================================================================
-- SECTION 6: MASTER DAILY JOB FUNCTION
-- Runs all scheduled tasks via Civic OS Scheduled Jobs system (v0.22.0+)
-- ============================================================================

CREATE OR REPLACE FUNCTION run_daily_reservation_tasks()
RETURNS JSONB
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_results JSONB := '[]'::JSONB;
  v_count INT;
  v_total_processed INT := 0;
BEGIN
  -- 1. Auto-complete past events (run first so payment reminders don't go to completed events)
  v_count := auto_complete_past_events();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'auto_complete_past_events', 'count', v_count);

  -- 2. Send 7-day payment reminders
  v_count := send_payment_reminders_7day();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'payment_reminders_7day', 'count', v_count);

  -- 3. Send payment due today notifications
  v_count := send_payment_due_today();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'payment_due_today', 'count', v_count);

  -- 4. Send overdue payment notifications
  v_count := send_payment_overdue_notifications();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'payment_overdue', 'count', v_count);

  -- 5. Send pre-event reminders to managers
  v_count := send_pre_event_reminders();
  v_total_processed := v_total_processed + v_count;
  v_results := v_results || jsonb_build_object('task', 'pre_event_reminders', 'count', v_count);

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Processed %s records across 5 tasks', v_total_processed),
    'details', jsonb_build_object(
      'total_processed', v_total_processed,
      'tasks', v_results
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'message', SQLERRM,
    'details', jsonb_build_object(
      'sqlstate', SQLSTATE,
      'context', pg_exception_context()
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION run_daily_reservation_tasks() TO authenticated;

COMMENT ON FUNCTION run_daily_reservation_tasks() IS
  'Master function to run all daily reservation system tasks.
   Called automatically by Civic OS Scheduled Jobs system at 8 AM ET.
   Returns JSONB with success, message, and detailed task breakdown.';

-- ============================================================================
-- SECTION 7: UPDATE MANAGER DASHBOARD WITH NEW WIDGETS
-- ============================================================================

DO $$
DECLARE
  v_dashboard_id INT;
BEGIN
  -- Find the manager dashboard
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE display_name = 'Reservation Management';
  
  IF v_dashboard_id IS NOT NULL THEN
    -- Add Overdue Payments widget (high priority - red alert) - idempotent
    IF NOT EXISTS (
      SELECT 1 FROM metadata.dashboard_widgets
      WHERE dashboard_id = v_dashboard_id AND title = '🚨 Overdue Payments'
    ) THEN
      INSERT INTO metadata.dashboard_widgets (
        dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
      ) VALUES (
        v_dashboard_id,
        'filtered_list',
        '🚨 Overdue Payments',
        'reservation_payments',
        jsonb_build_object(
          'filters', jsonb_build_array(
            jsonb_build_object('column', 'is_overdue', 'operator', 'eq', 'value', true)
          ),
          'orderBy', 'due_date',
          'orderDirection', 'asc',
          'limit', 10,
          'showColumns', jsonb_build_array('display_name', 'amount', 'due_date', 'days_until_due', 'reservation_request_id')
        ),
        0,  -- First position (before pending requests)
        1,
        2
      );

      -- Update sort orders of existing widgets to make room (only when adding new widgets)
      UPDATE metadata.dashboard_widgets
      SET sort_order = sort_order + 1
      WHERE dashboard_id = v_dashboard_id
        AND sort_order >= 0
        AND title NOT IN ('🚨 Overdue Payments');
    END IF;

    -- Add Events This Week widget - idempotent
    IF NOT EXISTS (
      SELECT 1 FROM metadata.dashboard_widgets
      WHERE dashboard_id = v_dashboard_id AND title = '📅 Events This Week'
    ) THEN
      INSERT INTO metadata.dashboard_widgets (
        dashboard_id, widget_type, title, entity_key, config, sort_order, width, height
      ) VALUES (
        v_dashboard_id,
        'filtered_list',
        '📅 Events This Week',
        'reservation_requests',
        jsonb_build_object(
          'filters', jsonb_build_array(
            jsonb_build_object(
              'column', 'status_id',
              'operator', 'eq',
              'value', (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved')
            ),
            jsonb_build_object(
              'column', 'days_until_event',
              'operator', 'lte',
              'value', 7
            ),
            jsonb_build_object(
              'column', 'days_until_event',
              'operator', 'gte',
              'value', 0
            )
          ),
          'orderBy', 'time_slot',
          'orderDirection', 'asc',
          'limit', 10,
          'showColumns', jsonb_build_array('display_name_full', 'time_slot', 'days_until_event', 'attendee_count')
        ),
        1,  -- Second position
        1,
        2
      );

      -- Update sort orders of existing widgets to make room (only when adding new widgets)
      UPDATE metadata.dashboard_widgets
      SET sort_order = sort_order + 1
      WHERE dashboard_id = v_dashboard_id
        AND sort_order >= 1
        AND title NOT IN ('🚨 Overdue Payments', '📅 Events This Week');
    END IF;
  END IF;
END $$;

-- ============================================================================
-- SECTION 8: REQUEST AGE SLA INDICATOR
-- ============================================================================

-- Add SLA status indicator (requests pending > 3 days need attention)
-- Maintained by trigger since generated columns can't use subqueries
ALTER TABLE reservation_requests
  ADD COLUMN IF NOT EXISTS needs_attention BOOLEAN NOT NULL DEFAULT FALSE;

-- Function to compute needs_attention status
CREATE OR REPLACE FUNCTION update_request_needs_attention()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_pending_status_id INT;
BEGIN
  -- Get the Pending status ID
  SELECT id INTO v_pending_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Pending';

  -- Compute needs_attention
  NEW.needs_attention := (
    NEW.status_id = v_pending_status_id
    AND EXTRACT(DAY FROM (NOW() - NEW.created_at)) > 3
  );

  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS request_needs_attention_trigger ON reservation_requests;
CREATE TRIGGER request_needs_attention_trigger
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_request_needs_attention();

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, filterable)
VALUES ('reservation_requests', 'needs_attention', 'Needs Attention', 'Request has been pending for more than 3 days', 6, TRUE, FALSE, FALSE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  filterable = EXCLUDED.filterable;

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- SECTION 9: REGISTER SCHEDULED JOB (Civic OS v0.22.0+)
-- ============================================================================

-- Register the daily reservation tasks to run at 8 AM Eastern Time
-- The Civic OS Scheduled Jobs system will automatically execute this function
INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES (
  'daily_reservation_tasks',
  'run_daily_reservation_tasks',
  '0 8 * * *',           -- 8 AM daily
  'America/Detroit',     -- Eastern Time (Michigan)
  'Runs daily automation: auto-complete past events, payment reminders (7-day, due today, overdue), and pre-event manager notifications.'
) ON CONFLICT (name) DO UPDATE SET
  function_name = EXCLUDED.function_name,
  schedule = EXCLUDED.schedule,
  timezone = EXCLUDED.timezone,
  description = EXCLUDED.description;

/*
SCHEDULED JOB DOCUMENTATION
===========================

Job: daily_reservation_tasks
Schedule: 8:00 AM Eastern Time daily
Function: run_daily_reservation_tasks()

Tasks performed (in order):
1. auto_complete_past_events - Transitions approved events that have ended to "Completed" status
2. payment_reminders_7day - Sends email reminders 7 days before payment due date
3. payment_due_today - Sends urgent notification on payment due date
4. payment_overdue - Sends daily overdue notices (up to 7 days overdue)
5. pre_event_reminders - Notifies managers 1 day before approved events

Monitoring:
  -- View job status
  SELECT * FROM scheduled_job_status WHERE name = 'daily_reservation_tasks';

  -- View recent runs
  SELECT started_at, completed_at, success, message, triggered_by
  FROM metadata.scheduled_job_runs r
  JOIN metadata.scheduled_jobs j ON r.job_id = j.id
  WHERE j.name = 'daily_reservation_tasks'
  ORDER BY started_at DESC
  LIMIT 10;

Manual trigger:
  SELECT trigger_scheduled_job('daily_reservation_tasks');

Disable temporarily:
  UPDATE metadata.scheduled_jobs SET enabled = false WHERE name = 'daily_reservation_tasks';
*/

-- Complete transaction
COMMIT;

-- ROLLBACK;