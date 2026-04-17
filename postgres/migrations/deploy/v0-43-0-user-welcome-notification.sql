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
    'Welcome notification sent when an admin invites a new user via the User Management page. Replaces the Keycloak "set password" email. Template variables: Entity.first_name, Entity.display_name, Entity.email, Entity.phone, Entity.invited_by; Metadata.site_url, Metadata.site_name.',
    NULL,  -- user-lifecycle notification, not entity-specific
    -- Subject
    'Welcome to {{.Metadata.site_name}} - You''re Invited!',
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
            {{if .Entity.phone}}<p style="margin: 4px 0; color: #374151;"><strong>Phone:</strong> {{.Entity.phone}}</p>{{end}}
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
{{if .Entity.phone}}  Phone: {{.Entity.phone}}
{{end}}
Sign in at: {{.Metadata.site_url}}

---
This is an automated notification. If you did not expect this invitation, you can safely ignore this email.',
    -- SMS Template
    'Welcome, {{.Entity.first_name}}! You''ve been invited. Sign in at {{.Metadata.site_url}}'
)
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    subject_template = EXCLUDED.subject_template,
    html_template = EXCLUDED.html_template,
    text_template = EXCLUDED.text_template,
    sms_template = EXCLUDED.sms_template;

-- ============================================================================
-- 2. Update column comment to document new behavior
-- ============================================================================

COMMENT ON COLUMN metadata.user_provisioning.send_welcome_email IS
    'When true, the Go worker sends a Civic OS welcome notification (template: user_welcome) '
    'instead of the Keycloak "set password" email. The notification links to the site login page '
    'where users can sign in via social login or password. Changed in v0.43.0.';

-- ============================================================================
-- 3. Add send_welcome_sms column for separate SMS opt-in
-- ============================================================================

ALTER TABLE metadata.user_provisioning
    ADD COLUMN send_welcome_sms BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN metadata.user_provisioning.send_welcome_sms IS
    'When true, the Go worker includes SMS in the welcome notification channels. '
    'Separate from send_welcome_email so admins can opt into SMS independently. Added in v0.43.0.';

-- ============================================================================
-- 4. Replace create_provisioned_user() — drop old 6-param signature, create
--    new 7-param version with send_welcome_sms. Only one UI version runs at
--    a time so we don't need to keep both overloads.
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_provisioned_user(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN);

CREATE OR REPLACE FUNCTION public.create_provisioned_user(
    p_email TEXT,
    p_first_name TEXT,
    p_last_name TEXT,
    p_phone TEXT DEFAULT NULL,
    p_initial_roles TEXT[] DEFAULT ARRAY['user'],
    p_send_welcome_email BOOLEAN DEFAULT true,
    p_send_welcome_sms BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_role_name TEXT;
    v_provision_id BIGINT;
    v_initial_roles TEXT[];
BEGIN
    IF NOT metadata.has_permission('civic_os_users_private', 'create') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    v_initial_roles := COALESCE(p_initial_roles, ARRAY['user']);
    IF array_length(v_initial_roles, 1) IS NULL THEN
        v_initial_roles := ARRAY['user'];
    END IF;

    -- Validate each role by role_key
    FOREACH v_role_name IN ARRAY v_initial_roles LOOP
        IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE role_key = v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Role "%s" does not exist', v_role_name));
        END IF;

        IF NOT can_manage_role(v_role_name) THEN
            RETURN json_build_object('success', false, 'error', format('Your role cannot assign the "%s" role', v_role_name));
        END IF;
    END LOOP;

    INSERT INTO metadata.user_provisioning (
        email, first_name, last_name, phone,
        initial_roles, send_welcome_email, send_welcome_sms,
        status, requested_by
    ) VALUES (
        p_email::email_address,
        p_first_name,
        p_last_name,
        p_phone::phone_number,
        v_initial_roles,
        COALESCE(p_send_welcome_email, true),
        COALESCE(p_send_welcome_sms, false),
        'pending',
        current_user_id()
    )
    RETURNING id INTO v_provision_id;

    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'provision_keycloak_user',
        jsonb_build_object('provision_id', v_provision_id),
        'user_provisioning',
        1,
        5,
        NOW(),
        'available'
    );

    RETURN json_build_object('success', true, 'provision_id', v_provision_id);
