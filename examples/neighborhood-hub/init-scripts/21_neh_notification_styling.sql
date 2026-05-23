-- Neighborhood Engagement Hub - Style notification email templates
-- Adds colored headers, structured details, and button CTAs to match
-- the Mott Park template style. Also ensures text_template fallbacks
-- include view links where appropriate. No logic changes.
BEGIN;

-- ============================================================================
-- Borrower Templates
-- ============================================================================

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #16a34a;">Account Approved</h2>
    <p>Your borrower account has been approved! You can now reserve tools from the Neighborhood Engagement Hub.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/guided-form/tool_reservation"
         style="display: inline-block; background-color: #16a34a; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        Reserve Tools
      </a>
    </p>
  </div>',
    text_template = 'Your borrower account has been approved! You can now reserve tools from the Neighborhood Engagement Hub.

Reserve tools: {{.Metadata.site_url}}/guided-form/tool_reservation'
WHERE name = 'borrower_approved';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #EF4444;">Account Not Approved</h2>
    <p>Your borrower account application has not been approved at this time.</p>
    <p>Please contact NEH staff for more information.</p>
  </div>'
WHERE name = 'borrower_rejected';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #EF4444;">Account Suspended</h2>
    <p>Your borrower account has been suspended. Please contact NEH staff for more information.</p>
  </div>'
WHERE name = 'borrower_barred';

-- ============================================================================
-- Tool Reservation Templates
-- ============================================================================

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #2563eb;">New Tool Reservation</h2>
    <p><strong>Borrower:</strong> {{.Entity.borrower_display_name}}</p>
    <p><strong>Tools:</strong> {{.Entity.tools_summary}}</p>
    <p><strong>Time:</strong> {{formatTimeSlot .Entity.timeslot}}</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        Review Request
      </a>
    </p>
  </div>',
    text_template = 'A new tool reservation has been submitted.

Borrower: {{.Entity.borrower_display_name}}
Tools: {{.Entity.tools_summary}}
Time: {{formatTimeSlot .Entity.timeslot}}

Review request: {{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}'
WHERE name = 'tool_reservation_submitted';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #16a34a;">Reservation Approved</h2>
    <p>Your tool reservation on <strong>{{formatTimeSlot .Entity.timeslot}}</strong> has been approved!</p>
    <h3 style="color: #374151; margin-top: 20px;">Tools Reserved</h3>
    <ul style="color: #374151;">{{range .Entity.tools}}<li>{{.name}}</li>{{end}}</ul>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}"
         style="display: inline-block; background-color: #16a34a; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        View Reservation
      </a>
    </p>
  </div>',
    text_template = 'Your tool reservation on {{formatTimeSlot .Entity.timeslot}} has been approved!

Tools reserved:
{{range .Entity.tools}}- {{.name}}
{{end}}
View your reservation: {{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}'
WHERE name = 'tool_reservation_approved';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #EF4444;">Reservation Denied</h2>
    <p>Your tool reservation for <strong>{{.Entity.tools_summary}}</strong> on <strong>{{formatTimeSlot .Entity.timeslot}}</strong> has been denied.</p>
    <p>Please contact NEH staff if you have questions.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}"
         style="display: inline-block; background-color: #6B7280; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        View Details
      </a>
    </p>
  </div>',
    text_template = 'Your tool reservation for {{.Entity.tools_summary}} on {{formatTimeSlot .Entity.timeslot}} has been denied.

Please contact NEH staff if you have questions.

View details: {{.Metadata.site_url}}/view/tool_reservations/{{.Entity.id}}'
WHERE name = 'tool_reservation_denied';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #2563eb;">Tools Checked Out</h2>
    <p>Your tools have been checked out for your reservation on <strong>{{formatTimeSlot .Entity.timeslot}}</strong>.</p>
    <p><strong>Tools:</strong> {{.Entity.tools_summary}}</p>
    <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">Please return all items by the end of your reservation window.</p>
  </div>',
    text_template = 'Your tools have been checked out for your reservation on {{formatTimeSlot .Entity.timeslot}}.

