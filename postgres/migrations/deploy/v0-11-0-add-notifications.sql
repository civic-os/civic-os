-- Deploy civic_os:v0-11-0-add-notifications to pg
-- Notification System with multi-channel delivery, template management, and River queue integration
-- Version: 0.11.0

BEGIN;

-- ===========================================================================
-- Notification Templates Table
-- ===========================================================================
-- Stores reusable notification templates with multiple format variants
-- Templates use Go template syntax with context: {Entity, Metadata}

CREATE TABLE metadata.notification_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,  -- e.g., "issue_created", "appointment_reminder"
    description TEXT,

    -- Template variants (Go template syntax)
    subject_template TEXT NOT NULL,     -- Email subject line
    html_template TEXT NOT NULL,        -- HTML email body
    text_template TEXT NOT NULL,        -- Plain text email body
    sms_template TEXT,                  -- SMS message (160 char limit, Phase 2)

    -- Metadata
    entity_type VARCHAR(100),           -- Expected entity type (documentation only, not enforced)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_templates_name ON metadata.notification_templates(name);

COMMENT ON TABLE metadata.notification_templates IS
    'Notification templates with HTML/Text/SMS variants. Templates use Go template syntax with context: {User, Entity, Metadata}.';
COMMENT ON COLUMN metadata.notification_templates.entity_type IS
    'Expected entity type for this template (e.g., "issues"). Documentation only - not enforced.';
COMMENT ON COLUMN metadata.notification_templates.subject_template IS
    'Email subject template. Uses Go text/template syntax. Example: "New issue: {{.Entity.display_name}}"';
COMMENT ON COLUMN metadata.notification_templates.html_template IS
    'HTML email body template. Uses Go html/template with XSS protection. Example: "<h2>Issue</h2><p>{{.Entity.description}}</p>"';
COMMENT ON COLUMN metadata.notification_templates.text_template IS
    'Plain text email body template. Uses Go text/template syntax. Fallback for non-HTML email clients.';
COMMENT ON COLUMN metadata.notification_templates.sms_template IS
    'SMS message template (Phase 2). 160 character limit enforced by worker.';


-- ===========================================================================
-- Notification Preferences Table
-- ===========================================================================
-- Per-user notification channel preferences

CREATE TABLE metadata.notification_preferences (
    user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
    channel VARCHAR(20) NOT NULL,  -- 'email', 'sms'
    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Contact information
    email_address email_address,   -- Override user's primary email
    phone_number phone_number,      -- For SMS (Phase 2)

    -- Future: Per-template preferences
    -- disabled_templates TEXT[],  -- Array of template names to suppress

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, channel),
    CONSTRAINT valid_channel CHECK (channel IN ('email', 'sms'))
);

CREATE INDEX idx_notification_preferences_user_id ON metadata.notification_preferences(user_id);

COMMENT ON TABLE metadata.notification_preferences IS
    'Per-user notification channel preferences. Defaults to enabled for all channels.';
COMMENT ON COLUMN metadata.notification_preferences.channel IS
    'Notification channel: "email" or "sms"';
COMMENT ON COLUMN metadata.notification_preferences.email_address IS
    'Override user''s primary email address for notifications. NULL = use user.email';
COMMENT ON COLUMN metadata.notification_preferences.phone_number IS
    'Phone number for SMS notifications (Phase 2).';


-- ===========================================================================
-- Trigger: Create Default Notification Preferences
-- ===========================================================================
-- Automatically create default email preference when user is created

CREATE OR REPLACE FUNCTION create_default_notification_preferences()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_formatted_phone TEXT;
BEGIN
    -- Create default email preference using email from civic_os_users_private
    INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address)
    VALUES (NEW.id, 'email', TRUE, NEW.email)
    ON CONFLICT (user_id, channel) DO NOTHING;

    -- Create default SMS preference if phone number provided
    -- Strip non-numeric characters and validate 10-digit format
    IF NEW.phone IS NOT NULL THEN
        -- Remove all non-digit characters
        v_formatted_phone := regexp_replace(NEW.phone, '[^0-9]', '', 'g');

        -- Only create preference if result is exactly 10 digits
        IF length(v_formatted_phone) = 10 THEN
            INSERT INTO metadata.notification_preferences (user_id, channel, enabled, phone_number)
            VALUES (NEW.id, 'sms', FALSE, v_formatted_phone)
            ON CONFLICT (user_id, channel) DO NOTHING;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER create_default_notification_preferences_trigger
    AFTER INSERT ON metadata.civic_os_users_private
    FOR EACH ROW
    EXECUTE FUNCTION create_default_notification_preferences();

