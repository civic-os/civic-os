-- Notification Templates for Pot Hole Tracker
-- Version: 0.11.0
--
-- This script creates example notification templates and triggers for the Pot Hole domain.
-- Templates use Go template syntax with context: {Entity, Metadata}

BEGIN;

-- ============================================================================
-- Notification Templates
-- ============================================================================

-- Template 1: Issue Created Notification
-- Sent when a new issue is created and assigned to a user
INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template
) VALUES (
    'issue_created',
    'Notify assigned user when a new issue is created',
    'issues',
    -- Subject
    'New issue assigned: {{.Entity.display_name}}',
    -- HTML Template
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">New Issue Assigned</h2>
        <p>You have been assigned to a new pot hole issue:</p>
        <div style="background-color: #f3f4f6; border-left: 4px solid #2563eb; padding: 16px; margin: 16px 0;">
            <h3 style="margin-top: 0;">{{.Entity.display_name}}</h3>
            {{if .Entity.location}}
            <p><strong>Location:</strong> {{.Entity.location}}</p>
            {{end}}
            {{if .Entity.severity_level}}
            <p><strong>Severity Level:</strong> {{.Entity.severity_level}}/5</p>
            {{end}}
            {{if .Entity.description}}
            <p><strong>Description:</strong> {{.Entity.description}}</p>
            {{end}}
        </div>
        <p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}" style="display: inline-block; background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin-top: 16px;">View Issue</a></p>
        <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">This is an automated notification from Pot Hole Tracker.</p>
    </div>',
    -- Text Template
    'New Issue Assigned

You have been assigned to a new pot hole issue:

Issue: {{.Entity.display_name}}
{{if .Entity.location}}Location: {{.Entity.location}}
{{end}}{{if .Entity.severity_level}}Severity Level: {{.Entity.severity_level}}/5
{{end}}{{if .Entity.description}}Description: {{.Entity.description}}
{{end}}
View the issue at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}

---
This is an automated notification from Pot Hole Tracker.'
);

-- Template 2: Issue Status Changed
-- Sent when an issue status is updated
INSERT INTO metadata.notification_templates (
    name,
    description,
    entity_type,
    subject_template,
    html_template,
    text_template
) VALUES (
    'issue_status_changed',
    'Notify assigned user when issue status changes',
    'issues',
    -- Subject
    'Issue status updated: {{.Entity.display_name}}',
    -- HTML Template
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Issue Status Updated</h2>
        <p>The status of your assigned issue has been updated:</p>
        <div style="background-color: #f3f4f6; border-left: 4px solid #16a34a; padding: 16px; margin: 16px 0;">
            <h3 style="margin-top: 0;">{{.Entity.display_name}}</h3>
            {{if .Entity.status}}
            <p><strong>New Status:</strong> <span style="background-color: {{.Entity.status.color}}; color: white; padding: 4px 8px; border-radius: 4px;">{{.Entity.status.display_name}}</span></p>
            {{end}}
            {{if .Entity.location}}
            <p><strong>Location:</strong> {{.Entity.location}}</p>
            {{end}}
        </div>
        <p><a href="{{.Metadata.site_url}}/view/issues/{{.Entity.id}}" style="display: inline-block; background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin-top: 16px;">View Issue</a></p>
        <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">This is an automated notification from Pot Hole Tracker.</p>
    </div>',
    -- Text Template
    'Issue Status Updated

The status of your assigned issue has been updated:

Issue: {{.Entity.display_name}}
{{if .Entity.status}}New Status: {{.Entity.status.display_name}}
{{end}}{{if .Entity.location}}Location: {{.Entity.location}}
{{end}}
View the issue at: {{.Metadata.site_url}}/view/issues/{{.Entity.id}}

---
This is an automated notification from Pot Hole Tracker.'
);

-- ============================================================================
-- Notification Triggers
-- ============================================================================

-- Trigger 1: Send notification when issue is created with assigned user
CREATE OR REPLACE FUNCTION notify_issue_created()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_issue_data JSONB;
BEGIN
    -- Only send notification if issue has an assigned user
    IF NEW."created_user" IS NOT NULL THEN
        -- Build issue data JSONB (fetch embedded relationships)
        SELECT jsonb_build_object(
            'id', NEW.id,
            'display_name', NEW."display_name",
            'location', NEW.location,
            'severity_level', NEW.severity_level,
            'description', NEW.description,
            'status', jsonb_build_object(
                'id', s.id,
                'display_name', s."display_name"
            )
        )
        INTO v_issue_data
        FROM "IssueStatus" s
        WHERE s.id = NEW."status";

        -- Create notification
        PERFORM create_notification(
            p_user_id := NEW."created_user",
            p_template_name := 'issue_created',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data,
            p_channels := ARRAY['email']::TEXT[]
        );
    END IF;

    RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS issue_created_notification_trigger ON "Issue";

-- Create trigger
CREATE TRIGGER issue_created_notification_trigger
    AFTER INSERT ON "Issue"
    FOR EACH ROW
    EXECUTE FUNCTION notify_issue_created();

COMMENT ON FUNCTION notify_issue_created IS
    'Trigger function: Sends notification when issue is created with assigned user.';


-- Trigger 2: Send notification when issue status changes
CREATE OR REPLACE FUNCTION notify_issue_status_changed()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql
AS $$
DECLARE
    v_issue_data JSONB;
BEGIN
    -- Only send notification if:
    -- 1. Status has changed
    -- 2. Issue has an assigned user
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NEW."created_user" IS NOT NULL THEN

        -- Build issue data JSONB (fetch embedded relationships)
        SELECT jsonb_build_object(
            'id', NEW.id,
            'display_name', NEW."display_name",
            'location', NEW.location,
            'severity_level', NEW.severity_level,
            'description', NEW.description,
            'status', jsonb_build_object(
                'id', s.id,
                'display_name', s."display_name"
            )
        )
        INTO v_issue_data
        FROM "IssueStatus" s
        WHERE s.id = NEW."status";

        -- Create notification
        PERFORM create_notification(
            p_user_id := NEW."created_user",
            p_template_name := 'issue_status_changed',
            p_entity_type := 'issues',
            p_entity_id := NEW.id::text,
            p_entity_data := v_issue_data,
            p_channels := ARRAY['email']::TEXT[]
        );
    END IF;

    RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS issue_status_changed_notification_trigger ON "Issue";

-- Create trigger
CREATE TRIGGER issue_status_changed_notification_trigger
    AFTER UPDATE ON "Issue"
    FOR EACH ROW
    EXECUTE FUNCTION notify_issue_status_changed();

COMMENT ON FUNCTION notify_issue_status_changed IS
    'Trigger function: Sends notification when issue status changes.';

-- ============================================================================
-- Verification
-- ============================================================================

-- Verify templates were created
DO $$
DECLARE
    v_template_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_template_count
    FROM metadata.notification_templates
    WHERE name IN ('issue_created', 'issue_status_changed');

    IF v_template_count <> 2 THEN
        RAISE EXCEPTION 'Expected 2 notification templates, found %', v_template_count;
    END IF;

    RAISE NOTICE 'Successfully created 2 notification templates';
END $$;

COMMIT;
