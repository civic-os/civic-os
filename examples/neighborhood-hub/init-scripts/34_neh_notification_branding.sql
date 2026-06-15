-- ============================================================================
-- NEH Script 34: Add NEH branding to all notification templates
-- ============================================================================
-- All email notifications now reference "Neighborhood Engagement Hub" via:
--   1. Subject lines prefixed with "NEH:" for instant recognition in inbox
--   2. HTML footer with address, phone, and website
--   3. Text template footer with same info
-- ============================================================================
BEGIN;

-- ============================================================================
-- Subject lines: prefix all with "NEH:" for inbox recognition
-- ============================================================================

UPDATE metadata.notification_templates SET subject_template = 'NEH: New Tool Reservation Request' WHERE name = 'tool_reservation_submitted';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Tool Reservation Approved' WHERE name = 'tool_reservation_approved';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Tool Reservation Denied' WHERE name = 'tool_reservation_denied';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Tools Checked Out' WHERE name = 'tool_reservation_checked_out';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Tools Returned' WHERE name = 'tool_reservation_returned';
UPDATE metadata.notification_templates SET subject_template = 'NEH: New Building Use Request' WHERE name = 'building_use_request_submitted';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Building Use Request Approved' WHERE name = 'building_use_request_approved';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Building Use Request Denied' WHERE name = 'building_use_request_denied';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Borrower Account Approved' WHERE name = 'borrower_approved';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Borrower Account Not Approved' WHERE name = 'borrower_rejected';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Borrower Account Suspended' WHERE name = 'borrower_barred';
UPDATE metadata.notification_templates SET subject_template = 'NEH: New Event Kit Request' WHERE name = 'mek_request_submitted';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Event Kit Request Approved' WHERE name = 'mek_request_approved';
UPDATE metadata.notification_templates SET subject_template = 'NEH: Event Kit Request Denied' WHERE name = 'mek_request_denied';


-- ============================================================================
-- HTML templates: add footer with NEH contact info
-- ============================================================================
-- The footer is appended before the closing </div> of each template.
-- Pattern: replace '</div>' at the end with footer + '</div>'

UPDATE metadata.notification_templates
SET html_template = regexp_replace(
    html_template,
    '</div>\s*$',
    '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;">
    <p style="color: #6b7280; font-size: 12px; text-align: center; line-height: 1.6;">
      <strong>Neighborhood Engagement Hub</strong><br>
      3216 Martin Luther King Ave, Flint, MI 48505<br>
      (810) 214-0186 · <a href="https://nehflint.org" style="color: #2563eb; text-decoration: none;">nehflint.org</a>
    </p>
  </div>'
)
WHERE name IN (
    'tool_reservation_submitted',
    'tool_reservation_approved',
    'tool_reservation_denied',
    'tool_reservation_checked_out',
    'tool_reservation_returned',
    'building_use_request_submitted',
    'building_use_request_approved',
    'building_use_request_denied',
    'borrower_approved',
    'borrower_rejected',
    'borrower_barred',
    'mek_request_submitted',
    'mek_request_approved',
    'mek_request_denied'
);


-- ============================================================================
-- Text templates: add footer line
-- ============================================================================

UPDATE metadata.notification_templates
SET text_template = text_template || '

---
Neighborhood Engagement Hub
3216 Martin Luther King Ave, Flint, MI 48505
(810) 214-0186 | nehflint.org'
WHERE name IN (
    'tool_reservation_submitted',
    'tool_reservation_approved',
    'tool_reservation_denied',
    'tool_reservation_checked_out',
    'tool_reservation_returned',
    'building_use_request_submitted',
    'building_use_request_approved',
    'building_use_request_denied',
    'borrower_approved',
    'borrower_rejected',
    'borrower_barred',
    'mek_request_submitted',
    'mek_request_approved',
    'mek_request_denied'
);


-- ============================================================================
-- SMS templates: prefix with "NEH:" where they exist
-- ============================================================================

UPDATE metadata.notification_templates
SET sms_template = 'NEH: ' || sms_template
WHERE sms_template IS NOT NULL
  AND sms_template NOT LIKE 'NEH:%'
  AND name IN (
    'tool_reservation_approved',
    'tool_reservation_denied',
    'tool_reservation_checked_out',
    'borrower_approved',
    'borrower_rejected',
    'borrower_barred',
    'mek_request_approved',
    'mek_request_denied'
);

COMMIT;