COMMENT ON FUNCTION create_default_notification_preferences() IS
    'Trigger function: Creates default email notification preference when user is created.';


-- ===========================================================================
-- Notifications Table
-- ===========================================================================
-- Individual notification records with polymorphic entity references

CREATE TABLE metadata.notifications (
    id BIGSERIAL PRIMARY KEY,

    -- Recipient
    user_id UUID NOT NULL REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,

    -- Template
    template_name VARCHAR(100) NOT NULL REFERENCES metadata.notification_templates(name),

    -- Polymorphic entity reference
    entity_type VARCHAR(100),           -- Table name (e.g., 'issues', 'appointments')
    entity_id VARCHAR(100),             -- Entity primary key (stored as text for flexibility)
    entity_data JSONB,                  -- Snapshot of entity data for template rendering

    -- Delivery
    channels TEXT[] NOT NULL DEFAULT '{email}',  -- ['email'], ['sms'], or ['email', 'sms']
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'failed'

    -- Results (updated by worker)
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    channels_sent TEXT[],               -- Which channels succeeded
    channels_failed TEXT[],             -- Which channels failed

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_status CHECK (status IN ('pending', 'sent', 'failed')),
    CONSTRAINT valid_channels CHECK (
        channels <> '{}' AND
        channels <@ ARRAY['email', 'sms']::TEXT[]
    )
);

CREATE INDEX idx_notifications_user_id ON metadata.notifications(user_id);
CREATE INDEX idx_notifications_status ON metadata.notifications(status);
CREATE INDEX idx_notifications_created_at ON metadata.notifications(created_at DESC);
CREATE INDEX idx_notifications_entity ON metadata.notifications(entity_type, entity_id);
CREATE INDEX idx_notifications_template ON metadata.notifications(template_name);

COMMENT ON TABLE metadata.notifications IS
    'Individual notification records. Created via create_notification() RPC, processed by notification worker.';
COMMENT ON COLUMN metadata.notifications.entity_data IS
    'JSONB snapshot of entity at notification creation time. Used for template rendering.';
COMMENT ON COLUMN metadata.notifications.channels IS
    'Requested delivery channels. Example: ''{email}'' or ''{email,sms}''';
COMMENT ON COLUMN metadata.notifications.channels_sent IS
    'Channels that successfully delivered. Updated by worker after sending.';
COMMENT ON COLUMN metadata.notifications.channels_failed IS
    'Channels that failed to deliver. Updated by worker after errors.';


-- ===========================================================================
-- RPC Function: create_notification()
-- ===========================================================================
-- Creates a notification with validation. Auto-enqueues River job for delivery.

CREATE OR REPLACE FUNCTION create_notification(
    p_user_id UUID,
    p_template_name VARCHAR,
    p_entity_type VARCHAR DEFAULT NULL,
    p_entity_id VARCHAR DEFAULT NULL,
    p_entity_data JSONB DEFAULT NULL,
    p_channels TEXT[] DEFAULT '{email}'
)
RETURNS BIGINT  -- Returns notification ID
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_notification_id BIGINT;
    v_template_exists BOOLEAN;
BEGIN
    -- Validate template exists
    SELECT EXISTS(
        SELECT 1 FROM metadata.notification_templates WHERE name = p_template_name
    ) INTO v_template_exists;

    IF NOT v_template_exists THEN
        RAISE EXCEPTION 'Template "%" does not exist', p_template_name;
    END IF;

    -- Validate user exists
    IF NOT EXISTS(SELECT 1 FROM metadata.civic_os_users WHERE id = p_user_id) THEN
        RAISE EXCEPTION 'User "%" does not exist', p_user_id;
    END IF;

    -- Validate channels
    IF p_channels IS NULL OR array_length(p_channels, 1) = 0 THEN
        RAISE EXCEPTION 'At least one channel must be specified';
    END IF;

    -- Validate channel values
    IF NOT (p_channels <@ ARRAY['email', 'sms']::TEXT[]) THEN
        RAISE EXCEPTION 'Invalid channel. Must be one of: email, sms';
    END IF;

    -- Insert notification (trigger will auto-enqueue River job)
    INSERT INTO metadata.notifications (
        user_id,
        template_name,
        entity_type,
        entity_id,
        entity_data,
        channels
    )
    VALUES (
        p_user_id,
        p_template_name,
        p_entity_type,
        p_entity_id,
        p_entity_data,
        p_channels
    )
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_notification TO authenticated;