END;
$$;

-- ============================================================================
-- 5. Update bulk_provision_users() to pass send_welcome_sms from JSON
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bulk_provision_users(
    p_users JSON
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_user JSON;
    v_index INT := 0;
    v_created_count INT := 0;
    v_error_count INT := 0;
    v_errors JSON[] := ARRAY[]::JSON[];
    v_role_name TEXT;
    v_initial_roles TEXT[];
    v_provision_id BIGINT;
    v_email TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
    v_phone TEXT;
    v_send_welcome_email BOOLEAN;
    v_send_welcome_sms BOOLEAN;
BEGIN
    IF NOT metadata.has_permission('civic_os_users_private', 'create') THEN
        RETURN json_build_object('success', false, 'error', 'Permission denied');
    END IF;

    FOR v_user IN SELECT * FROM json_array_elements(p_users)
    LOOP
        v_index := v_index + 1;
        v_email := v_user->>'email';
        v_first_name := v_user->>'first_name';
        v_last_name := v_user->>'last_name';
        v_phone := v_user->>'phone';
        v_send_welcome_email := COALESCE((v_user->>'send_welcome_email')::BOOLEAN, true);
        v_send_welcome_sms := COALESCE((v_user->>'send_welcome_sms')::BOOLEAN, false);

        IF v_user->'initial_roles' IS NOT NULL AND v_user->>'initial_roles' != 'null' THEN
            SELECT array_agg(r::TEXT) INTO v_initial_roles
            FROM json_array_elements_text(v_user->'initial_roles') r;
        ELSE
            v_initial_roles := ARRAY['user'];
        END IF;

        IF array_length(v_initial_roles, 1) IS NULL THEN
            v_initial_roles := ARRAY['user'];
        END IF;

        BEGIN
            -- Validate roles by role_key
            FOREACH v_role_name IN ARRAY v_initial_roles LOOP
                IF NOT EXISTS (SELECT 1 FROM metadata.roles WHERE role_key = v_role_name) THEN
                    RAISE EXCEPTION 'Role "%" does not exist', v_role_name;
                END IF;
                IF NOT can_manage_role(v_role_name) THEN
                    RAISE EXCEPTION 'Your role cannot assign the "%" role', v_role_name;
                END IF;
            END LOOP;

            INSERT INTO metadata.user_provisioning (
                email, first_name, last_name, phone,
                initial_roles, send_welcome_email, send_welcome_sms,
                status, requested_by
            ) VALUES (
                v_email::email_address,
                v_first_name,
                v_last_name,
                v_phone::phone_number,
                v_initial_roles,
                v_send_welcome_email,
                v_send_welcome_sms,
                'pending',
                current_user_id()
            )
            RETURNING id INTO v_provision_id;

            INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
            VALUES (
                'provision_keycloak_user',
                jsonb_build_object('provision_id', v_provision_id),
                'user_provisioning',
                1,
                5,
                NOW(),
                'available'
            );

            v_created_count := v_created_count + 1;
        EXCEPTION WHEN OTHERS THEN
            v_error_count := v_error_count + 1;
            v_errors := array_append(v_errors, json_build_object(
                'index', v_index,
                'email', v_email,
                'error', SQLERRM
            ));
        END;
    END LOOP;

    RETURN json_build_object(
        'success', v_error_count = 0,
        'created_count', v_created_count,
        'error_count', v_error_count,
        'errors', COALESCE(array_to_json(v_errors), '[]'::JSON)
    );
END;
$$;

-- ============================================================================
-- Done
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
