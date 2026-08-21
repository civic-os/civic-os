-- =====================================================
-- NEWSLETTER ENTITY (Client Intake Example)
-- =====================================================
-- v0.70.0 — Email campaign system for client communication
--
-- Demonstrates:
--   - The new `markdown` property type (WYSIWYG editor)
--   - Status workflow (Draft → Scheduled → Sent / Archived)
--   - Entity actions ("Send Now" button)
--   - Scheduled jobs (hourly delivery check)
--   - Notification templates (email rendering with markdown)
--   - Framework-level engagement tracking (is_bulk = TRUE)
--   - M:M junction table (newsletter_recipients)
-- =====================================================

-- =====================================================
-- TABLES
-- =====================================================

CREATE TABLE newsletters (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    body markdown NOT NULL DEFAULT '',
    status_id INT NOT NULL,
    scheduled_for TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_by UUID DEFAULT current_user_id()
        REFERENCES metadata.civic_os_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on FKs (CRITICAL: PostgreSQL does NOT auto-index FKs)
CREATE INDEX idx_newsletters_status_id ON newsletters(status_id);
CREATE INDEX idx_newsletters_created_by ON newsletters(created_by);

-- Auto-update timestamps
CREATE TRIGGER set_newsletters_updated_at
    BEFORE UPDATE ON newsletters
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- M:M junction: newsletter → clients
CREATE TABLE newsletter_recipients (
    newsletter_id BIGINT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    PRIMARY KEY (newsletter_id, client_id)  -- Composite PK (CRITICAL: no surrogate ID)
);

CREATE INDEX idx_newsletter_recipients_client_id ON newsletter_recipients(client_id);

-- =====================================================
-- STATUS WORKFLOW
-- =====================================================

-- Register the status type (FK parent for statuses.entity_type)
INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('newsletter', 'Newsletter', 'Newsletter delivery workflow')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal, status_key)
VALUES
    ('newsletter', 'Draft',     'Content being composed',           '#F59E0B', 1, TRUE,  FALSE, 'draft'),
    ('newsletter', 'Scheduled', 'Queued for delivery at set time',  '#3B82F6', 2, FALSE, FALSE, 'scheduled'),
    ('newsletter', 'Sent',      'Delivered to recipients',          '#22C55E', 3, FALSE, TRUE,  'sent'),
    ('newsletter', 'Archived',  'Removed from active list',         '#6B7280', 4, FALSE, TRUE,  'archived')
ON CONFLICT DO NOTHING;

-- Set the FK default now that statuses exist
ALTER TABLE newsletters
    ALTER COLUMN status_id SET DEFAULT get_initial_status('newsletter');

-- Add the FK constraint (deferred so statuses exist first)
ALTER TABLE newsletters
    ADD CONSTRAINT newsletters_status_id_fkey
    FOREIGN KEY (status_id) REFERENCES metadata.statuses(id);

-- Allowed transitions: draft↔scheduled, draft→archived, scheduled→sent
INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id)
VALUES
    ('newsletter',
     get_status_id('newsletter', 'draft'),
     get_status_id('newsletter', 'scheduled')),
    ('newsletter',
     get_status_id('newsletter', 'draft'),
     get_status_id('newsletter', 'archived')),
    ('newsletter',
     get_status_id('newsletter', 'scheduled'),
     get_status_id('newsletter', 'draft')),
    ('newsletter',
     get_status_id('newsletter', 'scheduled'),
     get_status_id('newsletter', 'sent'))
ON CONFLICT DO NOTHING;

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON newsletters TO web_anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON newsletters TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE newsletters_id_seq TO authenticated;

GRANT SELECT, INSERT, DELETE ON newsletter_recipients TO authenticated;

-- =====================================================
-- ROW-LEVEL SECURITY
-- =====================================================

