-- ============================================================================
-- NOTIFICATION TEMPLATES FOR COMMUNITY CENTER RESERVATION WORKFLOW
-- ============================================================================
-- This file demonstrates:
-- - Custom template formatters (formatTimeSlot, formatMoney, formatDateTime)
-- - Multi-recipient notifications (staff role-based notifications)
-- - Approval workflow notifications (created, submitted, approved, denied, cancelled)
-- - Timezone-aware date formatting via NOTIFICATION_TIMEZONE env var
-- ============================================================================

-- ============================================================================
-- HELPER FUNCTION: Get users with specific role
-- ============================================================================
-- Helper function to get all users with a specific role
-- Uses metadata.user_roles table which is synced from JWT on login

CREATE OR REPLACE FUNCTION get_users_with_role(p_role_name TEXT)
RETURNS TABLE (
  user_id UUID,
  user_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT
    u.id,
    up.email::TEXT
  FROM metadata.civic_os_users u
  INNER JOIN metadata.civic_os_users_private up ON up.id = u.id
  INNER JOIN metadata.user_roles ur ON ur.user_id = u.id
  INNER JOIN metadata.roles r ON r.id = ur.role_id
  WHERE r.display_name = p_role_name
    AND up.email IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION get_users_with_role TO authenticated;

-- ============================================================================
-- NOTIFICATION TEMPLATE 1: Reservation Request Created (Confirmation to Requester)
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name,
  description,
  subject_template,
  html_template,
  text_template,
  sms_template
)
VALUES (
  'reservation_request_created',
  'Confirmation email sent to requester when they submit a new reservation request',

  -- SUBJECT
  'Reservation Request Submitted - {{.Entity.resource.display_name}}',

  -- HTML BODY
  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #3B82F6; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #3B82F6; }
    .label { font-weight: bold; color: #1f2937; }
    .footer { margin-top: 20px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 0.9em; color: #6b7280; }
    .button { display: inline-block; background: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">✓ Request Submitted</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.requested_by.display_name}},</p>

      <p>Your reservation request has been successfully submitted and is pending staff review.</p>

      <div class="info-box">
        <p><span class="label">Facility:</span> {{.Entity.resource.display_name}}</p>
        <p><span class="label">Time:</span> {{formatTimeSlot .Entity.time_slot}}</p>
        <p><span class="label">Purpose:</span> {{.Entity.purpose}}</p>
        <p><span class="label">Attendees:</span> {{.Entity.attendee_count}}</p>
        {{if .Entity.notes}}
        <p><span class="label">Notes:</span> {{.Entity.notes}}</p>
        {{end}}
        {{if .Entity.resource.hourly_rate}}
        <p><span class="label">Hourly Rate:</span> {{formatMoney .Entity.resource.hourly_rate}}</p>
        {{end}}
      </div>

      <p><strong>What happens next?</strong></p>
      <ul>
        <li>Staff will review your request within 1-2 business days</li>
        <li>You''ll receive an email notification when your request is approved or denied</li>
        <li>You can check the status anytime in your dashboard</li>
      </ul>

      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}" class="button">View Request Details</a>

      <div class="footer">
        <p>Questions? Contact our staff at the community center office.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  -- TEXT BODY
  'RESERVATION REQUEST SUBMITTED
=================================

Hi {{.Entity.requested_by.display_name}},

Your reservation request has been successfully submitted and is pending staff review.

REQUEST DETAILS:
Facility: {{.Entity.resource.display_name}}
Time: {{formatTimeSlot .Entity.time_slot}}
Purpose: {{.Entity.purpose}}
Attendees: {{.Entity.attendee_count}}
{{if .Entity.notes}}Notes: {{.Entity.notes}}{{end}}
{{if .Entity.resource.hourly_rate}}Hourly Rate: {{formatMoney .Entity.resource.hourly_rate}}{{end}}

WHAT HAPPENS NEXT?
- Staff will review your request within 1-2 business days
- You''ll receive an email when your request is approved or denied
- Check status anytime: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}

Questions? Contact our staff at the community center office.
',

  -- SMS (optional)
  'Your reservation request for {{.Entity.resource.display_name}} on {{formatTimeSlot .Entity.time_slot}} has been submitted. You''ll be notified when staff review your request.'
)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template,
    sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- NOTIFICATION TEMPLATE 2: Reservation Request Submitted (Alert to Staff)
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name,
  description,
  subject_template,
  html_template,
  text_template,
  sms_template
)
VALUES (
  'reservation_request_submitted',
  'Notification sent to staff when a new reservation request is submitted for review',

  -- SUBJECT
  'New Reservation Request: {{.Entity.resource.display_name}} - {{.Entity.purpose}}',

  -- HTML BODY
  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #F59E0B; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #F59E0B; }
    .label { font-weight: bold; color: #1f2937; }
    .alert { background: #FEF3C7; padding: 12px; border-radius: 6px; margin: 15px 0; }
    .button { display: inline-block; background: #F59E0B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">⏳ New Reservation Request</h1>
    </div>
    <div class="content">
      <div class="alert">
        <strong>Action Required:</strong> Please review this reservation request
      </div>

      <div class="info-box">
        <p><span class="label">Request ID:</span> #{{.Entity.id}}</p>
        <p><span class="label">Requested By:</span> {{.Entity.requested_by.display_name}}</p>
        <p><span class="label">Facility:</span> {{.Entity.resource.display_name}}</p>
        <p><span class="label">Time:</span> {{formatTimeSlot .Entity.time_slot}}</p>
        <p><span class="label">Purpose:</span> {{.Entity.purpose}}</p>
        <p><span class="label">Attendees:</span> {{.Entity.attendee_count}} people</p>
        {{if .Entity.notes}}
        <p><span class="label">Special Requests:</span> {{.Entity.notes}}</p>
        {{end}}
        {{if .Entity.resource.capacity}}
        <p><span class="label">Room Capacity:</span> {{.Entity.resource.capacity}} people</p>
        {{end}}
        <p><span class="label">Submitted:</span> {{formatDateTime .Entity.created_at}}</p>
      </div>

      <p><strong>Next Steps:</strong></p>
      <ul>
        <li>Review the request details and check for scheduling conflicts</li>
        <li>Update the status to "Approved" or "Denied"</li>
        <li>If denying, provide a reason in the denial_reason field</li>
        <li>The requester will be automatically notified of your decision</li>
      </ul>

      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}" class="button">Review Request</a>
    </div>
  </div>
</body>
</html>',

  -- TEXT BODY
  'NEW RESERVATION REQUEST
=================================
ACTION REQUIRED: Please review this reservation request

REQUEST DETAILS:
Request ID: #{{.Entity.id}}
Requested By: {{.Entity.requested_by.display_name}}
Facility: {{.Entity.resource.display_name}}
Time: {{formatTimeSlot .Entity.time_slot}}
Purpose: {{.Entity.purpose}}
Attendees: {{.Entity.attendee_count}} people
{{if .Entity.notes}}Special Requests: {{.Entity.notes}}{{end}}
{{if .Entity.resource.capacity}}Room Capacity: {{.Entity.resource.capacity}} people{{end}}
Submitted: {{formatDateTime .Entity.created_at}}

NEXT STEPS:
- Review the request details and check for conflicts
- Update status to "Approved" or "Denied"
- If denying, provide a reason in denial_reason field
- Requester will be automatically notified

Review Request: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}
',

  -- SMS
  ''
)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template,
    sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- NOTIFICATION TEMPLATE 3: Reservation Request Approved
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name,
  description,
  subject_template,
  html_template,
  text_template,
  sms_template
)
VALUES (
  'reservation_request_approved',
  'Notification sent to requester when their reservation request is approved',

  -- SUBJECT
  'Reservation Approved - {{.Entity.resource.display_name}}',

  -- HTML BODY
  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #22C55E; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #22C55E; }
    .label { font-weight: bold; color: #1f2937; }
    .success { background: #D1FAE5; padding: 12px; border-radius: 6px; margin: 15px 0; color: #065F46; }
    .button { display: inline-block; background: #22C55E; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
    .footer { margin-top: 20px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 0.9em; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">✓ Reservation Approved!</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.requested_by.display_name}},</p>

      <div class="success">
        <strong>Good news!</strong> Your reservation request has been approved.
      </div>

      <div class="info-box">
        <p><span class="label">Facility:</span> {{.Entity.resource.display_name}}</p>
        <p><span class="label">Reserved Time:</span> {{formatTimeSlot .Entity.time_slot}}</p>
        <p><span class="label">Purpose:</span> {{.Entity.purpose}}</p>
        <p><span class="label">Attendees:</span> {{.Entity.attendee_count}}</p>
        {{if .Entity.resource.hourly_rate}}
        <p><span class="label">Total Cost:</span> {{formatMoney .Entity.resource.hourly_rate}}/hour</p>
        {{end}}
        {{if .Entity.reviewed_by}}
        <p><span class="label">Approved By:</span> {{.Entity.reviewed_by.display_name}}</p>
        {{end}}
        {{if .Entity.reviewed_at}}
        <p><span class="label">Approved On:</span> {{formatDateTime .Entity.reviewed_at}}</p>
        {{end}}
      </div>

      <p><strong>Important Reminders:</strong></p>
      <ul>
        <li>Please arrive 15 minutes early for setup</li>
        <li>Return the facility to its original condition after use</li>
        <li>Contact staff if you need to modify or cancel your reservation</li>
      </ul>

      <a href="{{.Metadata.site_url}}/view/reservations/{{.Entity.reservation_id}}" class="button">View Reservation</a>

      <div class="footer">
        <p>We look forward to seeing you! Contact us with any questions.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  -- TEXT BODY
  'RESERVATION APPROVED!
=================================

Hi {{.Entity.requested_by.display_name}},

Good news! Your reservation request has been approved.

RESERVATION DETAILS:
Facility: {{.Entity.resource.display_name}}
Reserved Time: {{formatTimeSlot .Entity.time_slot}}
Purpose: {{.Entity.purpose}}
Attendees: {{.Entity.attendee_count}}
{{if .Entity.resource.hourly_rate}}Total Cost: {{formatMoney .Entity.resource.hourly_rate}}/hour{{end}}
{{if .Entity.reviewed_by}}Approved By: {{.Entity.reviewed_by.display_name}}{{end}}
{{if .Entity.reviewed_at}}Approved On: {{formatDateTime .Entity.reviewed_at}}{{end}}

IMPORTANT REMINDERS:
- Arrive 15 minutes early for setup
- Return facility to original condition after use
- Contact staff to modify or cancel

View Reservation: {{.Metadata.site_url}}/view/reservations/{{.Entity.reservation_id}}

We look forward to seeing you!
',

  -- SMS
  'Your reservation for {{.Entity.resource.display_name}} on {{formatTimeSlot .Entity.time_slot}} has been approved! See you there.'
)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template,
    sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- NOTIFICATION TEMPLATE 4: Reservation Request Denied
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name,
  description,
  subject_template,
  html_template,
  text_template,
  sms_template
)
VALUES (
  'reservation_request_denied',
  'Notification sent to requester when their reservation request is denied with reason',

  -- SUBJECT
  'Reservation Request Update - {{.Entity.resource.display_name}}',

  -- HTML BODY
  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #EF4444; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #EF4444; }
    .label { font-weight: bold; color: #1f2937; }
    .reason-box { background: #FEE2E2; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 4px solid #DC2626; }
    .button { display: inline-block; background: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
    .footer { margin-top: 20px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 0.9em; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">Reservation Request Update</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.requested_by.display_name}},</p>

      <p>Thank you for your interest in reserving our facilities. Unfortunately, we are unable to approve your request at this time.</p>

      <div class="info-box">
        <p><span class="label">Facility:</span> {{.Entity.resource.display_name}}</p>
        <p><span class="label">Requested Time:</span> {{formatTimeSlot .Entity.time_slot}}</p>
        <p><span class="label">Purpose:</span> {{.Entity.purpose}}</p>
        {{if .Entity.reviewed_by}}
        <p><span class="label">Reviewed By:</span> {{.Entity.reviewed_by.display_name}}</p>
        {{end}}
        {{if .Entity.reviewed_at}}
        <p><span class="label">Reviewed On:</span> {{formatDateTime .Entity.reviewed_at}}</p>
        {{end}}
      </div>

      {{if .Entity.denial_reason}}
      <div class="reason-box">
        <p><strong>Reason:</strong></p>
        <p>{{.Entity.denial_reason}}</p>
      </div>
      {{end}}

      <p><strong>What you can do:</strong></p>
      <ul>
        <li>Submit a new request with a different time slot</li>
        <li>Check the calendar for available times</li>
        <li>Contact staff to discuss alternative options</li>
      </ul>

      <a href="{{.Metadata.site_url}}/create/reservation_requests" class="button">Submit New Request</a>

      <div class="footer">
        <p>We appreciate your understanding. Please contact us if you have questions or would like to discuss alternative arrangements.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  -- TEXT BODY
  'RESERVATION REQUEST UPDATE
=================================

Hi {{.Entity.requested_by.display_name}},

Thank you for your interest in reserving our facilities. Unfortunately, we are unable to approve your request at this time.

REQUEST DETAILS:
Facility: {{.Entity.resource.display_name}}
Requested Time: {{formatTimeSlot .Entity.time_slot}}
Purpose: {{.Entity.purpose}}
{{if .Entity.reviewed_by}}Reviewed By: {{.Entity.reviewed_by.display_name}}{{end}}
{{if .Entity.reviewed_at}}Reviewed On: {{formatDateTime .Entity.reviewed_at}}{{end}}

{{if .Entity.denial_reason}}
REASON:
{{.Entity.denial_reason}}
{{end}}

WHAT YOU CAN DO:
- Submit a new request with a different time slot
- Check the calendar for available times
- Contact staff to discuss alternative options

Submit New Request: {{.Metadata.site_url}}/create/reservation_requests

We appreciate your understanding. Contact us with questions.
',

  -- SMS
  ''
)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template,
    sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- NOTIFICATION TEMPLATE 5: Reservation Request Cancelled
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name,
  description,
  subject_template,
  html_template,
  text_template,
  sms_template
)
VALUES (
  'reservation_request_cancelled',
  'Notification sent to staff when a requester cancels their reservation',

  -- SUBJECT
  'Reservation Cancelled: {{.Entity.resource.display_name}} - {{.Entity.purpose}}',

  -- HTML BODY
  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #6B7280; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #6B7280; }
    .label { font-weight: bold; color: #1f2937; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">🚫 Reservation Cancelled</h1>
    </div>
    <div class="content">
      <p>A reservation request has been cancelled by the requester.</p>

      <div class="info-box">
        <p><span class="label">Request ID:</span> #{{.Entity.id}}</p>
        <p><span class="label">Cancelled By:</span> {{.Entity.requested_by.display_name}}</p>
        <p><span class="label">Facility:</span> {{.Entity.resource.display_name}}</p>
        <p><span class="label">Time:</span> {{formatTimeSlot .Entity.time_slot}}</p>
        <p><span class="label">Purpose:</span> {{.Entity.purpose}}</p>
        <p><span class="label">Attendees:</span> {{.Entity.attendee_count}}</p>
        {{if .Entity.reviewed_at}}
        <p><span class="label">Cancelled On:</span> {{formatDateTime .Entity.reviewed_at}}</p>
        {{end}}
      </div>

      <p>This time slot is now available for other reservations.</p>
    </div>
  </div>
</body>
</html>',

  -- TEXT BODY
  'RESERVATION CANCELLED
=================================

A reservation request has been cancelled by the requester.

DETAILS:
Request ID: #{{.Entity.id}}
Cancelled By: {{.Entity.requested_by.display_name}}
Facility: {{.Entity.resource.display_name}}
Time: {{formatTimeSlot .Entity.time_slot}}
Purpose: {{.Entity.purpose}}
Attendees: {{.Entity.attendee_count}}
{{if .Entity.reviewed_at}}Cancelled On: {{formatDateTime .Entity.reviewed_at}}{{end}}

This time slot is now available for other reservations.
',

  -- SMS
  ''
)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template,
    sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- TRIGGER FUNCTIONS
-- ============================================================================

-- TRIGGER 1: Send confirmation when requester creates new request
CREATE OR REPLACE FUNCTION notify_reservation_request_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request_data JSONB;
BEGIN
  -- Build request data with embedded relationships
  SELECT jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW.display_name,
    'time_slot', NEW.time_slot,
    'purpose', NEW.purpose,
    'attendee_count', NEW.attendee_count,
    'notes', NEW.notes,
    'created_at', NEW.created_at,
    'requested_by', jsonb_build_object(
      'id', u.id,
      'display_name', u.display_name,
      'email', up.email
    ),
    'resource', jsonb_build_object(
      'id', r.id,
      'display_name', r.display_name,
      'description', r.description,
      'hourly_rate', r.hourly_rate,
      'capacity', r.capacity
    )
  )
  INTO v_request_data
  FROM metadata.civic_os_users u
  LEFT JOIN metadata.civic_os_users_private up ON up.id = u.id
  CROSS JOIN resources r
  WHERE u.id = NEW.requested_by
    AND r.id = NEW.resource_id;

  -- Send confirmation to requester
  INSERT INTO metadata.notifications (
    user_id,
    template_name,
    entity_type,
    entity_id,
    entity_data
  ) VALUES (
    NEW.requested_by,
    'reservation_request_created',
    'reservation_requests',
    NEW.id,
    v_request_data
  );

  RETURN NEW;
END;
$$;

-- TRIGGER 2: Alert staff when request is submitted
CREATE OR REPLACE FUNCTION notify_reservation_request_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request_data JSONB;
  v_staff_user RECORD;
BEGIN
  -- Build request data with embedded relationships
  SELECT jsonb_build_object(
    'id', NEW.id,
    'display_name', NEW.display_name,
    'time_slot', NEW.time_slot,
    'purpose', NEW.purpose,
    'attendee_count', NEW.attendee_count,
    'notes', NEW.notes,
    'created_at', NEW.created_at,
    'requested_by', jsonb_build_object(
      'id', u.id,
      'display_name', u.display_name,
      'email', up.email
    ),
    'resource', jsonb_build_object(
      'id', r.id,
      'display_name', r.display_name,
      'description', r.description,
      'hourly_rate', r.hourly_rate,
      'capacity', r.capacity
    )
  )
  INTO v_request_data
  FROM metadata.civic_os_users u
  LEFT JOIN metadata.civic_os_users_private up ON up.id = u.id
  CROSS JOIN resources r
  WHERE u.id = NEW.requested_by
    AND r.id = NEW.resource_id;

  -- Send notification to all staff members (editor and admin roles)
  FOR v_staff_user IN
    SELECT DISTINCT user_id, user_email
    FROM get_users_with_role('editor')
    UNION
    SELECT DISTINCT user_id, user_email
    FROM get_users_with_role('admin')
  LOOP
    INSERT INTO metadata.notifications (
      user_id,
      template_name,
      entity_type,
      entity_id,
      entity_data
    ) VALUES (
      v_staff_user.user_id,
      'reservation_request_submitted',
      'reservation_requests',
      NEW.id,
      v_request_data
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- TRIGGER 3: Notify requester when approved
CREATE OR REPLACE FUNCTION notify_reservation_request_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request_data JSONB;
  v_approved_status_id INT;
BEGIN
  -- Get Approved status ID
  SELECT id INTO v_approved_status_id FROM request_statuses WHERE display_name = 'Approved';

  -- Only send if status changed TO approved
  IF NEW.status_id = v_approved_status_id AND (OLD IS NULL OR OLD.status_id != v_approved_status_id) THEN
    -- Build request data with embedded relationships
    SELECT jsonb_build_object(
      'id', NEW.id,
      'display_name', NEW.display_name,
      'time_slot', NEW.time_slot,
      'purpose', NEW.purpose,
      'attendee_count', NEW.attendee_count,
      'notes', NEW.notes,
      'reviewed_at', NEW.reviewed_at,
      'reservation_id', NEW.reservation_id,
      'requested_by', jsonb_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'email', up.email
      ),
      'resource', jsonb_build_object(
        'id', r.id,
        'display_name', r.display_name,
        'hourly_rate', r.hourly_rate
      ),
      'reviewed_by', CASE WHEN NEW.reviewed_by IS NOT NULL THEN
        jsonb_build_object(
          'id', reviewer.id,
          'display_name', reviewer.display_name
        )
      ELSE NULL END
    )
    INTO v_request_data
    FROM metadata.civic_os_users u
    LEFT JOIN metadata.civic_os_users_private up ON up.id = u.id
    CROSS JOIN resources r
    LEFT JOIN metadata.civic_os_users reviewer ON reviewer.id = NEW.reviewed_by
    WHERE u.id = NEW.requested_by
      AND r.id = NEW.resource_id;

    -- Send notification to requester
    INSERT INTO metadata.notifications (
      user_id,
      template_name,
      entity_type,
      entity_id,
      entity_data
    ) VALUES (
      NEW.requested_by,
      'reservation_request_approved',
      'reservation_requests',
      NEW.id,
      v_request_data
    );
  END IF;

  RETURN NEW;
END;
$$;

-- TRIGGER 4: Notify requester when denied
CREATE OR REPLACE FUNCTION notify_reservation_request_denied()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request_data JSONB;
  v_denied_status_id INT;
BEGIN
  -- Get Denied status ID
  SELECT id INTO v_denied_status_id FROM request_statuses WHERE display_name = 'Denied';

  -- Only send if status changed TO denied
  IF NEW.status_id = v_denied_status_id AND (OLD IS NULL OR OLD.status_id != v_denied_status_id) THEN
    -- Build request data with embedded relationships
    SELECT jsonb_build_object(
      'id', NEW.id,
      'display_name', NEW.display_name,
      'time_slot', NEW.time_slot,
      'purpose', NEW.purpose,
      'attendee_count', NEW.attendee_count,
      'denial_reason', NEW.denial_reason,
      'reviewed_at', NEW.reviewed_at,
      'requested_by', jsonb_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'email', up.email
      ),
      'resource', jsonb_build_object(
        'id', r.id,
        'display_name', r.display_name
      ),
      'reviewed_by', CASE WHEN NEW.reviewed_by IS NOT NULL THEN
        jsonb_build_object(
          'id', reviewer.id,
          'display_name', reviewer.display_name
        )
      ELSE NULL END
    )
    INTO v_request_data
    FROM metadata.civic_os_users u
    LEFT JOIN metadata.civic_os_users_private up ON up.id = u.id
    CROSS JOIN resources r
    LEFT JOIN metadata.civic_os_users reviewer ON reviewer.id = NEW.reviewed_by
    WHERE u.id = NEW.requested_by
      AND r.id = NEW.resource_id;

    -- Send notification to requester
    INSERT INTO metadata.notifications (
      user_id,
      template_name,
      entity_type,
      entity_id,
      entity_data
    ) VALUES (
      NEW.requested_by,
      'reservation_request_denied',
      'reservation_requests',
      NEW.id,
      v_request_data
    );
  END IF;

  RETURN NEW;
END;
$$;

-- TRIGGER 5: Alert staff when requester cancels
CREATE OR REPLACE FUNCTION notify_reservation_request_cancelled()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request_data JSONB;
  v_cancelled_status_id INT;
  v_staff_user RECORD;
BEGIN
  -- Get Cancelled status ID
  SELECT id INTO v_cancelled_status_id FROM request_statuses WHERE display_name = 'Cancelled';

  -- Only send if status changed TO cancelled
  IF NEW.status_id = v_cancelled_status_id AND (OLD IS NULL OR OLD.status_id != v_cancelled_status_id) THEN
    -- Build request data with embedded relationships
    SELECT jsonb_build_object(
      'id', NEW.id,
      'display_name', NEW.display_name,
      'time_slot', NEW.time_slot,
      'purpose', NEW.purpose,
      'attendee_count', NEW.attendee_count,
      'reviewed_at', NEW.reviewed_at,
      'requested_by', jsonb_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'email', up.email
      ),
      'resource', jsonb_build_object(
        'id', r.id,
        'display_name', r.display_name
      )
    )
    INTO v_request_data
    FROM metadata.civic_os_users u
    LEFT JOIN metadata.civic_os_users_private up ON up.id = u.id
    CROSS JOIN resources r
    WHERE u.id = NEW.requested_by
      AND r.id = NEW.resource_id;

    -- Send notification to all staff members
    FOR v_staff_user IN
      SELECT DISTINCT user_id, user_email
      FROM get_users_with_role('editor')
      UNION
      SELECT DISTINCT user_id, user_email
      FROM get_users_with_role('admin')
    LOOP
      INSERT INTO metadata.notifications (
        user_id,
        template_name,
        entity_type,
        entity_id,
        entity_data
      ) VALUES (
        v_staff_user.user_id,
        'reservation_request_cancelled',
        'reservation_requests',
        NEW.id,
        v_request_data
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION notify_reservation_request_created TO authenticated;
GRANT EXECUTE ON FUNCTION notify_reservation_request_submitted TO authenticated;
GRANT EXECUTE ON FUNCTION notify_reservation_request_approved TO authenticated;
GRANT EXECUTE ON FUNCTION notify_reservation_request_denied TO authenticated;
GRANT EXECUTE ON FUNCTION notify_reservation_request_cancelled TO authenticated;

-- ============================================================================
-- DATABASE TRIGGERS
-- ============================================================================

-- Trigger for request creation (sends confirmation to requester)
CREATE TRIGGER trg_notify_reservation_request_created
  AFTER INSERT ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_reservation_request_created();

-- Staff alert trigger
CREATE TRIGGER trg_notify_reservation_request_submitted
  AFTER INSERT ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_reservation_request_submitted();

-- Trigger for status changes (approved/denied)
CREATE TRIGGER trg_notify_reservation_request_approved
  AFTER INSERT OR UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_reservation_request_approved();

CREATE TRIGGER trg_notify_reservation_request_denied
  AFTER INSERT OR UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_reservation_request_denied();

-- Staff cancellation alert
CREATE TRIGGER trg_notify_reservation_request_cancelled
  AFTER INSERT OR UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_reservation_request_cancelled();