Tools: {{.Entity.tools_summary}}

Please return all items by the end of your reservation window.'
WHERE name = 'tool_reservation_checked_out';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #16a34a;">Tools Returned</h2>
    <p>Thank you for returning <strong>{{.Entity.tools_summary}}</strong> from your reservation on <strong>{{formatTimeSlot .Entity.timeslot}}</strong>.</p>
    <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">We hope the tools were helpful for your project!</p>
  </div>',
    text_template = 'Thank you for returning {{.Entity.tools_summary}} from your reservation on {{formatTimeSlot .Entity.timeslot}}.

We hope the tools were helpful for your project!'
WHERE name = 'tool_reservation_returned';

-- ============================================================================
-- Building Use Request Templates
-- ============================================================================

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #2563eb;">New Building Use Request</h2>
    <p><strong>Contact:</strong> {{.Entity.contact_name}}</p>
    <p><strong>Group:</strong> {{.Entity.group_name}}</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        Review Request
      </a>
    </p>
  </div>',
    text_template = 'A new building use request has been submitted.

Contact: {{.Entity.contact_name}}
Group: {{.Entity.group_name}}

Review request: {{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}'
WHERE name = 'building_use_request_submitted';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #16a34a;">Building Use Approved</h2>
    <p>Your building use request for <strong>{{.Entity.group_name}}</strong> has been approved.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #16a34a; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        View Request
      </a>
    </p>
  </div>',
    text_template = 'Your building use request for {{.Entity.group_name}} has been approved.

View request: {{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}'
WHERE name = 'building_use_request_approved';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #EF4444;">Building Use Denied</h2>
    <p>Your building use request for <strong>{{.Entity.group_name}}</strong> has been denied.</p>
    <p>Please contact NEH staff if you have questions.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #6B7280; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        View Details
      </a>
    </p>
  </div>',
    text_template = 'Your building use request for {{.Entity.group_name}} has been denied.

Please contact NEH staff if you have questions.

View details: {{.Metadata.site_url}}/view/building_use_requests/{{.Entity.id}}'
WHERE name = 'building_use_request_denied';

-- ============================================================================
-- MEK Request Templates
-- ============================================================================

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #2563eb;">New Event Kit Request</h2>
    <p><strong>Borrower:</strong> {{.Entity.borrower_display_name}}</p>
    <p><strong>Pickup Date:</strong> {{.Entity.pickup_date}}</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/mek_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        Review Request
      </a>
    </p>
  </div>',
    text_template = 'A new event kit request has been submitted.

Borrower: {{.Entity.borrower_display_name}}
Pickup Date: {{.Entity.pickup_date}}

Review request: {{.Metadata.site_url}}/view/mek_requests/{{.Entity.id}}'
WHERE name = 'mek_request_submitted';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #16a34a;">Event Kit Approved</h2>
    <p>Your event kit request for pickup on <strong>{{.Entity.pickup_date}}</strong> has been approved.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/mek_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #16a34a; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        View Request
      </a>
    </p>
  </div>',
    text_template = 'Your event kit request for pickup on {{.Entity.pickup_date}} has been approved.

View request: {{.Metadata.site_url}}/view/mek_requests/{{.Entity.id}}'
WHERE name = 'mek_request_approved';

UPDATE metadata.notification_templates
SET html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #EF4444;">Event Kit Request Denied</h2>
    <p>Your event kit request for pickup on <strong>{{.Entity.pickup_date}}</strong> has been denied.</p>
    <p>Please contact NEH staff if you have questions.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="{{.Metadata.site_url}}/view/mek_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #6B7280; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        View Details
      </a>
    </p>
  </div>',
    text_template = 'Your event kit request for pickup on {{.Entity.pickup_date}} has been denied.

Please contact NEH staff if you have questions.

View details: {{.Metadata.site_url}}/view/mek_requests/{{.Entity.id}}'
WHERE name = 'mek_request_denied';

COMMIT;