COMMENT ON FUNCTION create_notification IS
    'Create a notification for a user. Validates template and user existence. Auto-enqueues River job for delivery.';


-- ===========================================================================
-- Trigger: Auto-enqueue River Jobs for Notifications
-- ===========================================================================
-- Automatically enqueue River job when notification is created

CREATE OR REPLACE FUNCTION enqueue_notification_job()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'send_notification',
        jsonb_build_object(
            'notification_id', NEW.id::text,
            'user_id', NEW.user_id::text,
            'template_name', NEW.template_name,
            'entity_type', NEW.entity_type,
            'entity_id', NEW.entity_id,
            'entity_data', NEW.entity_data,
            'channels', NEW.channels
        ),
        'notifications',  -- Queue name
        1,                -- Priority (higher = more urgent)
        5,                -- Max attempts (fewer than file jobs - emails are idempotent)
        NOW(),            -- Schedule immediately
        'available'       -- Job state
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_notification_job_trigger
    AFTER INSERT ON metadata.notifications
    FOR EACH ROW
    EXECUTE FUNCTION enqueue_notification_job();

COMMENT ON FUNCTION enqueue_notification_job IS
    'Trigger function: Enqueues River job when notification is created.';


-- ===========================================================================
-- Template Validation System
-- ===========================================================================
-- Synchronous template validation via River queue with polling

-- Main validation request table
CREATE TABLE metadata.template_validation_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_template TEXT,
    html_template TEXT,
    text_template TEXT,
    sms_template TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'completed'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT valid_status CHECK (status IN ('pending', 'completed'))
);

CREATE INDEX idx_template_validation_results_status
    ON metadata.template_validation_results(status, created_at);

COMMENT ON TABLE metadata.template_validation_results IS
    'Temporary storage for template validation requests. Results expire after 1 hour.';


-- Individual part results (enables per-field validation)
CREATE TABLE metadata.template_part_validation_results (
    id SERIAL PRIMARY KEY,
    validation_id UUID NOT NULL REFERENCES metadata.template_validation_results(id) ON DELETE CASCADE,
    part_name VARCHAR(20) NOT NULL,  -- 'subject', 'html', 'text', 'sms'
    valid BOOLEAN NOT NULL,
    error_message TEXT,              -- Also used for rendered output in preview mode
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_part_name CHECK (part_name IN ('subject', 'html', 'text', 'sms'))
);

CREATE INDEX idx_part_validation_results_validation_id
    ON metadata.template_part_validation_results(validation_id);

COMMENT ON TABLE metadata.template_part_validation_results IS
    'Per-part validation results. Enables real-time validation of individual template fields.';
COMMENT ON COLUMN metadata.template_part_validation_results.error_message IS
    'Validation error message. Also reused for rendered output in preview mode.';


-- ===========================================================================
-- RPC Function: validate_template_parts() - Non-blocking
-- ===========================================================================
-- Enqueues a validation job and returns validation_id immediately.
-- Use get_validation_results() to poll for results.

CREATE OR REPLACE FUNCTION validate_template_parts(
    p_validation_id UUID DEFAULT gen_random_uuid(),
    p_subject_template TEXT DEFAULT NULL,
    p_html_template TEXT DEFAULT NULL,
    p_text_template TEXT DEFAULT NULL,
    p_sms_template TEXT DEFAULT NULL
)
RETURNS TABLE(
    validation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Validate that at least one template part was provided
    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for validation';
    END IF;

    -- Insert validation request
    INSERT INTO metadata.template_validation_results (
        id,
        subject_template,
        html_template,
        text_template,
        sms_template,
        status
    )
    VALUES (
        p_validation_id,
        p_subject_template,
        p_html_template,
        p_text_template,
        p_sms_template,
        'pending'
    );

    -- Enqueue high-priority validation job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'validate_template_parts',
        jsonb_build_object(
            'validation_id', p_validation_id::text,
            'subject_template', p_subject_template,
            'html_template', p_html_template,
            'text_template', p_text_template,
            'sms_template', p_sms_template
        ),
        'notifications',
        4,  -- HIGH PRIORITY (4 = highest, normal notifications are priority 1)
        3,
        NOW(),
        'available'
    );

    -- Return validation_id immediately (non-blocking)
    RETURN QUERY SELECT p_validation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION validate_template_parts TO authenticated;

COMMENT ON FUNCTION validate_template_parts IS
    'Enqueues a validation job and returns validation_id immediately. Use get_validation_results() to poll for results.';


