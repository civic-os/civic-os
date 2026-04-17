-- Deploy civic_os:v0-43-0-user-welcome-notification to pg
--
-- Replace Keycloak "set password" email with Civic OS welcome notification.
-- This template is used by the Go worker when send_welcome_email=true during
-- user provisioning. It links to the login page (where social login buttons
-- are visible) instead of a Keycloak password-reset flow.
--
-- The template ships text-only (no staticAsset calls) so it works on
-- deployments without S3. Integrators can customize via SQL UPDATE.

BEGIN;

-- ============================================================================
-- 1. INSERT user_welcome notification template
-- ============================================================================

INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template,
    sms_template
) VALUES (
    'user_welcome',
    'Welcome notification sent when an admin invites a new user via the User Management page. Replaces the Keycloak "set password" email. Template variables: Entity.first_name, Entity.display_name, Entity.email, Entity.roles, Entity.invited_by; Metadata.site_url, Metadata.site_name.',
    NULL,  -- user-lifecycle notification, not entity-specific
    -- Subject
    'Welcome to {{.Metadata.site_name}} — You''re Invited!',
    -- HTML Template
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <div style="background-color: #3B82F6; padding: 24px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Welcome!</h1>
    </div>
    <div style="padding: 24px;">
        <p style="font-size: 16px; color: #1f2937;">Hi {{.Entity.first_name}},</p>
        <p style="font-size: 16px; color: #1f2937;">You have been invited{{if .Entity.invited_by}} by {{.Entity.invited_by}}{{end}} to join the team. Your account is ready to use.</p>
        <div style="background-color: #f0f9ff; border-left: 4px solid #3B82F6; padding: 16px; margin: 20px 0;">
            <p style="margin: 0 0 8px 0; color: #1e40af;"><strong>Account Details</strong></p>
            <p style="margin: 4px 0; color: #374151;"><strong>Email:</strong> {{.Entity.email}}</p>
            {{if .Entity.roles}}<p style="margin: 4px 0; color: #374151;"><strong>Roles:</strong> {{.Entity.roles}}</p>{{end}}
        </div>
        <p style="font-size: 16px; color: #1f2937;">Click the button below to sign in and get started:</p>
        <p style="text-align: center; margin: 28px 0;">
            <a href="{{.Metadata.site_url}}" style="display: inline-block; background-color: #3B82F6; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">Sign In</a>
        </p>
        <p style="font-size: 14px; color: #6b7280;">If the button doesn''t work, copy and paste this link into your browser:</p>
        <p style="font-size: 14px; color: #3B82F6; word-break: break-all;">{{.Metadata.site_url}}</p>
    </div>
    <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">This is an automated notification. If you did not expect this invitation, you can safely ignore this email.</p>
    </div>
</div>',
    -- Text Template
    'Welcome!

Hi {{.Entity.first_name}},

You have been invited{{if .Entity.invited_by}} by {{.Entity.invited_by}}{{end}} to join the team. Your account is ready to use.

Account Details:
  Email: {{.Entity.email}}
{{if .Entity.roles}}  Roles: {{.Entity.roles}}
{{end}}
Sign in at: {{.Metadata.site_url}}

---
This is an automated notification. If you did not expect this invitation, you can safely ignore this email.',
    -- SMS Template
    'Welcome, {{.Entity.first_name}}! You''ve been invited. Sign in at {{.Metadata.site_url}}'
)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- 2. Update column comment to document new behavior
-- ============================================================================

COMMENT ON COLUMN metadata.user_provisioning.send_welcome_email IS
    'When true, the Go worker sends a Civic OS welcome notification (template: user_welcome) '
    'instead of the Keycloak "set password" email. The notification links to the site login page '
    'where users can sign in via social login or password. Changed in v0.43.0.';

-- ============================================================================
-- Done
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
