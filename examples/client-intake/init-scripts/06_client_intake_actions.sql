-- ============================================================================
-- Client Intake & Referral - Entity Actions, Automation & Filtering
-- ============================================================================
-- Contains:
--   1. Filtering RPCs (active partners, partner service categories)
--   2. Entity Action RPCs (client + referral status transitions)
--   3. Entity Action metadata + role grants + action parameters
--   4. Auto-survey trigger (referral creation → pending survey)
--   5. Referral notification pipeline (email on referral creation)
--   6. Survey reminder scheduled job
-- ============================================================================
-- NOTE: Requires Civic OS v0.18.0+ (Entity Action Buttons)
-- NOTE: Requires Civic OS v0.32.0+ (Entity Action Parameters)
-- NOTE: Requires Civic OS v0.33.0+ (Property Change Triggers, Status Transitions)
-- NOTE: Requires Civic OS v0.44.0+ (options_source_rpc, depends_on_columns)
-- NOTE: Requires Civic OS v0.53.2+ (dot-notation visibility_condition)
-- NOTE: Requires Civic OS v0.59.0+ (metadata.send_email)
-- ============================================================================

BEGIN;


-- ============================================================================
-- 1. FILTERING RPCs
-- ============================================================================

-- Returns active partners whose services overlap with the client's
-- identified needs. When no client_id is available, falls back to
-- showing all active partners.
-- Works in two contexts:
--   1. Referral create page: client_id comes via p_depends_on (depends_on_columns)
--   2. Client action modal:  client_id IS p_id (the entity being viewed)
CREATE OR REPLACE FUNCTION get_partners_for_client_needs(
  p_id TEXT,
  p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE (id BIGINT, display_name TEXT)
LANGUAGE SQL STABLE
AS $$
  SELECT DISTINCT p.id, p.display_name
  FROM partners p
  WHERE p.active = TRUE
    AND (
      -- No client context → show all active partners
      COALESCE(p_depends_on->>'client_id', p_id) IS NULL
      OR
      -- Client known → only partners offering at least one needed service
      EXISTS (
        SELECT 1
        FROM partner_service_categories psc
        JOIN client_service_needs csn ON psc.service_category_id = csn.service_category_id
        WHERE psc.partner_id = p.id
          AND csn.client_id = COALESCE(p_depends_on->>'client_id', p_id)::BIGINT
      )
    )
  ORDER BY p.display_name;
$$;

GRANT EXECUTE ON FUNCTION get_partners_for_client_needs TO authenticated;

-- Returns service categories for a referral, filtered by the
-- intersection of client needs and partner offerings.
-- Dual dependency: re-queries when either client_id or partner_id changes.
CREATE OR REPLACE FUNCTION get_referral_service_options(
  p_id TEXT,
  p_depends_on JSONB DEFAULT '{}'
)
RETURNS TABLE (id BIGINT, display_name TEXT)
LANGUAGE SQL STABLE
AS $$
  SELECT sc.id, sc.display_name
  FROM service_categories sc
  WHERE sc.active = TRUE
    AND (
      -- Filter by partner's offerings (if partner selected)
      (p_depends_on->>'partner_id') IS NULL
      OR sc.id IN (
        SELECT psc.service_category_id
        FROM partner_service_categories psc
        WHERE psc.partner_id = (p_depends_on->>'partner_id')::BIGINT
      )
    )
    AND (
      -- Filter by client's needs (if client selected)
      (p_depends_on->>'client_id') IS NULL
      OR sc.id IN (
        SELECT csn.service_category_id
        FROM client_service_needs csn
        WHERE csn.client_id = (p_depends_on->>'client_id')::BIGINT
      )
    )
  ORDER BY sc.sort_order, sc.display_name;
$$;

GRANT EXECUTE ON FUNCTION get_referral_service_options TO authenticated;


-- ============================================================================
-- 2. ENTITY ACTION RPCs
-- ============================================================================

-- Activate Client: Intake Pending → Active
CREATE OR REPLACE FUNCTION activate_client(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  SELECT s.status_key INTO v_current_key
  FROM clients c
  JOIN metadata.statuses s ON c.status_id = s.id
  WHERE c.id = p_entity_id;

  IF v_current_key IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF v_current_key != 'intake_pending' THEN
    RAISE EXCEPTION 'Client must be in Intake Pending status to activate';
  END IF;

  UPDATE clients
  SET status_id = get_status_id('client', 'active'),
      updated_at = NOW()
  WHERE id = p_entity_id;
END;
$$;

GRANT EXECUTE ON FUNCTION activate_client TO authenticated;

-- Deactivate Client: Active → Inactive
CREATE OR REPLACE FUNCTION deactivate_client(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  SELECT s.status_key INTO v_current_key
  FROM clients c
  JOIN metadata.statuses s ON c.status_id = s.id
  WHERE c.id = p_entity_id;

  IF v_current_key IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF v_current_key != 'active' THEN
    RAISE EXCEPTION 'Client must be in Active status to deactivate';
  END IF;

  UPDATE clients
  SET status_id = get_status_id('client', 'inactive'),
      updated_at = NOW()
  WHERE id = p_entity_id;
END;
$$;

GRANT EXECUTE ON FUNCTION deactivate_client TO authenticated;

-- Reactivate Client: Inactive → Active
CREATE OR REPLACE FUNCTION reactivate_client(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  SELECT s.status_key INTO v_current_key
  FROM clients c
  JOIN metadata.statuses s ON c.status_id = s.id
  WHERE c.id = p_entity_id;

  IF v_current_key IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF v_current_key != 'inactive' THEN
    RAISE EXCEPTION 'Client must be in Inactive status to reactivate';
  END IF;

  UPDATE clients
  SET status_id = get_status_id('client', 'active'),
      updated_at = NOW()
  WHERE id = p_entity_id;
END;
$$;

GRANT EXECUTE ON FUNCTION reactivate_client TO authenticated;

-- Refer Client: creates a referral from the client detail page
-- Auto-populates service categories from client needs ∩ partner offerings
CREATE OR REPLACE FUNCTION refer_client(
  p_entity_id BIGINT,
  p_partner_id BIGINT,
  p_referral_type_id INT,
  p_referral_date DATE DEFAULT CURRENT_DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
  v_referral_id BIGINT;
  v_referred_status_id INT;
BEGIN
  -- Validate client is Active
  SELECT s.status_key INTO v_current_key
  FROM clients c
  JOIN metadata.statuses s ON c.status_id = s.id
  WHERE c.id = p_entity_id;

  IF v_current_key IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF v_current_key != 'active' THEN
    RAISE EXCEPTION 'Client must be in Active status to create a referral';
  END IF;

  v_referred_status_id := get_status_id('referral', 'referred');

  -- Create the referral
  INSERT INTO referrals (client_id, partner_id, referral_type_id, referral_date, referred_by, status_id)
  VALUES (p_entity_id, p_partner_id, p_referral_type_id, p_referral_date, current_user_id(), v_referred_status_id)
  RETURNING id INTO v_referral_id;

  -- Auto-populate service categories: intersection of client needs & partner offerings
  INSERT INTO referral_service_categories (referral_id, service_category_id)
  SELECT v_referral_id, csn.service_category_id
  FROM client_service_needs csn
  JOIN partner_service_categories psc ON csn.service_category_id = psc.service_category_id
  WHERE csn.client_id = p_entity_id
    AND psc.partner_id = p_partner_id
  ON CONFLICT DO NOTHING;

  -- Send notification email (property_change_triggers don't fire inside RPCs)
  PERFORM send_referral_notification(v_referral_id);
END;
$$;

GRANT EXECUTE ON FUNCTION refer_client TO authenticated;

-- Complete Referral: Referred → Completed (sets completed_date)
CREATE OR REPLACE FUNCTION complete_referral(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  SELECT s.status_key INTO v_current_key
  FROM referrals r
  JOIN metadata.statuses s ON r.status_id = s.id
  WHERE r.id = p_entity_id;

  IF v_current_key IS NULL THEN
    RAISE EXCEPTION 'Referral not found';
  END IF;

  IF v_current_key != 'referred' THEN
    RAISE EXCEPTION 'Referral must be in Referred status to complete';
  END IF;

  UPDATE referrals
  SET status_id = get_status_id('referral', 'completed'),
      completed_date = CURRENT_DATE,
      updated_at = NOW()
  WHERE id = p_entity_id;
END;
$$;

GRANT EXECUTE ON FUNCTION complete_referral TO authenticated;

-- Mark Referral Not Completed: Referred → Not Completed
-- Accepts outcome_notes from action parameter modal
CREATE OR REPLACE FUNCTION mark_referral_not_completed(
  p_entity_id BIGINT,
  p_outcome_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  SELECT s.status_key INTO v_current_key
  FROM referrals r
  JOIN metadata.statuses s ON r.status_id = s.id
  WHERE r.id = p_entity_id;

  IF v_current_key IS NULL THEN
    RAISE EXCEPTION 'Referral not found';
  END IF;

  IF v_current_key != 'referred' THEN
    RAISE EXCEPTION 'Referral must be in Referred status';
  END IF;

  UPDATE referrals
  SET status_id = get_status_id('referral', 'not_completed'),
      outcome_notes = COALESCE(p_outcome_notes, outcome_notes),
      completed_date = CURRENT_DATE,
      updated_at = NOW()
  WHERE id = p_entity_id;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_referral_not_completed TO authenticated;


-- ============================================================================
-- 3. ENTITY ACTION METADATA
-- ============================================================================

-- Client Actions
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description,
  rpc_function, icon, button_style, sort_order,
  requires_confirmation, confirmation_message, default_success_message,
  visibility_condition, refresh_after_action
) VALUES
  ('clients', 'activate', 'Activate Client', 'Assessment complete — transition to Active',
   'activate_client', 'check_circle', 'success', 10,
   TRUE, 'Activate this client? This confirms their intake assessment is complete.',
   'Client activated successfully.',
   '{"field": "status_id.status_key", "operator": "eq", "value": "intake_pending"}'::jsonb,
   TRUE),

  ('clients', 'refer', 'Refer Client', 'Create a referral to a service partner',
   'refer_client', 'send', 'primary', 15,
   FALSE, NULL,
   'Referral created successfully.',
   '{"field": "status_id.status_key", "operator": "eq", "value": "active"}'::jsonb,
   TRUE),

  ('clients', 'deactivate', 'Deactivate Client', 'Mark client as no longer engaged',
   'deactivate_client', 'archive', 'warning', 20,
   TRUE, 'Deactivate this client? Their referral history will be preserved.',
   'Client deactivated.',
   '{"field": "status_id.status_key", "operator": "eq", "value": "active"}'::jsonb,
   TRUE),

  ('clients', 'reactivate', 'Reactivate Client', 'Restore inactive client to active status',
   'reactivate_client', 'restart_alt', 'primary', 10,
   TRUE, 'Reactivate this client?',
   'Client reactivated.',
   '{"field": "status_id.status_key", "operator": "eq", "value": "inactive"}'::jsonb,
   TRUE)
ON CONFLICT DO NOTHING;

-- Referral Actions
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description,
  rpc_function, icon, button_style, sort_order,
  requires_confirmation, confirmation_message, default_success_message,
  visibility_condition, refresh_after_action
) VALUES
  ('referrals', 'complete', 'Mark Completed', 'Client successfully connected with partner',
   'complete_referral', 'check_circle', 'success', 10,
   TRUE, 'Mark this referral as completed?',
   'Referral marked as completed.',
   '{"field": "status_id.status_key", "operator": "eq", "value": "referred"}'::jsonb,
   TRUE),

  ('referrals', 'not_completed', 'Mark Not Completed', 'Client unable to connect or referral unsuccessful',
   'mark_referral_not_completed', 'cancel', 'error', 20,
   FALSE, NULL,
   'Referral marked as not completed.',
   '{"field": "status_id.status_key", "operator": "eq", "value": "referred"}'::jsonb,
   TRUE)
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 4. ENTITY ACTION ROLE GRANTS
-- ============================================================================

-- Grant all client actions to ic_staff and admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'clients'
  AND ea.action_name IN ('activate', 'refer', 'deactivate', 'reactivate')
  AND r.role_key IN ('ic_staff', 'admin')
ON CONFLICT DO NOTHING;

-- Grant all referral actions to ic_staff and admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'referrals'
  AND ea.action_name IN ('complete', 'not_completed')
  AND r.role_key IN ('ic_staff', 'admin')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 5. ACTION PARAMETERS
-- ============================================================================

-- "Refer Client" parameters: partner, referral type, date
INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name,
  param_type, required, sort_order,
  join_table, join_column, options_source_rpc
)
SELECT
  ea.id,
  'p_partner_id',
  'Partner',
  'foreign_key',
  TRUE,
  10,
  'partners', 'id', 'get_partners_for_client_needs'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'clients'
  AND ea.action_name = 'refer'
ON CONFLICT DO NOTHING;

INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name,
  param_type, required, sort_order,
  category_entity_type
)
SELECT
  ea.id,
  'p_referral_type_id',
  'Referral Type',
  'category',
  TRUE,
  20,
  'referral_type'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'clients'
  AND ea.action_name = 'refer'
ON CONFLICT DO NOTHING;

INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name,
  param_type, required, sort_order
)
SELECT
  ea.id,
  'p_referral_date',
  'Referral Date',
  'date',
  TRUE,
  30
FROM metadata.entity_actions ea
WHERE ea.table_name = 'clients'
  AND ea.action_name = 'refer'
ON CONFLICT DO NOTHING;

-- "Mark Not Completed" parameter: outcome notes
INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name,
  param_type, required, sort_order, placeholder
)
SELECT
  ea.id,
  'p_outcome_notes',
  'Outcome Notes',
  'text',
  TRUE,
  10,
  'Explain why the referral was not completed...'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'referrals'
  AND ea.action_name = 'not_completed'
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 6. AUTO-CREATE SURVEY ON REFERRAL CREATION
-- ============================================================================

-- When a referral is created, automatically create a pending follow-up survey
CREATE OR REPLACE FUNCTION create_survey_for_referral()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO follow_up_surveys (referral_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER create_survey_after_referral_insert
  AFTER INSERT ON referrals
  FOR EACH ROW EXECUTE FUNCTION create_survey_for_referral();


-- ============================================================================
-- 6b. AUTO-COMPLETE SURVEY ON RESPONSE
-- ============================================================================
-- When a client (or staff on their behalf) fills in the three response fields,
-- auto-transition from Pending → Completed with completed_date = today.
-- Uses BEFORE UPDATE so the status change is part of the same save operation.

CREATE OR REPLACE FUNCTION auto_complete_survey()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only act on pending surveys where all three responses are now filled
  IF NEW.helpfulness_id IS NOT NULL
     AND NEW.time_to_contact_id IS NOT NULL
     AND NEW.outcome_id IS NOT NULL
     AND OLD.status_id = get_status_id('survey', 'pending')
  THEN
    NEW.status_id := get_status_id('survey', 'completed');
    NEW.completed_date := CURRENT_DATE;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_complete_survey_on_update
  BEFORE UPDATE ON follow_up_surveys
  FOR EACH ROW EXECUTE FUNCTION auto_complete_survey();


-- ============================================================================
-- 7. REFERRAL NOTIFICATION PIPELINE
-- ============================================================================

-- Notification template for referral creation emails
INSERT INTO metadata.notification_templates (
  name, description, entity_type,
  subject_template, html_template, text_template
) VALUES (
  'referral_created',
  'Notify client and partner when a referral is created',
  'referrals',

  -- Subject
  'Referral: {{.Entity.client_name}} → {{.Entity.partner_name}}',

  -- HTML Template
  '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
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

    <p style="color: #6b7280; font-size: 14px;">
      Referred by {{.Entity.staff_name}} at the International Center of Greater Flint.
    </p>
  </div>',

  -- Text Template
  'New Referral Created

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

Referred by {{.Entity.staff_name}}, International Center of Greater Flint.'
)
ON CONFLICT (name) DO NOTHING;


-- RPC to send referral notification email
-- Called by property change trigger on referral creation
CREATE OR REPLACE FUNCTION send_referral_notification(p_referral_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_email TEXT;
  v_client_name TEXT;
  v_partner_email TEXT;
  v_partner_name TEXT;
  v_partner_contact TEXT;
  v_partner_phone TEXT;
  v_partner_address TEXT;
  v_partner_website TEXT;
  v_staff_email TEXT;
  v_staff_name TEXT;
  v_referral_type TEXT;
  v_referral_type_key TEXT;
  v_referral_date TEXT;
  v_service_categories TEXT;
  v_to_addresses TEXT[];
  v_cc_addresses TEXT[];
BEGIN
  -- Gather referral details
  -- Note: staff email is in civic_os_users_private, not civic_os_users
  SELECT
    c.email, c.display_name,
    p.email, p.display_name, p.contact_name, p.phone, p.address, p.website,
    cup.email, cup.display_name,
    cat.display_name, cat.category_key,
    to_char(r.referral_date, 'YYYY-MM-DD')
  INTO
    v_client_email, v_client_name,
    v_partner_email, v_partner_name, v_partner_contact, v_partner_phone, v_partner_address, v_partner_website,
    v_staff_email, v_staff_name,
    v_referral_type, v_referral_type_key,
    v_referral_date
  FROM referrals r
  JOIN clients c ON r.client_id = c.id
  JOIN partners p ON r.partner_id = p.id
  LEFT JOIN metadata.civic_os_users_private cup ON r.referred_by = cup.id
  LEFT JOIN metadata.categories cat ON r.referral_type_id = cat.id
  WHERE r.id = p_referral_id;

  -- Aggregate service categories for this referral
  SELECT string_agg(sc.display_name, ', ' ORDER BY sc.sort_order)
  INTO v_service_categories
  FROM referral_service_categories rsc
  JOIN service_categories sc ON rsc.service_category_id = sc.id
  WHERE rsc.referral_id = p_referral_id;

  -- Build recipient lists based on referral type:
  --   Warm: client (To) + partner (To) + staff (CC)
  --   Info: client (To) + staff (CC) — partner info is in the body but they're not emailed
  v_to_addresses := ARRAY[]::TEXT[];
  IF v_client_email IS NOT NULL THEN
    v_to_addresses := v_to_addresses || v_client_email;
  END IF;
  IF v_referral_type_key = 'warm' AND v_partner_email IS NOT NULL THEN
    v_to_addresses := v_to_addresses || v_partner_email;
  END IF;

  v_cc_addresses := ARRAY[]::TEXT[];
  IF v_staff_email IS NOT NULL THEN
    v_cc_addresses := v_cc_addresses || v_staff_email;
  END IF;

  -- Only send if we have at least one recipient
  IF array_length(v_to_addresses, 1) > 0 THEN
    PERFORM metadata.send_email(
      p_to_addresses  := v_to_addresses,
      p_template_name := 'referral_created',
      p_cc_addresses  := v_cc_addresses,
      p_entity_type   := 'referrals',
      p_entity_id     := p_referral_id::TEXT,
      p_entity_data   := jsonb_build_object(
        'client_name', COALESCE(v_client_name, 'Unknown'),
        'partner_name', COALESCE(v_partner_name, 'Unknown'),
        'partner_contact', v_partner_contact,
        'partner_email', v_partner_email,
        'partner_phone', v_partner_phone,
        'partner_address', v_partner_address,
        'partner_website', v_partner_website,
        'staff_name', COALESCE(v_staff_name, 'Staff'),
        'referral_type', COALESCE(v_referral_type, 'Referral'),
        'referral_date', COALESCE(v_referral_date, ''),
        'service_categories', COALESCE(v_service_categories, 'Not specified')
      )
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION send_referral_notification TO authenticated;

-- Trigger function wrapper for property change trigger system
CREATE OR REPLACE FUNCTION trigger_referral_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM send_referral_notification(NEW.id);
  RETURN NEW;
END;
$$;

-- Register property change trigger: fire on referral creation
-- Uses change_type='set' on partner_id (always non-NULL on insert)
INSERT INTO metadata.property_change_triggers (
  table_name, property_name, change_type, change_value,
  function_name, display_name, description
) VALUES (
  'referrals', 'partner_id', 'set', NULL,
  'trigger_referral_notification',
  'Send referral notification email',
  'AFTER trigger: sends referral_created email to client (To), partner (To), and staff (CC) when a referral is created.'
)
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 8. SURVEY REMINDER SCHEDULED JOB
-- ============================================================================

-- Notification template for survey reminders
INSERT INTO metadata.notification_templates (
  name, description, entity_type,
  subject_template, html_template, text_template
) VALUES (
  'survey_reminder',
  'Remind client to complete follow-up survey',
  'follow_up_surveys',

  -- Subject
  'Reminder: Please complete your referral follow-up survey',

  -- HTML Template
  '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
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
    <p style="color: #6b7280; font-size: 14px;">
      International Center of Greater Flint
    </p>
  </div>',

  -- Text Template
  'Follow-Up Survey Reminder

Hello {{.Entity.client_name}},

We would like to hear about your experience with your recent referral to {{.Entity.partner_name}}.

Referral Date: {{.Entity.referral_date}}
Partner: {{.Entity.partner_name}}
Services: {{.Entity.service_categories}}

Complete your survey here: {{.Metadata.site_url}}/edit/follow_up_surveys/{{.Entity.survey_id}}

International Center of Greater Flint'
)
ON CONFLICT (name) DO NOTHING;


-- Scheduled job RPC: runs daily to send survey reminders and expire old surveys
CREATE OR REPLACE FUNCTION run_survey_reminders()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reminders_sent INT := 0;
  v_surveys_expired INT := 0;
  v_survey RECORD;
  v_client_email TEXT;
  v_client_name TEXT;
  v_partner_name TEXT;
  v_referral_date TEXT;
  v_service_categories TEXT;
  v_days_since INT;
  v_pending_status_id INT;
  v_expired_status_id INT;
BEGIN
  v_pending_status_id := get_status_id('survey', 'pending');
  v_expired_status_id := get_status_id('survey', 'expired');

  -- Find pending surveys with referrals created 3, 5, or 7+ days ago
  FOR v_survey IN
    SELECT
      s.id AS survey_id,
      r.id AS referral_id,
      r.referral_date,
      c.email AS client_email,
      c.display_name AS client_name,
      p.display_name AS partner_name,
      (CURRENT_DATE - r.referral_date) AS days_since
    FROM follow_up_surveys s
    JOIN referrals r ON s.referral_id = r.id
    JOIN clients c ON r.client_id = c.id
    JOIN partners p ON r.partner_id = p.id
    WHERE s.status_id = v_pending_status_id
      AND (CURRENT_DATE - r.referral_date) IN (3, 5, 7)
  LOOP
    -- Gather service categories for this referral
    SELECT string_agg(sc.display_name, ', ' ORDER BY sc.sort_order)
    INTO v_service_categories
    FROM referral_service_categories rsc
    JOIN service_categories sc ON rsc.service_category_id = sc.id
    WHERE rsc.referral_id = v_survey.referral_id;

    -- Send reminder email if client has email
    IF v_survey.client_email IS NOT NULL THEN
      PERFORM metadata.send_email(
        p_to_addresses  := ARRAY[v_survey.client_email],
        p_template_name := 'survey_reminder',
        p_entity_type   := 'follow_up_surveys',
        p_entity_id     := v_survey.survey_id::TEXT,
        p_entity_data   := jsonb_build_object(
          'client_name', COALESCE(v_survey.client_name, 'Client'),
          'partner_name', COALESCE(v_survey.partner_name, 'Partner'),
          'referral_date', to_char(v_survey.referral_date, 'YYYY-MM-DD'),
          'service_categories', COALESCE(v_service_categories, 'Not specified'),
          'survey_id', v_survey.survey_id
        )
      );
      v_reminders_sent := v_reminders_sent + 1;
    END IF;
  END LOOP;

  -- Expire surveys older than 7 days
  UPDATE follow_up_surveys s
  SET status_id = v_expired_status_id,
      updated_at = NOW()
  FROM referrals r
  WHERE s.referral_id = r.id
    AND s.status_id = v_pending_status_id
    AND (CURRENT_DATE - r.referral_date) > 7;

  GET DIAGNOSTICS v_surveys_expired = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', TRUE,
    'message', format('Sent %s reminders, expired %s surveys', v_reminders_sent, v_surveys_expired),
    'details', jsonb_build_object(
      'reminders_sent', v_reminders_sent,
      'surveys_expired', v_surveys_expired
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', FALSE,
    'message', SQLERRM
  );
END;
$$;

GRANT EXECUTE ON FUNCTION run_survey_reminders TO authenticated;

-- Register scheduled job: run daily at 8 AM Eastern
INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES (
  'survey_reminders',
  'run_survey_reminders',
  '0 8 * * *',
  'America/Detroit',
  'Sends survey reminders at 3, 5, and 7 days after referral creation. Expires surveys after 7 days with no response.'
)
ON CONFLICT (name) DO UPDATE SET
  function_name = EXCLUDED.function_name,
  schedule = EXCLUDED.schedule,
  timezone = EXCLUDED.timezone,
  description = EXCLUDED.description;


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
