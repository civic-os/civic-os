-- ============================================================================
-- STAFF PORTAL - NOTIFICATION TEMPLATES
-- ============================================================================
-- This file creates notification templates and trigger functions for the
-- staff portal workflow events:
--   1. document_needs_revision   - Staff doc marked "Needs Revision"
--   2. document_approved         - Staff doc approved
--   3. time_off_submitted        - New time-off request created
--   4. time_off_approved         - Time-off request approved
--   5. time_off_denied           - Time-off request denied
--   6. reimbursement_submitted   - New reimbursement request created
--   7. reimbursement_approved    - Reimbursement approved
--   8. reimbursement_denied      - Reimbursement denied
--   9. incident_report_filed     - New incident report created
--  10. onboarding_complete       - Staff member onboarding fully approved
-- ============================================================================

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get users with a specific role (reusable across examples)
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

-- Get site lead email for a given site
CREATE OR REPLACE FUNCTION get_site_lead_email(p_site_id BIGINT)
RETURNS TABLE (
  user_id UUID,
  user_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT sm.user_id, up.email::TEXT
  FROM sites s
  JOIN staff_members sm ON sm.id = s.lead_id
  JOIN metadata.civic_os_users_private up ON up.id = sm.user_id
  WHERE s.id = p_site_id
    AND sm.user_id IS NOT NULL
    AND up.email IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION get_site_lead_email TO authenticated;

-- ============================================================================
-- TEMPLATE 1: document_needs_revision
-- Sent to staff member when their document is marked "Needs Revision"
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'document_needs_revision',
  'Sent to staff member when their document status changes to Needs Revision',

  'Action needed: {{.Entity.DocumentName}} needs revision',

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
    .button { display: inline-block; background: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
    .footer { margin-top: 20px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 0.9em; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">Document Needs Revision</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <p>Your document <strong>{{.Entity.DocumentName}}</strong> has been reviewed and needs revision before it can be approved.</p>
      <div class="info-box">
        <p><span class="label">Document:</span> {{.Entity.DocumentName}}</p>
        <p><span class="label">Requirement:</span> {{.Entity.RequirementName}}</p>
        {{if .Entity.ReviewerNotes}}<p><span class="label">Reviewer Notes:</span> {{.Entity.ReviewerNotes}}</p>{{end}}
      </div>
      <p>Please upload a revised version of the document at your earliest convenience.</p>
      <a href="{{.Metadata.site_url}}/view/staff_documents/{{.Entity.DocumentId}}" class="button">View Document</a>
      <div class="footer">
        <p>If you have questions, please contact your site lead or program manager.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'DOCUMENT NEEDS REVISION
=================================

Hi {{.Entity.StaffName}},

Your document "{{.Entity.DocumentName}}" has been reviewed and needs revision.

Document: {{.Entity.DocumentName}}
Requirement: {{.Entity.RequirementName}}
{{if .Entity.ReviewerNotes}}Reviewer Notes: {{.Entity.ReviewerNotes}}{{end}}

Please upload a revised version at your earliest convenience.

View Document: {{.Metadata.site_url}}/view/staff_documents/{{.Entity.DocumentId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 2: document_approved
-- Sent to staff member when their document is approved
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'document_approved',
  'Sent to staff member when their document status changes to Approved',

  '{{.Entity.DocumentName}} approved',

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
    .button { display: inline-block; background: #22C55E; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
    .footer { margin-top: 20px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 0.9em; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">Document Approved</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <p>Your document <strong>{{.Entity.DocumentName}}</strong> has been reviewed and approved.</p>
      <div class="info-box">
        <p><span class="label">Document:</span> {{.Entity.DocumentName}}</p>
        <p><span class="label">Requirement:</span> {{.Entity.RequirementName}}</p>
      </div>
      <p>No further action is needed for this document.</p>
      <a href="{{.Metadata.site_url}}/view/staff_documents/{{.Entity.DocumentId}}" class="button">View Document</a>
      <div class="footer">
        <p>Keep up the great work!</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'DOCUMENT APPROVED
=================================

Hi {{.Entity.StaffName}},

Your document "{{.Entity.DocumentName}}" has been reviewed and approved.

Document: {{.Entity.DocumentName}}
Requirement: {{.Entity.RequirementName}}

No further action is needed for this document.

View Document: {{.Metadata.site_url}}/view/staff_documents/{{.Entity.DocumentId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 3: time_off_submitted
-- Sent to site lead when a staff member submits a time-off request
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'time_off_submitted',
  'Sent to site lead when a staff member creates a new time-off request',

  'Time off request from {{.Entity.StaffName}}',

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
      <h1 style="margin: 0;">New Time Off Request</h1>
    </div>
    <div class="content">
      <div class="alert">
        <strong>Action Required:</strong> Please review this time-off request.
      </div>
      <div class="info-box">
        <p><span class="label">Staff Member:</span> {{.Entity.StaffName}}</p>
        <p><span class="label">Site:</span> {{.Entity.SiteName}}</p>
        <p><span class="label">Start Date:</span> {{.Entity.StartDate}}</p>
        <p><span class="label">End Date:</span> {{.Entity.EndDate}}</p>
        {{if .Entity.Reason}}<p><span class="label">Reason:</span> {{.Entity.Reason}}</p>{{end}}
      </div>
      <a href="{{.Metadata.site_url}}/view/time_off_requests/{{.Entity.RequestId}}" class="button">Review Request</a>
    </div>
  </div>
</body>
</html>',

  'NEW TIME OFF REQUEST
=================================
ACTION REQUIRED: Please review this time-off request.

Staff Member: {{.Entity.StaffName}}
Site: {{.Entity.SiteName}}
Start Date: {{.Entity.StartDate}}
End Date: {{.Entity.EndDate}}
{{if .Entity.Reason}}Reason: {{.Entity.Reason}}{{end}}

Review Request: {{.Metadata.site_url}}/view/time_off_requests/{{.Entity.RequestId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 4: time_off_approved
-- Sent to staff member when their time-off request is approved
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'time_off_approved',
  'Sent to staff member when their time-off request is approved',

  'Time off approved: {{.Entity.StartDate}} - {{.Entity.EndDate}}',

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
      <h1 style="margin: 0;">Time Off Approved</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <div class="success">
        <strong>Your time-off request has been approved.</strong>
      </div>
      <div class="info-box">
        <p><span class="label">Start Date:</span> {{.Entity.StartDate}}</p>
        <p><span class="label">End Date:</span> {{.Entity.EndDate}}</p>
        {{if .Entity.ResponseNotes}}<p><span class="label">Notes:</span> {{.Entity.ResponseNotes}}</p>{{end}}
      </div>
      <a href="{{.Metadata.site_url}}/view/time_off_requests/{{.Entity.RequestId}}" class="button">View Request</a>
      <div class="footer">
        <p>Enjoy your time off!</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'TIME OFF APPROVED
=================================

Hi {{.Entity.StaffName}},

Your time-off request has been approved.

Start Date: {{.Entity.StartDate}}
End Date: {{.Entity.EndDate}}
{{if .Entity.ResponseNotes}}Notes: {{.Entity.ResponseNotes}}{{end}}

View Request: {{.Metadata.site_url}}/view/time_off_requests/{{.Entity.RequestId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 5: time_off_denied
-- Sent to staff member when their time-off request is denied
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'time_off_denied',
  'Sent to staff member when their time-off request is denied',

  'Time off request update: {{.Entity.StartDate}} - {{.Entity.EndDate}}',

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
      <h1 style="margin: 0;">Time Off Request Update</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <p>Unfortunately, your time-off request could not be approved at this time.</p>
      <div class="info-box">
        <p><span class="label">Start Date:</span> {{.Entity.StartDate}}</p>
        <p><span class="label">End Date:</span> {{.Entity.EndDate}}</p>
      </div>
      {{if .Entity.ResponseNotes}}
      <div class="reason-box">
        <p><strong>Response:</strong></p>
        <p>{{.Entity.ResponseNotes}}</p>
      </div>
      {{end}}
      <p>Please speak with your site lead if you have questions.</p>
      <a href="{{.Metadata.site_url}}/view/time_off_requests/{{.Entity.RequestId}}" class="button">View Request</a>
      <div class="footer">
        <p>Contact your site lead or program manager for more information.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'TIME OFF REQUEST UPDATE
=================================

Hi {{.Entity.StaffName}},

Unfortunately, your time-off request could not be approved at this time.

Start Date: {{.Entity.StartDate}}
End Date: {{.Entity.EndDate}}

{{if .Entity.ResponseNotes}}Response: {{.Entity.ResponseNotes}}{{end}}

View Request: {{.Metadata.site_url}}/view/time_off_requests/{{.Entity.RequestId}}

Contact your site lead or program manager for more information.
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 6: reimbursement_submitted
-- Sent to all managers when a new reimbursement request is created
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'reimbursement_submitted',
  'Sent to all managers when a staff member submits a reimbursement request',

  'Reimbursement request from {{.Entity.StaffName}}',

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
      <h1 style="margin: 0;">New Reimbursement Request</h1>
    </div>
    <div class="content">
      <div class="alert">
        <strong>Action Required:</strong> Please review this reimbursement request.
      </div>
      <div class="info-box">
        <p><span class="label">Staff Member:</span> {{.Entity.StaffName}}</p>
        <p><span class="label">Amount:</span> {{.Entity.Amount}}</p>
        <p><span class="label">Description:</span> {{.Entity.Description}}</p>
        <p><span class="label">Has Receipt:</span> {{if .Entity.HasReceipt}}Yes{{else}}No{{end}}</p>
      </div>
      <a href="{{.Metadata.site_url}}/view/reimbursements/{{.Entity.ReimbursementId}}" class="button">Review Request</a>
    </div>
  </div>
</body>
</html>',

  'NEW REIMBURSEMENT REQUEST
=================================
ACTION REQUIRED: Please review this reimbursement request.

Staff Member: {{.Entity.StaffName}}
Amount: {{.Entity.Amount}}
Description: {{.Entity.Description}}
Has Receipt: {{if .Entity.HasReceipt}}Yes{{else}}No{{end}}

Review Request: {{.Metadata.site_url}}/view/reimbursements/{{.Entity.ReimbursementId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 7: reimbursement_approved
-- Sent to staff member when their reimbursement is approved
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'reimbursement_approved',
  'Sent to staff member when their reimbursement is approved',

  'Reimbursement approved: {{.Entity.Amount}}',

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
      <h1 style="margin: 0;">Reimbursement Approved</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <div class="success">
        <strong>Your reimbursement request has been approved.</strong>
      </div>
      <div class="info-box">
        <p><span class="label">Amount:</span> {{.Entity.Amount}}</p>
        <p><span class="label">Description:</span> {{.Entity.Description}}</p>
        {{if .Entity.ResponseNotes}}<p><span class="label">Notes:</span> {{.Entity.ResponseNotes}}</p>{{end}}
      </div>
      <a href="{{.Metadata.site_url}}/view/reimbursements/{{.Entity.ReimbursementId}}" class="button">View Details</a>
      <div class="footer">
        <p>Payment will be processed according to the standard reimbursement schedule.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'REIMBURSEMENT APPROVED
=================================

Hi {{.Entity.StaffName}},

Your reimbursement request has been approved.

Amount: {{.Entity.Amount}}
Description: {{.Entity.Description}}
{{if .Entity.ResponseNotes}}Notes: {{.Entity.ResponseNotes}}{{end}}

View Details: {{.Metadata.site_url}}/view/reimbursements/{{.Entity.ReimbursementId}}

Payment will be processed according to the standard reimbursement schedule.
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 8: reimbursement_denied
-- Sent to staff member when their reimbursement is denied
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'reimbursement_denied',
  'Sent to staff member when their reimbursement is denied',

  'Reimbursement update: {{.Entity.Amount}}',

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
      <h1 style="margin: 0;">Reimbursement Update</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <p>Unfortunately, your reimbursement request could not be approved.</p>
      <div class="info-box">
        <p><span class="label">Amount:</span> {{.Entity.Amount}}</p>
        <p><span class="label">Description:</span> {{.Entity.Description}}</p>
      </div>
      {{if .Entity.ResponseNotes}}
      <div class="reason-box">
        <p><strong>Response:</strong></p>
        <p>{{.Entity.ResponseNotes}}</p>
      </div>
      {{end}}
      <p>Please contact your program manager if you have questions.</p>
      <a href="{{.Metadata.site_url}}/view/reimbursements/{{.Entity.ReimbursementId}}" class="button">View Details</a>
      <div class="footer">
        <p>Contact your program manager for more information.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'REIMBURSEMENT UPDATE
=================================

Hi {{.Entity.StaffName}},

Unfortunately, your reimbursement request could not be approved.

Amount: {{.Entity.Amount}}
Description: {{.Entity.Description}}

{{if .Entity.ResponseNotes}}Response: {{.Entity.ResponseNotes}}{{end}}

View Details: {{.Metadata.site_url}}/view/reimbursements/{{.Entity.ReimbursementId}}

Contact your program manager for more information.
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 9: incident_report_filed
-- Sent to site lead and all managers when an incident report is created
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'incident_report_filed',
  'Sent to site lead and managers when an incident report is filed',

  'Incident report filed at {{.Entity.SiteName}}',

  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #DC2626; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #DC2626; }
    .label { font-weight: bold; color: #1f2937; }
    .alert { background: #FEE2E2; padding: 12px; border-radius: 6px; margin: 15px 0; color: #991B1B; }
    .button { display: inline-block; background: #DC2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">Incident Report Filed</h1>
    </div>
    <div class="content">
      <div class="alert">
        <strong>An incident report has been filed and requires your attention.</strong>
      </div>
      <div class="info-box">
        <p><span class="label">Site:</span> {{.Entity.SiteName}}</p>
        <p><span class="label">Reported By:</span> {{.Entity.ReporterName}}</p>
        <p><span class="label">Date:</span> {{.Entity.IncidentDate}}</p>
        {{if .Entity.IncidentTime}}<p><span class="label">Time:</span> {{.Entity.IncidentTime}}</p>{{end}}
        <p><span class="label">Description:</span> {{.Entity.Description}}</p>
        {{if .Entity.PeopleInvolved}}<p><span class="label">People Involved:</span> {{.Entity.PeopleInvolved}}</p>{{end}}
        {{if .Entity.ActionTaken}}<p><span class="label">Action Taken:</span> {{.Entity.ActionTaken}}</p>{{end}}
        <p><span class="label">Follow-up Needed:</span> {{if .Entity.FollowUpNeeded}}Yes{{else}}No{{end}}</p>
      </div>
      <a href="{{.Metadata.site_url}}/view/incident_reports/{{.Entity.ReportId}}" class="button">View Full Report</a>
    </div>
  </div>
</body>
</html>',

  'INCIDENT REPORT FILED
=================================
An incident report has been filed and requires your attention.

Site: {{.Entity.SiteName}}
Reported By: {{.Entity.ReporterName}}
Date: {{.Entity.IncidentDate}}
{{if .Entity.IncidentTime}}Time: {{.Entity.IncidentTime}}{{end}}
Description: {{.Entity.Description}}
{{if .Entity.PeopleInvolved}}People Involved: {{.Entity.PeopleInvolved}}{{end}}
{{if .Entity.ActionTaken}}Action Taken: {{.Entity.ActionTaken}}{{end}}
Follow-up Needed: {{if .Entity.FollowUpNeeded}}Yes{{else}}No{{end}}

View Full Report: {{.Metadata.site_url}}/view/incident_reports/{{.Entity.ReportId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TEMPLATE 10: onboarding_complete
-- Sent to all managers when a staff member''s onboarding reaches "All Approved"
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template
) VALUES (
  'onboarding_complete',
  'Sent to managers when a staff member completes all onboarding documents',

  '{{.Entity.StaffName}} onboarding complete',

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
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">Onboarding Complete</h1>
    </div>
    <div class="content">
      <div class="success">
        <strong>{{.Entity.StaffName}} has completed all onboarding requirements.</strong>
      </div>
      <div class="info-box">
        <p><span class="label">Staff Member:</span> {{.Entity.StaffName}}</p>
        <p><span class="label">Role:</span> {{.Entity.RoleName}}</p>
        <p><span class="label">Site:</span> {{.Entity.SiteName}}</p>
      </div>
      <p>All required documents have been submitted and approved. This staff member is cleared to begin work.</p>
      <a href="{{.Metadata.site_url}}/view/staff_members/{{.Entity.StaffMemberId}}" class="button">View Staff Profile</a>
    </div>
  </div>
</body>
</html>',

  'ONBOARDING COMPLETE
=================================

{{.Entity.StaffName}} has completed all onboarding requirements.

Staff Member: {{.Entity.StaffName}}
Role: {{.Entity.RoleName}}
Site: {{.Entity.SiteName}}

All required documents have been submitted and approved.
This staff member is cleared to begin work.

View Staff Profile: {{.Metadata.site_url}}/view/staff_members/{{.Entity.StaffMemberId}}
'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- TRIGGER FUNCTIONS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TRIGGER 1 & 2: Document status change notifications
-- Fires on status_id change of staff_documents
-- Sends document_needs_revision or document_approved to the staff member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_document_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_needs_revision_id INT;
  v_approved_id INT;
  v_staff_user_id UUID;
  v_staff_name TEXT;
  v_requirement_name TEXT;
  v_entity_data JSONB;
  v_template TEXT;
BEGIN
  -- Get relevant status IDs
  SELECT id INTO v_needs_revision_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Needs Revision';
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Approved';

  -- Only fire on actual status change
  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  -- Determine which template to use
  IF NEW.status_id = v_needs_revision_id THEN
    v_template := 'document_needs_revision';
  ELSIF NEW.status_id = v_approved_id THEN
    v_template := 'document_approved';
  ELSE
    RETURN NEW;  -- No notification for other status changes
  END IF;

  -- Look up staff member info
  SELECT sm.user_id, sm.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.staff_member_id;

  -- Look up requirement name
  SELECT dr.display_name INTO v_requirement_name
    FROM document_requirements dr
    WHERE dr.id = NEW.requirement_id;

  -- Only send if staff member has a linked user account
  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'DocumentId', NEW.id,
    'DocumentName', NEW.display_name,
    'StaffName', v_staff_name,
    'RequirementName', v_requirement_name,
    'ReviewerNotes', NEW.reviewer_notes
  );

  -- Insert notification
  INSERT INTO metadata.notifications (
    user_id, template_name, entity_type, entity_id, entity_data
  ) VALUES (
    v_staff_user_id,
    v_template,
    'staff_documents',
    NEW.id,
    v_entity_data
  );

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 3: Time off request submitted
-- Fires on INSERT of time_off_requests
-- Sends time_off_submitted to the site lead
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_time_off_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff_name TEXT;
  v_site_id BIGINT;
  v_site_name TEXT;
  v_entity_data JSONB;
  v_lead RECORD;
BEGIN
  -- Look up staff member and site info
  SELECT sm.display_name, sm.site_id, s.display_name
    INTO v_staff_name, v_site_id, v_site_name
    FROM staff_members sm
    JOIN sites s ON s.id = sm.site_id
    WHERE sm.id = NEW.staff_member_id;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'RequestId', NEW.id,
    'StaffName', v_staff_name,
    'SiteName', v_site_name,
    'StartDate', NEW.start_date,
    'EndDate', NEW.end_date,
    'Reason', NEW.reason
  );

  -- Send to site lead
  FOR v_lead IN
    SELECT user_id FROM get_site_lead_email(v_site_id)
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data
    ) VALUES (
      v_lead.user_id,
      'time_off_submitted',
      'time_off_requests',
      NEW.id,
      v_entity_data
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 4 & 5: Time off request approved/denied
-- Fires on status_id change of time_off_requests
-- Sends time_off_approved or time_off_denied to the staff member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_time_off_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_denied_id INT;
  v_staff_user_id UUID;
  v_staff_name TEXT;
  v_entity_data JSONB;
  v_template TEXT;
BEGIN
  -- Get status IDs
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Denied';

  -- Only fire on actual status change
  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  -- Determine template
  IF NEW.status_id = v_approved_id THEN
    v_template := 'time_off_approved';
  ELSIF NEW.status_id = v_denied_id THEN
    v_template := 'time_off_denied';
  ELSE
    RETURN NEW;
  END IF;

  -- Look up staff member
  SELECT sm.user_id, sm.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.staff_member_id;

  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'RequestId', NEW.id,
    'StaffName', v_staff_name,
    'StartDate', NEW.start_date,
    'EndDate', NEW.end_date,
    'ResponseNotes', NEW.response_notes
  );

  INSERT INTO metadata.notifications (
    user_id, template_name, entity_type, entity_id, entity_data
  ) VALUES (
    v_staff_user_id,
    v_template,
    'time_off_requests',
    NEW.id,
    v_entity_data
  );

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 6: Reimbursement submitted
-- Fires on INSERT of reimbursements
-- Sends reimbursement_submitted to all managers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_reimbursement_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff_name TEXT;
  v_entity_data JSONB;
  v_mgr RECORD;
BEGIN
  -- Look up staff member name
  SELECT sm.display_name INTO v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.staff_member_id;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'ReimbursementId', NEW.id,
    'StaffName', v_staff_name,
    'Amount', NEW.amount::TEXT,
    'Description', NEW.description,
    'HasReceipt', (NEW.receipt IS NOT NULL)
  );

  -- Send to all managers
  FOR v_mgr IN
    SELECT DISTINCT user_id FROM get_users_with_role('manager')
    UNION
    SELECT DISTINCT user_id FROM get_users_with_role('admin')
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data
    ) VALUES (
      v_mgr.user_id,
      'reimbursement_submitted',
      'reimbursements',
      NEW.id,
      v_entity_data
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 7 & 8: Reimbursement approved/denied
-- Fires on status_id change of reimbursements
-- Sends reimbursement_approved or reimbursement_denied to staff member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_reimbursement_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_denied_id INT;
  v_staff_user_id UUID;
  v_staff_name TEXT;
  v_entity_data JSONB;
  v_template TEXT;
BEGIN
  -- Get status IDs
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Denied';

  -- Only fire on actual status change
  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  -- Determine template
  IF NEW.status_id = v_approved_id THEN
    v_template := 'reimbursement_approved';
  ELSIF NEW.status_id = v_denied_id THEN
    v_template := 'reimbursement_denied';
  ELSE
    RETURN NEW;
  END IF;

  -- Look up staff member
  SELECT sm.user_id, sm.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.staff_member_id;

  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'ReimbursementId', NEW.id,
    'StaffName', v_staff_name,
    'Amount', NEW.amount::TEXT,
    'Description', NEW.description,
    'ResponseNotes', NEW.response_notes
  );

  INSERT INTO metadata.notifications (
    user_id, template_name, entity_type, entity_id, entity_data
  ) VALUES (
    v_staff_user_id,
    v_template,
    'reimbursements',
    NEW.id,
    v_entity_data
  );

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 9: Incident report filed
-- Fires on INSERT of incident_reports
-- Sends incident_report_filed to site lead + all managers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_incident_report_filed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reporter_name TEXT;
  v_site_name TEXT;
  v_entity_data JSONB;
  v_recipient RECORD;
  v_notified_users UUID[] := '{}';
BEGIN
  -- Look up reporter and site info
  SELECT sm.display_name INTO v_reporter_name
    FROM staff_members sm
    WHERE sm.id = NEW.reported_by_id;

  SELECT s.display_name INTO v_site_name
    FROM sites s
    WHERE s.id = NEW.site_id;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'ReportId', NEW.id,
    'SiteName', v_site_name,
    'ReporterName', v_reporter_name,
    'IncidentDate', NEW.incident_date,
    'IncidentTime', NEW.incident_time,
    'Description', NEW.description,
    'PeopleInvolved', NEW.people_involved,
    'ActionTaken', NEW.action_taken,
    'FollowUpNeeded', NEW.follow_up_needed
  );

  -- Send to site lead (if one exists)
  FOR v_recipient IN
    SELECT user_id FROM get_site_lead_email(NEW.site_id)
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data
    ) VALUES (
      v_recipient.user_id,
      'incident_report_filed',
      'incident_reports',
      NEW.id,
      v_entity_data
    );
    v_notified_users := array_append(v_notified_users, v_recipient.user_id);
  END LOOP;

  -- Send to all managers (avoiding duplicates with site lead)
  FOR v_recipient IN
    SELECT DISTINCT user_id FROM get_users_with_role('manager')
    UNION
    SELECT DISTINCT user_id FROM get_users_with_role('admin')
  LOOP
    IF NOT v_recipient.user_id = ANY(v_notified_users) THEN
      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data
      ) VALUES (
        v_recipient.user_id,
        'incident_report_filed',
        'incident_reports',
        NEW.id,
        v_entity_data
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRIGGER 10: Onboarding complete
-- Fires on UPDATE of onboarding_status_id on staff_members
-- Sends onboarding_complete to all managers when status = 'All Approved'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_onboarding_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_all_approved_id INT;
  v_role_name TEXT;
  v_site_name TEXT;
  v_entity_data JSONB;
  v_mgr RECORD;
BEGIN
  -- Get 'All Approved' status ID
  SELECT id INTO v_all_approved_id FROM metadata.statuses
    WHERE entity_type = 'staff_onboarding' AND display_name = 'All Approved';

  -- Only fire when status changes TO 'All Approved'
  IF NEW.onboarding_status_id = v_all_approved_id
     AND (OLD.onboarding_status_id IS NULL OR OLD.onboarding_status_id != v_all_approved_id) THEN

    -- Look up role and site
    SELECT sr.display_name INTO v_role_name
      FROM staff_roles sr WHERE sr.id = NEW.role_id;
    SELECT s.display_name INTO v_site_name
      FROM sites s WHERE s.id = NEW.site_id;

    -- Build entity data
    v_entity_data := jsonb_build_object(
      'StaffMemberId', NEW.id,
      'StaffName', NEW.display_name,
      'RoleName', v_role_name,
      'SiteName', v_site_name
    );

    -- Send to all managers
    FOR v_mgr IN
      SELECT DISTINCT user_id FROM get_users_with_role('manager')
      UNION
      SELECT DISTINCT user_id FROM get_users_with_role('admin')
    LOOP
      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data
      ) VALUES (
        v_mgr.user_id,
        'onboarding_complete',
        'staff_members',
        NEW.id,
        v_entity_data
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- GRANT EXECUTE ON TRIGGER FUNCTIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION notify_document_status_change TO authenticated;
GRANT EXECUTE ON FUNCTION notify_time_off_submitted TO authenticated;
GRANT EXECUTE ON FUNCTION notify_time_off_status_change TO authenticated;
GRANT EXECUTE ON FUNCTION notify_reimbursement_submitted TO authenticated;
GRANT EXECUTE ON FUNCTION notify_reimbursement_status_change TO authenticated;
GRANT EXECUTE ON FUNCTION notify_incident_report_filed TO authenticated;
GRANT EXECUTE ON FUNCTION notify_onboarding_complete TO authenticated;

-- ============================================================================
-- DATABASE TRIGGERS
-- ============================================================================

-- Document status changes (covers needs_revision + approved)
CREATE TRIGGER trg_notify_document_status_change
  AFTER UPDATE OF status_id ON staff_documents
  FOR EACH ROW
  EXECUTE FUNCTION notify_document_status_change();

-- Time off request submitted
CREATE TRIGGER trg_notify_time_off_submitted
  AFTER INSERT ON time_off_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_time_off_submitted();

-- Time off request approved/denied
CREATE TRIGGER trg_notify_time_off_status_change
  AFTER UPDATE OF status_id ON time_off_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_time_off_status_change();

-- Reimbursement submitted
CREATE TRIGGER trg_notify_reimbursement_submitted
  AFTER INSERT ON reimbursements
  FOR EACH ROW
  EXECUTE FUNCTION notify_reimbursement_submitted();

-- Reimbursement approved/denied
CREATE TRIGGER trg_notify_reimbursement_status_change
  AFTER UPDATE OF status_id ON reimbursements
  FOR EACH ROW
  EXECUTE FUNCTION notify_reimbursement_status_change();

-- Incident report filed
CREATE TRIGGER trg_notify_incident_report_filed
  AFTER INSERT ON incident_reports
  FOR EACH ROW
  EXECUTE FUNCTION notify_incident_report_filed();

-- Onboarding complete
CREATE TRIGGER trg_notify_onboarding_complete
  AFTER UPDATE OF onboarding_status_id ON staff_members
  FOR EACH ROW
  EXECUTE FUNCTION notify_onboarding_complete();

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