-- ===========================================================================
-- RPC Function: get_validation_results()
-- ===========================================================================
-- Retrieves validation results for a given validation_id.
-- Returns status (pending/completed) and results if available.

CREATE OR REPLACE FUNCTION get_validation_results(
    p_validation_id UUID
)
RETURNS TABLE(
    status TEXT,
    part_name TEXT,
    valid BOOLEAN,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_status TEXT;
BEGIN
    -- Check validation status
    SELECT tvr.status
    INTO v_status
    FROM metadata.template_validation_results tvr
    WHERE tvr.id = p_validation_id;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Validation ID not found: %', p_validation_id;
    END IF;

    -- Return status and results (if completed)
    IF v_status = 'completed' THEN
        RETURN QUERY
        SELECT
            v_status,
            pvr.part_name::TEXT,
            pvr.valid,
            pvr.error_message
        FROM metadata.template_part_validation_results pvr
        WHERE pvr.validation_id = p_validation_id
        ORDER BY
            CASE pvr.part_name
                WHEN 'subject' THEN 1
                WHEN 'html' THEN 2
                WHEN 'text' THEN 3
                WHEN 'sms' THEN 4
            END;
    ELSE
        -- Return just status (pending/processing)
        RETURN QUERY SELECT v_status, NULL::TEXT, NULL::BOOLEAN, NULL::TEXT;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION get_validation_results TO authenticated;

COMMENT ON FUNCTION get_validation_results IS
    'Retrieves validation results for a given validation_id. Returns status (pending/completed) and results if available.';


-- ===========================================================================
-- RPC Function: preview_template_parts() - Non-blocking
-- ===========================================================================
-- Enqueues a preview job and returns validation_id immediately.
-- Use get_preview_results() to poll for results.

CREATE OR REPLACE FUNCTION preview_template_parts(
    p_validation_id UUID DEFAULT gen_random_uuid(),
    p_subject_template TEXT DEFAULT NULL,
    p_html_template TEXT DEFAULT NULL,
    p_text_template TEXT DEFAULT NULL,
    p_sms_template TEXT DEFAULT NULL,
    p_sample_entity_data JSONB DEFAULT NULL
)
RETURNS TABLE(
    validation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
    -- Validate that at least one template part was provided
    IF p_subject_template IS NULL
        AND p_html_template IS NULL
        AND p_text_template IS NULL
        AND p_sms_template IS NULL
    THEN
        RAISE EXCEPTION 'At least one template part must be provided for preview';
    END IF;

    -- Default sample data if none provided
    IF p_sample_entity_data IS NULL THEN
        p_sample_entity_data := '{"display_name": "Example Entity", "id": 1}'::jsonb;
    END IF;

    -- Insert validation request (reuse same table)
    INSERT INTO metadata.template_validation_results (
        id,
        subject_template,
        html_template,
        text_template,
        sms_template,
        status
    )
    VALUES (
        p_validation_id,
        p_subject_template,
        p_html_template,
        p_text_template,
        p_sms_template,
        'pending'
    );

    -- Enqueue high-priority preview job
    INSERT INTO metadata.river_job (kind, args, queue, priority, max_attempts, scheduled_at, state)
    VALUES (
        'preview_template_parts',
        jsonb_build_object(
            'validation_id', p_validation_id::text,
            'subject_template', p_subject_template,
            'html_template', p_html_template,
            'text_template', p_text_template,
            'sms_template', p_sms_template,
            'sample_entity_data', p_sample_entity_data
        ),
        'notifications',
        4,  -- HIGH PRIORITY (4 = highest)
        3,
        NOW(),
        'available'
    );

    -- Return validation_id immediately (non-blocking)
    RETURN QUERY SELECT p_validation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION preview_template_parts TO authenticated;

COMMENT ON FUNCTION preview_template_parts IS
    'Enqueues a preview job and returns validation_id immediately. Use get_preview_results() to poll for results.';


-- ===========================================================================
-- RPC Function: get_preview_results()
-- ===========================================================================
-- Retrieves preview results for a given validation_id.
-- Returns status (pending/completed) and rendered output or errors.

CREATE OR REPLACE FUNCTION get_preview_results(
    p_validation_id UUID
)
RETURNS TABLE(
    status TEXT,
    part_name TEXT,
    rendered_output TEXT,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
    v_status TEXT;
BEGIN
    -- Check validation status
    SELECT tvr.status
    INTO v_status
    FROM metadata.template_validation_results tvr
    WHERE tvr.id = p_validation_id;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Validation ID not found: %', p_validation_id;
    END IF;

    -- Return status and results (if completed)
    IF v_status = 'completed' THEN
        RETURN QUERY
        SELECT
            v_status,
            pvr.part_name::TEXT,
            CASE WHEN pvr.valid THEN pvr.error_message ELSE NULL END AS rendered_output,
            CASE WHEN NOT pvr.valid THEN pvr.error_message ELSE NULL END AS error_message
        FROM metadata.template_part_validation_results pvr
        WHERE pvr.validation_id = p_validation_id
        ORDER BY
            CASE pvr.part_name
                WHEN 'subject' THEN 1
                WHEN 'html' THEN 2
                WHEN 'text' THEN 3
                WHEN 'sms' THEN 4
            END;
    ELSE
        -- Return just status (pending/processing)
        RETURN QUERY SELECT v_status, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION get_preview_results TO authenticated;

COMMENT ON FUNCTION get_preview_results IS
    'Retrieves preview results for a given validation_id. Returns status (pending/completed) and rendered output or errors.';


-- ===========================================================================
-- RPC Function: cleanup_old_validation_results()
-- ===========================================================================
-- Removes validation results older than 1 hour

CREATE OR REPLACE FUNCTION cleanup_old_validation_results()
RETURNS void
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM metadata.template_validation_results
    WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_old_validation_results TO authenticated;

COMMENT ON FUNCTION cleanup_old_validation_results IS
    'Deletes validation results older than 1 hour. Run periodically via cron or pg_cron.';


-- ===========================================================================
-- Permissions & Row Level Security
-- ===========================================================================

-- Grant sequence usage (needed for INSERTs via public views)
GRANT USAGE ON SEQUENCE metadata.notifications_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE metadata.notification_templates_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE metadata.template_part_validation_results_id_seq TO authenticated;

-- Enable Row Level Security
ALTER TABLE metadata.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.template_validation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata.template_part_validation_results ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Notifications (users see own notifications)
CREATE POLICY "Users see own notifications" ON metadata.notifications
    FOR SELECT TO authenticated USING (user_id = current_user_id());

CREATE POLICY "Users can create notifications" ON metadata.notifications
    FOR INSERT TO authenticated WITH CHECK (user_id = current_user_id());

-- RLS Policies: Notification Preferences (users manage own preferences)
CREATE POLICY "Users manage own preferences" ON metadata.notification_preferences
    FOR ALL TO authenticated USING (user_id = current_user_id());

-- RLS Policies: Notification Templates (admins manage, all can view)
CREATE POLICY "Admins manage templates" ON metadata.notification_templates
    FOR ALL TO authenticated USING (is_admin());

CREATE POLICY "All can view templates" ON metadata.notification_templates
    FOR SELECT TO authenticated USING (TRUE);

-- RLS Policies: Validation Results (users see own validation requests)
CREATE POLICY "Users see own validation results" ON metadata.template_validation_results
    FOR ALL TO authenticated USING (TRUE);  -- Validation is ephemeral, allow all authenticated

CREATE POLICY "Users see validation part results" ON metadata.template_part_validation_results
    FOR ALL TO authenticated USING (TRUE);  -- Linked to validation_results, allow all authenticated


-- ===========================================================================
-- Public Views (PostgREST Access)
-- ===========================================================================

-- Notification Templates View
-- Exposes metadata.notification_templates to PostgREST
CREATE VIEW public.notification_templates AS
    SELECT * FROM metadata.notification_templates;

GRANT SELECT ON public.notification_templates TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.notification_templates TO authenticated;

COMMENT ON VIEW public.notification_templates IS
    'Public view of notification templates. Exposes metadata.notification_templates to PostgREST.';

-- Notification Preferences View
-- Exposes metadata.notification_preferences to PostgREST
CREATE VIEW public.notification_preferences AS
    SELECT * FROM metadata.notification_preferences;

GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;

COMMENT ON VIEW public.notification_preferences IS
    'Public view of notification preferences. Exposes metadata.notification_preferences to PostgREST.';


-- ===========================================================================
-- Example Templates (Reference - NOT INSERTED)
-- ===========================================================================
-- These examples are provided as reference for integrators.
-- Uncomment and modify for your specific use cases.

-- Example 1: Issue Assignment Notification
-- INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
-- ('issue_created', 'Notify assigned user when new issue is created', 'issues',
--     'New issue assigned: {{.Entity.display_name}}',
--     '<h2>New Issue Assigned</h2><p>You have been assigned to: <strong>{{.Entity.display_name}}</strong></p>{{if .Entity.severity}}<p>Severity: {{.Entity.severity}}/5</p>{{end}}<p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a></p>',
--     'New Issue Assigned\n\nYou have been assigned to: {{.Entity.display_name}}\n{{if .Entity.severity}}Severity: {{.Entity.severity}}/5\n{{end}}\nView at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}'
-- );

-- Example 2: Appointment Reminder
-- INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
-- ('appointment_reminder', 'Remind user of upcoming appointment', 'appointments',
--     'Reminder: Appointment on {{.Entity.start_time}}',
--     '<h2>Appointment Reminder</h2><p>You have an appointment scheduled for <strong>{{.Entity.start_time}}</strong></p><p>Location: {{.Entity.location}}</p><p><a href="{{.Metadata.site_url}}/view/appointments/{{.Entity.id}}">View Details</a></p>',
--     'Appointment Reminder\n\nYou have an appointment scheduled for {{.Entity.start_time}}\n\nLocation: {{.Entity.location}}\n\nView at: {{.Metadata.site_url}}/view/appointments/{{.Entity.id}}'
-- );

-- Example 3: Issue Status Changed (with embedded relationships)
-- INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
-- ('issue_status_changed', 'Notify user when issue status changes', 'issues',
--     'Issue status changed: {{.Entity.display_name}}',
--     '<h2>Issue Status Updated</h2><p><strong>{{.Entity.display_name}}</strong></p><p>Status: <span style="background-color: {{.Entity.status.color}}; padding: 4px 8px; border-radius: 4px; color: white;">{{.Entity.status.display_name}}</span></p><p>Assigned to: {{.Entity.assigned_user.display_name}}</p><p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}">View Issue</a></p>',
--     'Issue Status Updated\n\n{{.Entity.display_name}}\n\nStatus: {{.Entity.status.display_name}}\nAssigned to: {{.Entity.assigned_user.display_name}}\n\nView at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}'
-- );

-- Example 4: Password Reset
-- INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template) VALUES
-- ('password_reset', 'Send password reset link to user', NULL,
--     'Reset your Civic OS password',
--     '<h2>Password Reset Request</h2><p>Click the link below to reset your password:</p><p><a href="{{.Metadata.site_url}}/reset-password?token={{.Entity.reset_token}}">Reset Password</a></p><p>This link expires in 1 hour.</p>',
--     'Password Reset Request\n\nClick the link below to reset your password:\n\n{{.Metadata.site_url}}/reset-password?token={{.Entity.reset_token}}\n\nThis link expires in 1 hour.'
-- );

-- ===========================================================================
-- Template Syntax Reference
-- ===========================================================================
-- Go templates use {{}} delimiters with dot notation for data access.
--
-- CONTEXT STRUCTURE:
--   {
--     "Entity": {...},      // Entity data from p_entity_data parameter
--     "Metadata": {
--       "site_url": "..."   // Frontend URL from SITE_URL env var
--     }
--   }
--
-- BASIC SYNTAX:
--   {{.Entity.display_name}}          Access nested fields
--   {{.Entity.severity}}               Access numeric fields
--   {{.Metadata.site_url}}             Access metadata
--
-- CONDITIONALS:
--   {{if .Entity.severity}}
--     Severity: {{.Entity.severity}}/5
--   {{end}}
--
--   {{if eq .Entity.status "urgent"}}
--     ⚠️ URGENT
--   {{else}}
--     Status: {{.Entity.status}}
--   {{end}}
--
-- ITERATION:
--   {{range .Entity.tags}}
--     - {{.}}
--   {{end}}
--
-- VARIABLES:
--   {{$url := .Metadata.site_url}}
--   <a href="{{$url}}/view/issues/{{.Entity.id}}">View</a>
--
-- FUNCTIONS:
--   {{len .Entity.tags}} tags
--   {{printf "%.2f" .Entity.price}}
--
-- XSS PROTECTION:
--   HTML templates auto-escape dangerous content.
--   Input: {"name": "<script>alert('xss')</script>"}
--   Output: &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;
--
-- MISSING FIELDS:
--   Missing fields return zero value (empty string, 0, false).
--   Use {{if .Entity.optional_field}} to check existence.
--
-- For complete Go template reference:
--   https://pkg.go.dev/text/template
--   https://pkg.go.dev/html/template

COMMIT;

NOTIFY pgrst, 'reload schema'