ALTER TABLE newsletters ENABLE ROW LEVEL SECURITY;
CREATE POLICY newsletters_select ON newsletters FOR SELECT USING (
    has_permission('newsletters', 'read')
);
CREATE POLICY newsletters_insert ON newsletters FOR INSERT WITH CHECK (
    has_permission('newsletters', 'create')
);
CREATE POLICY newsletters_update ON newsletters FOR UPDATE USING (
    has_permission('newsletters', 'update')
);
CREATE POLICY newsletters_delete ON newsletters FOR DELETE USING (
    has_permission('newsletters', 'delete')
);

ALTER TABLE newsletter_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY newsletter_recipients_select ON newsletter_recipients FOR SELECT USING (
    has_permission('newsletter_recipients', 'read')
);
CREATE POLICY newsletter_recipients_insert ON newsletter_recipients FOR INSERT WITH CHECK (
    has_permission('newsletter_recipients', 'create')
);
CREATE POLICY newsletter_recipients_delete ON newsletter_recipients FOR DELETE USING (
    has_permission('newsletter_recipients', 'delete')
);

-- =====================================================
-- RBAC PERMISSIONS
-- =====================================================

INSERT INTO metadata.permissions (table_name, permission)
VALUES
    ('newsletters', 'read'), ('newsletters', 'create'),
    ('newsletters', 'update'), ('newsletters', 'delete'),
    ('newsletter_recipients', 'read'), ('newsletter_recipients', 'create'),
    ('newsletter_recipients', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant to staff and admin roles
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('newsletters', 'newsletter_recipients')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- =====================================================
-- ENTITY METADATA
-- =====================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('newsletters', 'Newsletter', 'Email campaigns for client communication', 60, TRUE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar, is_rich_junction)
VALUES ('newsletter_recipients', 'Recipient', FALSE, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  show_in_sidebar = EXCLUDED.show_in_sidebar,
  is_rich_junction = EXCLUDED.is_rich_junction;

-- =====================================================
-- PROPERTY METADATA
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  -- List + forms
  ('newsletters', 'display_name', 'Title',           1, 1, TRUE,  TRUE,  TRUE,  TRUE),
  ('newsletters', 'subject',      'Email Subject',   2, 1, TRUE,  TRUE,  TRUE,  TRUE),
  -- Body: full-width markdown editor, not on list (too long)
  ('newsletters', 'body',         'Content',         3, 2, FALSE, TRUE,  TRUE,  TRUE),
  -- Status: list + detail only (auto-set to draft on create)
  ('newsletters', 'status_id',    'Status',          4, 1, TRUE,  FALSE, FALSE, TRUE),
  -- Scheduling: edit + detail (set after drafting)
  ('newsletters', 'scheduled_for','Scheduled For',   5, 1, TRUE,  FALSE, TRUE,  TRUE),
  -- Read-only fields
  ('newsletters', 'sent_at',      'Sent At',         6, 1, TRUE,  FALSE, FALSE, TRUE),
  ('newsletters', 'created_by',   'Created By',      7, 1, TRUE,  FALSE, FALSE, TRUE),
  ('newsletters', 'created_at',   'Created',         8, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- Bind status_id to the newsletter status type (required for colored badge rendering)
UPDATE metadata.properties SET status_entity_type = 'newsletter'
WHERE table_name = 'newsletters' AND column_name = 'status_id';

-- Inline M:M: show recipient picker on create/edit forms and chips on detail
INSERT INTO metadata.properties (table_name, column_name, display_name, fk_search_modal, show_inline)
VALUES ('newsletters', 'newsletter_recipients_m2m', 'Recipients', true, true)
ON CONFLICT (table_name, column_name) DO UPDATE
  SET display_name = 'Recipients', fk_search_modal = true, show_inline = true;

-- =====================================================
-- NOTIFICATION TEMPLATE (email rendering)
-- Framework handles CAN-SPAM footer and tracking pixel
-- via is_bulk = TRUE (see trackable notifications).
-- =====================================================

INSERT INTO metadata.notification_templates (
    name, description, entity_type, is_bulk,
    subject_template, html_template, text_template
) VALUES (
    'newsletter_send',
    'Deliver newsletter content to recipients',
    'newsletters',
    TRUE,

    -- Subject: uses the newsletter's subject field
    '{{.Entity.subject}}',

    -- HTML: branded layout with header and body (markdown → HTML)
    -- Footer and tracking pixel are auto-injected by the framework for is_bulk templates
    '<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%;">

        <!-- HEADER -->
        <tr><td style="background-color:#1e3a5f; border-radius:8px 8px 0 0; padding:24px 32px; text-align:center;">
          <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:600; letter-spacing:0.5px;">{{.Metadata.site_name}}</h1>
        </td></tr>

        <!-- BODY -->
        <tr><td style="background-color:#ffffff; padding:32px; border-left:1px solid #e4e4e7; border-right:1px solid #e4e4e7;">
          <div style="color:#27272a; font-size:16px; line-height:1.6;">
            {{ markdown .Entity.body }}
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>',

    -- Plain text: raw markdown (readable as-is)
    '{{.Entity.body}}'
) ON CONFLICT DO NOTHING;

-- =====================================================
-- SEND NEWSLETTER RPC
-- =====================================================

CREATE OR REPLACE FUNCTION send_newsletter(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_newsletter RECORD;
    v_recipient RECORD;
BEGIN
    -- Verify newsletter exists and is in sendable state
    SELECT n.*, s.status_key
    INTO v_newsletter
    FROM newsletters n
    JOIN metadata.statuses s ON n.status_id = s.id
    WHERE n.id = p_entity_id;

    IF v_newsletter IS NULL THEN
        RAISE EXCEPTION 'Newsletter % not found', p_entity_id;
    END IF;

    IF v_newsletter.status_key NOT IN ('scheduled', 'draft') THEN
        RAISE EXCEPTION 'Newsletter must be in Draft or Scheduled status to send';
    END IF;

    -- Send individual emails per recipient
    -- Framework auto-generates tracking tokens for is_bulk templates
    FOR v_recipient IN
        SELECT c.email
        FROM newsletter_recipients nr
        JOIN clients c ON nr.client_id = c.id
        WHERE nr.newsletter_id = p_entity_id
          AND c.email IS NOT NULL
    LOOP
        PERFORM metadata.send_email(
            p_to_addresses  := ARRAY[v_recipient.email],
            p_template_name := 'newsletter_send',
            p_entity_type   := 'newsletters',
            p_entity_id     := p_entity_id::TEXT,
            p_entity_data   := jsonb_build_object(
                'subject', v_newsletter.subject,
                'body', v_newsletter.body
            )
        );
    END LOOP;

    -- Transition to Sent status
    UPDATE newsletters
    SET status_id = get_status_id('newsletter', 'sent'),
        sent_at = NOW(),
        updated_at = NOW()
    WHERE id = p_entity_id;
END;
$$;

GRANT EXECUTE ON FUNCTION send_newsletter(BIGINT) TO authenticated;

-- =====================================================
-- SCHEDULE NEWSLETTER RPC (parameterized action)
-- =====================================================

CREATE OR REPLACE FUNCTION schedule_newsletter(
    p_entity_id BIGINT,
    p_scheduled_for TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_newsletter RECORD;
BEGIN
    -- Verify permission
    IF NOT has_permission('newsletters', 'update') THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Permission denied');
    END IF;

    -- Verify newsletter exists and is in Draft status
    SELECT n.*, s.status_key
    INTO v_newsletter
    FROM newsletters n
    JOIN metadata.statuses s ON n.status_id = s.id
    WHERE n.id = p_entity_id;

    IF v_newsletter IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Newsletter not found');
    END IF;

    IF v_newsletter.status_key != 'draft' THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Only Draft newsletters can be scheduled');
    END IF;

    -- Validate scheduled_for is in the future
    IF p_scheduled_for <= NOW() THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Scheduled time must be in the future');
    END IF;

    -- Set the scheduled time and transition to Scheduled status
    UPDATE newsletters
    SET scheduled_for = p_scheduled_for,
        status_id = get_status_id('newsletter', 'scheduled'),
        updated_at = NOW()
    WHERE id = p_entity_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', 'Newsletter scheduled successfully',
        'refresh', TRUE
    );
END;
$$;

GRANT EXECUTE ON FUNCTION schedule_newsletter(BIGINT, TIMESTAMPTZ) TO authenticated;

-- =====================================================
-- SCHEDULED JOB: Hourly delivery check
-- =====================================================

CREATE OR REPLACE FUNCTION check_scheduled_newsletters()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_newsletter RECORD;
    v_sent_count INT := 0;
    v_scheduled_status_id INT;
BEGIN
    v_scheduled_status_id := get_status_id('newsletter', 'scheduled');

    FOR v_newsletter IN
        SELECT id, display_name
        FROM newsletters
        WHERE status_id = v_scheduled_status_id
          AND scheduled_for IS NOT NULL
          AND scheduled_for <= NOW()
    LOOP
        PERFORM send_newsletter(v_newsletter.id);
        v_sent_count := v_sent_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', TRUE,
        'message', format('Processed %s scheduled newsletters', v_sent_count),
        'newsletters_sent', v_sent_count
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', FALSE,
        'message', SQLERRM
    );
END;
$$;

GRANT EXECUTE ON FUNCTION check_scheduled_newsletters() TO authenticated;

-- Register hourly scheduled job
INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES (
    'newsletter_delivery',
    'check_scheduled_newsletters',
    '*/5 * * * *',
    'America/Detroit',
    'Checks for newsletters with scheduled status and scheduled_for <= now, sends them'
) ON CONFLICT DO NOTHING;

-- =====================================================
-- ENTITY ACTION: "Send Now" button
-- =====================================================

INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description,
    rpc_function, icon, button_style, sort_order,
    requires_confirmation, confirmation_message, default_success_message,
    visibility_condition, refresh_after_action
) VALUES (
    'newsletters', 'send_now', 'Send Now', 'Send this newsletter to all recipients immediately',
    'send_newsletter', 'send', 'success', 10,
    TRUE, 'Send this newsletter to all recipients now? This cannot be undone.',
    'Newsletter sent successfully!',
    '{"field": "status_id.status_key", "operator": "in", "value": ["draft", "scheduled"]}'::jsonb,
    TRUE
) ON CONFLICT DO NOTHING;

-- Grant action to staff and admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'newsletters' AND ea.action_name = 'send_now'
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- =====================================================
-- ENTITY ACTION: "Schedule" button (parameterized)
-- =====================================================

INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description,
    rpc_function, icon, button_style, sort_order,
    requires_confirmation, confirmation_message, default_success_message,
    visibility_condition, refresh_after_action
) VALUES (
    'newsletters', 'schedule', 'Schedule', 'Schedule this newsletter for future delivery',
    'schedule_newsletter', 'schedule_send', 'primary', 5,
    TRUE, 'Schedule this newsletter for the selected date and time?',
    'Newsletter scheduled successfully!',
    '{"field": "status_id.status_key", "operator": "eq", "value": "draft"}'::jsonb,
    TRUE
) ON CONFLICT DO NOTHING;

-- DateTime parameter: "Send At" picker
INSERT INTO metadata.entity_action_params (
    entity_action_id, param_name, display_name, param_type,
    required, sort_order, placeholder
)
SELECT ea.id, 'p_scheduled_for', 'Send At', 'datetime_local',
       TRUE, 10, 'Select date and time for delivery'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'newsletters' AND ea.action_name = 'schedule'
ON CONFLICT (entity_action_id, param_name) DO NOTHING;

-- Grant action to staff and admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'newsletters' AND ea.action_name = 'schedule'
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;
