-- =====================================================
-- ECS Welcome Email - Branded Template
-- =====================================================
-- Replaces generic "Welcome!" email with ECS-branded
-- welcome that matches the referral/survey email style.
-- Also adds ECS footer to referral and survey templates.

BEGIN;

-- =====================================================
-- 1. Welcome email: full ECS branding
-- =====================================================

UPDATE metadata.notification_templates
SET
  subject_template = 'Welcome to {{.Metadata.site_name}}: Your Account is Ready',

  html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <div style="background-color: #2563eb; padding: 24px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Exemplary Community Services</h1>
    </div>
    <div style="padding: 24px;">
        <p style="font-size: 16px; color: #1f2937;">Hi {{.Entity.first_name}},</p>
        <p style="font-size: 16px; color: #1f2937;">You have been invited{{if .Entity.invited_by}} by {{.Entity.invited_by}}{{end}} to join the ECS client intake and referral system. Your account is ready to use.</p>
        <div style="background-color: #f0f9ff; border-left: 4px solid #2563eb; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 8px 0; color: #1e40af;"><strong>Account Details</strong></p>
            <p style="margin: 4px 0; color: #374151;"><strong>Email:</strong> {{.Entity.email}}</p>
            {{if .Entity.phone}}<p style="margin: 4px 0; color: #374151;"><strong>Phone:</strong> {{.Entity.phone}}</p>{{end}}
        </div>
        <p style="font-size: 16px; color: #1f2937;">Click the button below to sign in and get started:</p>
        <p style="text-align: center; margin: 28px 0;">
            <a href="{{.Metadata.site_url}}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">Sign In</a>
        </p>
        <p style="font-size: 14px; color: #6b7280;">If the button doesn''t work, copy and paste this link into your browser:</p>
        <p style="font-size: 14px; color: #2563eb; word-break: break-all;">{{.Metadata.site_url}}</p>
    </div>
    <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
        <p style="color: #6b7280; font-size: 13px; margin: 0 0 4px 0;"><strong>Exemplary Community Services</strong></p>
        <p style="color: #9ca3af; font-size: 12px; margin: 0 0 4px 0;">123 Main St., Suite 100, Anytown, US 00000</p>
        <p style="color: #9ca3af; font-size: 12px; margin: 0 0 4px 0;">(555) 555-0100 · <a href="https://example.org" style="color: #9ca3af;">example.org</a></p>
        <p style="color: #9ca3af; font-size: 11px; margin: 8px 0 0 0;">If you did not expect this invitation, you can safely ignore this email.</p>
    </div>
</div>',

  text_template = 'Exemplary Community Services

Hi {{.Entity.first_name}},

You have been invited{{if .Entity.invited_by}} by {{.Entity.invited_by}}{{end}} to join the ECS client intake and referral system. Your account is ready to use.

Account Details:
  Email: {{.Entity.email}}
{{if .Entity.phone}}  Phone: {{.Entity.phone}}
{{end}}
Sign in at: {{.Metadata.site_url}}

---
Exemplary Community Services
123 Main St., Suite 100, Anytown, US 00000
(555) 555-0100 · example.org

If you did not expect this invitation, you can safely ignore this email.'

WHERE name = 'user_welcome';


-- =====================================================
-- 2. Referral email: add ECS footer
-- =====================================================

UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #2563eb;">New Referral Created</h2>
    <p>A referral has been created connecting <strong>{{.Entity.client_name}}</strong>
       with <strong>{{.Entity.partner_name}}</strong>.</p>

    <div style="background-color: #f3f4f6; border-left: 4px solid #2563eb; padding: 16px; margin: 16px 0;">
      <p><strong>Referral Type:</strong> {{.Entity.referral_type}}</p>
      <p><strong>Date:</strong> {{.Entity.referral_date}}</p>
      <p><strong>Service Categories:</strong> {{.Entity.service_categories}}</p>
    </div>

    <h3 style="color: #374151;">Partner Contact Information</h3>
    <div style="background-color: #f9fafb; padding: 16px; margin: 16px 0; border-radius: 8px;">
      <p><strong>Organization:</strong> {{.Entity.partner_name}}</p>
      {{if .Metadata.partner_contact}}<p><strong>Contact:</strong> {{.Entity.partner_contact}}</p>{{end}}
      {{if .Metadata.partner_email}}<p><strong>Email:</strong> {{.Entity.partner_email}}</p>{{end}}
      {{if .Metadata.partner_phone}}<p><strong>Phone:</strong> {{.Entity.partner_phone}}</p>{{end}}
      {{if .Metadata.partner_address}}<p><strong>Address:</strong> {{.Entity.partner_address}}</p>{{end}}
      {{if .Metadata.partner_website}}<p><strong>Website:</strong> {{.Entity.partner_website}}</p>{{end}}
    </div>

    <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb; margin-top: 24px;">
      <p style="color: #6b7280; font-size: 13px; margin: 0 0 4px 0;"><strong>Exemplary Community Services</strong></p>
      <p style="color: #9ca3af; font-size: 12px; margin: 0 0 4px 0;">123 Main St., Suite 100, Anytown, US 00000</p>
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">(555) 555-0100 · <a href="https://example.org" style="color: #9ca3af;">example.org</a></p>
    </div>
  </div>',

  text_template = 'New Referral Created

Client: {{.Entity.client_name}}
Partner: {{.Entity.partner_name}}
Type: {{.Entity.referral_type}}
Date: {{.Entity.referral_date}}
Services: {{.Entity.service_categories}}

Partner Contact:
{{if .Metadata.partner_contact}}Contact: {{.Entity.partner_contact}}{{end}}
{{if .Metadata.partner_email}}Email: {{.Entity.partner_email}}{{end}}
{{if .Metadata.partner_phone}}Phone: {{.Entity.partner_phone}}{{end}}
{{if .Metadata.partner_address}}Address: {{.Entity.partner_address}}{{end}}
{{if .Metadata.partner_website}}Website: {{.Entity.partner_website}}{{end}}

---
Exemplary Community Services
123 Main St., Suite 100, Anytown, US 00000
(555) 555-0100 · example.org'

WHERE name = 'referral_created';


-- =====================================================
-- 3. Survey reminder: add ECS footer
-- =====================================================

UPDATE metadata.notification_templates
SET
  html_template = '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #2563eb;">Follow-Up Survey Reminder</h2>
    <p>Hello {{.Entity.client_name}},</p>
    <p>We would like to hear about your experience with your recent referral
       to <strong>{{.Entity.partner_name}}</strong>.</p>
    <p>Please take a moment to complete a brief survey about your experience.
       Your feedback helps us improve our services.</p>
    <div style="margin: 24px 0;">
      <p><strong>Referral Date:</strong> {{.Entity.referral_date}}</p>
      <p><strong>Partner:</strong> {{.Entity.partner_name}}</p>
      <p><strong>Services:</strong> {{.Entity.service_categories}}</p>
    </div>
    <div style="margin: 24px 0;">
      <a href="{{.Metadata.site_url}}/edit/follow_up_surveys/{{.Entity.survey_id}}"
         style="display: inline-block; background-color: #2563eb; color: #ffffff;
                padding: 12px 24px; text-decoration: none; border-radius: 6px;
                font-weight: bold;">
        Complete Survey
      </a>
    </div>

    <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb; margin-top: 24px;">
      <p style="color: #6b7280; font-size: 13px; margin: 0 0 4px 0;"><strong>Exemplary Community Services</strong></p>
      <p style="color: #9ca3af; font-size: 12px; margin: 0 0 4px 0;">123 Main St., Suite 100, Anytown, US 00000</p>
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">(555) 555-0100 · <a href="https://example.org" style="color: #9ca3af;">example.org</a></p>
    </div>
  </div>',

  text_template = 'Follow-Up Survey Reminder

Hello {{.Entity.client_name}},

We would like to hear about your experience with your recent referral to {{.Entity.partner_name}}.

Referral Date: {{.Entity.referral_date}}
Partner: {{.Entity.partner_name}}
Services: {{.Entity.service_categories}}

Complete your survey here: {{.Metadata.site_url}}/edit/follow_up_surveys/{{.Entity.survey_id}}

---
Exemplary Community Services
123 Main St., Suite 100, Anytown, US 00000
(555) 555-0100 · example.org'

WHERE name = 'survey_reminder';


COMMIT;
