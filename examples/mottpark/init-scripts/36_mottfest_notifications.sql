-- =============================================================================
-- MOTT FEST - NOTIFICATIONS AND STATUS NOTES
-- =============================================================================
-- Emails and audit notes for the three Mott Fest application pipelines
-- (vendor_application, food_truck_application, sponsorship_application).
--
--   1. Instance config key mottfest_contact_email (group "Mott Fest"), read by
--      every template as {{.Config.mottfest_contact_email}}.
--   2. mottfest_notification_data(table, id): the one payload every template
--      reads. Every text field is coalesced to '' and every flag is a real
--      boolean, because the worker renders a missing or null key as "<no value>".
--   3. Eight templates (ON CONFLICT (name) DO UPDATE: the module owns them).
--   4. Triggers on each application table:
--        notify_mottfest_application_submitted  AFTER INSERT, Pending only:
--          organizers (mottfest_admin) get "submitted", the applicant gets
--          "received".
--        notify_mottfest_application_update     AFTER UPDATE OF status_id,
--          preferred_payment_method_id: one email per status change, chosen
--          by the new status; plus the approved email again when an organizer
--          switches an approved applicant to online card payment.
--        add_mottfest_status_change_note         AFTER UPDATE OF status_id:
--          a system note with the actor, amounts and reasons.
--
-- Recipients are role keys only in send_notification_to_role(); everything
-- else is permission-based. Idempotent.
--
-- Requires: 34_mottfest_schema.sql, 35_mottfest_actions_payments.sql,
--           Civic OS v0.79.0+ (instance_config, {{.Config.*}} in templates)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. CONTACT EMAIL (instance config)
-- =============================================================================

INSERT INTO metadata.instance_config_groups (group_key, display_name, description, sort_order)
VALUES ('mottfest', 'Mott Fest', 'Settings for the Mott Fest vendor, food truck and sponsorship applications.', 50)
ON CONFLICT (group_key) DO NOTHING;

-- default_value is a placeholder; set the real address at /admin/config.
INSERT INTO metadata.instance_config
  (config_key, config_value, default_value, config_type, display_name, description, group_key, sort_order, is_public)
VALUES
  ('mottfest_contact_email', NULL, 'mottfest@example.org', 'string', 'Mott Fest contact email',
   'Shown in every Mott Fest email as the address applicants write to with questions.',
   'mottfest', 10, FALSE)
ON CONFLICT (config_key) DO NOTHING;

-- =============================================================================
-- 2. PAYLOAD HELPER
-- =============================================================================

CREATE OR REPLACE FUNCTION public.mottfest_notification_data(p_table TEXT, p_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_name_col TEXT;
  v_label TEXT;
  r RECORD;
BEGIN
  CASE p_table
    WHEN 'vendor_application'      THEN v_name_col := 'business_name'; v_label := 'Booth Vendor';
    WHEN 'food_truck_application'  THEN v_name_col := 'business_name'; v_label := 'Food Truck';
    WHEN 'sponsorship_application' THEN v_name_col := 'sponsor_name';  v_label := 'Sponsorship';
    ELSE RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END CASE;

  EXECUTE format($q$
    SELECT a.id,
           a.%I AS name,
           a.contact_name,
           a.amount_due::numeric AS amount_due,
           a.paid_amount::numeric AS paid_amount,
           a.denial_reason,
           a.withdrawal_reason,
           to_jsonb(a) ->> 'waiver_reason' AS waiver_reason,
           to_jsonb(a) ->> 'in_kind_description' AS in_kind_description,
           (SELECT c.display_name FROM metadata.categories c
             WHERE c.id = (to_jsonb(a) ->> 'tier_id')::INT) AS tier_label,
           f.display_name AS festival_name,
           f.event_date,
           f.payment_due_date,
           pm.display_name AS recorded_method,
           pp.status_key AS pref_key,
           pp.display_name AS pref_name
      FROM public.%I a
      JOIN public.festival f ON f.id = a.festival_id
      LEFT JOIN metadata.statuses pm ON pm.id = a.payment_method_id
      LEFT JOIN metadata.statuses pp ON pp.id = a.preferred_payment_method_id
     WHERE a.id = $1$q$, v_name_col, p_table)
  INTO r
  USING p_id;

  IF r.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id',                       r.id,
    'pipeline_label',           v_label,
    'name',                     COALESCE(r.name, ''),
    'contact_name',             COALESCE(r.contact_name, ''),
    'festival_name',            COALESCE(r.festival_name, ''),
    'event_date_display',       COALESCE(to_char(r.event_date, 'FMDay, FMMonth FMDD, YYYY'), ''),
    'payment_due_date_display', COALESCE(to_char(r.payment_due_date, 'FMMonth FMDD, YYYY'), ''),
    'payment_is_past_due',      COALESCE((NOW() AT TIME ZONE 'America/Detroit')::DATE > r.payment_due_date, FALSE),
    'amount_due_display',       mottfest_money_text(r.amount_due),
    'has_fee',                  COALESCE(r.amount_due, 0) > 0,
    'paid_amount_display',      mottfest_money_text(r.paid_amount),
    'pays_online',              COALESCE(r.pref_key = 'credit_card', FALSE),
    'payment_method',           COALESCE(r.recorded_method, r.pref_name, ''),
    'tier_label',               COALESCE(r.tier_label, ''),
    'in_kind_description',      COALESCE(r.in_kind_description, ''),
    'denial_reason',            COALESCE(r.denial_reason, ''),
    'withdrawal_reason',        COALESCE(r.withdrawal_reason, ''),
    'waiver_reason',            COALESCE(r.waiver_reason, ''),
    'view_path',                format('/view/%s/%s', p_table, r.id),
    'pay_path',                 format('/view/%s/%s', p_table, r.id)
  );
END;
$$;

-- =============================================================================
-- 3. TEMPLATES
-- =============================================================================
-- HTML follows the clubhouse templates (Arial, #06B6D4 heading and button).
-- Every template ends with the contact line and the association signature.

INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, text_template, html_template)
VALUES
-- 1. Organizers: new application -------------------------------------------
('mottfest_application_submitted',
 'Mott Fest: tells organizers (mottfest_admin) a new application is waiting for review.',
 NULL,
 $t$New {{.Entity.pipeline_label}} application: {{.Entity.name}}$t$,
 $t$A new Mott Fest {{.Entity.pipeline_label}} application is waiting for review.

{{.Entity.name}} — contact {{.Entity.contact_name}}
Festival: {{.Entity.festival_name}}
Fee: {{.Entity.amount_due_display}}{{if .Entity.tier_label}} ({{.Entity.tier_label}}){{end}}

Review it: {{.Metadata.site_url}}{{.Entity.view_path}}

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">New {{.Entity.pipeline_label}} application</h2>
<p>A new Mott Fest {{.Entity.pipeline_label}} application is waiting for review.</p>
<p><strong>{{.Entity.name}}</strong> — contact {{.Entity.contact_name}}<br>
Festival: {{.Entity.festival_name}}<br>
Fee: {{.Entity.amount_due_display}}{{if .Entity.tier_label}} ({{.Entity.tier_label}}){{end}}</p>
<p><a href="{{.Metadata.site_url}}{{.Entity.view_path}}" style="display: inline-block; background-color: #06B6D4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Review application</a></p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 2. Applicant: received ------------------------------------------------------
('mottfest_application_received',
 'Mott Fest: confirms to the applicant that their application was received.',
 NULL,
 $t$We received your Mott Fest {{.Entity.pipeline_label}} application$t$,
 $t$Hi {{.Entity.contact_name}},

Thank you for applying to {{.Entity.festival_name}} on {{.Entity.event_date_display}}. We received your {{.Entity.pipeline_label}} application for {{.Entity.name}}.

Our committee will review it and email you with a decision.{{if .Entity.has_fee}} Once approved, payment is due by {{.Entity.payment_due_date_display}}.{{end}}

View your application: {{.Metadata.site_url}}{{.Entity.view_path}}

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">We received your application</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>Thank you for applying to {{.Entity.festival_name}} on {{.Entity.event_date_display}}. We received your {{.Entity.pipeline_label}} application for <strong>{{.Entity.name}}</strong>.</p>
<p>Our committee will review it and email you with a decision.{{if .Entity.has_fee}} Once approved, payment is due by {{.Entity.payment_due_date_display}}.{{end}}</p>
<p><a href="{{.Metadata.site_url}}{{.Entity.view_path}}" style="display: inline-block; background-color: #06B6D4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">View your application</a></p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 3. Applicant: approved, payment due ---------------------------------------
('mottfest_application_approved',
 'Mott Fest: tells the applicant they are approved and how to pay. Sent again when an organizer enables online payment.',
 NULL,
 $t$You're approved for {{.Entity.festival_name}}!$t$,
 $t$Hi {{.Entity.contact_name}},

Good news: your {{.Entity.pipeline_label}} application for {{.Entity.name}} is approved for {{.Entity.festival_name}} on {{.Entity.event_date_display}}.

Amount due: {{.Entity.amount_due_display}}
{{if .Entity.payment_is_past_due}}Payment is due now.{{else}}Payment is due by {{.Entity.payment_due_date_display}}.{{end}}

{{if .Entity.pays_online}}Pay online (a card processing fee is added): {{.Metadata.site_url}}{{.Entity.pay_path}}{{else}}You chose to pay by {{.Entity.payment_method}}. Mail a check or money order payable to Mott Park Recreation Association, 2401 Nolen Dr., Flint, MI 48504, or contact us to arrange cash or CashApp. Prefer to pay online by card? Reply and we'll send you a payment link.{{end}}

We'll confirm when your payment is received.

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">You're approved for {{.Entity.festival_name}}!</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>Good news: your {{.Entity.pipeline_label}} application for <strong>{{.Entity.name}}</strong> is approved for {{.Entity.festival_name}} on {{.Entity.event_date_display}}.</p>
<p><strong>Amount due:</strong> {{.Entity.amount_due_display}}<br>
{{if .Entity.payment_is_past_due}}Payment is due now.{{else}}Payment is due by {{.Entity.payment_due_date_display}}.{{end}}</p>
{{if .Entity.pays_online}}<p>Pay online by card (a card processing fee is added):</p>
<p><a href="{{.Metadata.site_url}}{{.Entity.pay_path}}" style="display: inline-block; background-color: #06B6D4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Pay now</a></p>{{else}}<p>You chose to pay by {{.Entity.payment_method}}. Mail a check or money order payable to <strong>Mott Park Recreation Association, 2401 Nolen Dr., Flint, MI 48504</strong>, or contact us to arrange cash or CashApp.</p>
<p>Prefer to pay online by card? Reply and we'll send you a payment link.</p>{{end}}
<p>We'll confirm when your payment is received.</p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 4. Applicant: approved, fee waived (vendors) ------------------------------
('mottfest_application_waived',
 'Mott Fest: tells a vendor they are approved with the booth fee waived.',
 NULL,
 $t$You're in for {{.Entity.festival_name}} — no fee due$t$,
 $t$Hi {{.Entity.contact_name}},

Your {{.Entity.pipeline_label}} application for {{.Entity.name}} is approved, and your booth fee is waived.

There's nothing to pay. We look forward to seeing you on {{.Entity.event_date_display}}!

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">You're in for {{.Entity.festival_name}}</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>Your {{.Entity.pipeline_label}} application for <strong>{{.Entity.name}}</strong> is approved, and your booth fee is waived.</p>
<p>There's nothing to pay. We look forward to seeing you on {{.Entity.event_date_display}}!</p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 5. Sponsor: in-kind accepted ----------------------------------------------
('mottfest_sponsorship_in_kind',
 'Mott Fest: thanks a sponsor whose in-kind gift was accepted.',
 NULL,
 $t$Thank you for supporting {{.Entity.festival_name}}!$t$,
 $t$Hi {{.Entity.contact_name}},

Thank you! Your in-kind sponsorship of {{.Entity.festival_name}} from {{.Entity.name}} is accepted:

{{.Entity.in_kind_description}}

A member of our committee will be in touch about the details.

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">Thank you for supporting {{.Entity.festival_name}}!</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>Thank you! Your in-kind sponsorship of {{.Entity.festival_name}} from <strong>{{.Entity.name}}</strong> is accepted:</p>
<p>{{.Entity.in_kind_description}}</p>
<p>A member of our committee will be in touch about the details.</p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 6. Applicant: payment received --------------------------------------------
('mottfest_payment_received',
 'Mott Fest: confirms a payment (online or recorded by an organizer).',
 NULL,
 $t$Payment received — you're all set for {{.Entity.festival_name}}$t$,
 $t$Hi {{.Entity.contact_name}},

We received your payment of {{.Entity.paid_amount_display}} ({{.Entity.payment_method}}) for {{.Entity.name}}.

{{if eq .Entity.pipeline_label "Sponsorship"}}Thank you for sponsoring {{.Entity.festival_name}}!{{else}}You're all set for {{.Entity.festival_name}} on {{.Entity.event_date_display}}.{{end}}

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">Payment received</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>We received your payment of <strong>{{.Entity.paid_amount_display}}</strong> ({{.Entity.payment_method}}) for {{.Entity.name}}.</p>
<p>{{if eq .Entity.pipeline_label "Sponsorship"}}Thank you for sponsoring {{.Entity.festival_name}}!{{else}}You're all set for {{.Entity.festival_name}} on {{.Entity.event_date_display}}.{{end}}</p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 7. Applicant: denied --------------------------------------------------------
('mottfest_application_denied',
 'Mott Fest: tells the applicant their application was not approved, with the reason.',
 NULL,
 $t$Update on your Mott Fest {{.Entity.pipeline_label}} application$t$,
 $t$Hi {{.Entity.contact_name}},

Thank you for applying to {{.Entity.festival_name}}. We're not able to approve your {{.Entity.pipeline_label}} application for {{.Entity.name}}.

Reason: {{.Entity.denial_reason}}

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">Update on your application</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>Thank you for applying to {{.Entity.festival_name}}. We're not able to approve your {{.Entity.pipeline_label}} application for <strong>{{.Entity.name}}</strong>.</p>
<p><strong>Reason:</strong> {{.Entity.denial_reason}}</p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$),

-- 8. Applicant: withdrawn -----------------------------------------------------
('mottfest_application_withdrawn',
 'Mott Fest: tells the applicant their application was withdrawn by the organizers, with the reason.',
 NULL,
 $t$Your Mott Fest {{.Entity.pipeline_label}} application has been withdrawn$t$,
 $t$Hi {{.Entity.contact_name}},

Your {{.Entity.pipeline_label}} application for {{.Entity.name}} ({{.Entity.festival_name}}) has been withdrawn.

Reason: {{.Entity.withdrawal_reason}}

Questions? Email {{.Config.mottfest_contact_email}}.

— Mott Park Recreation Association$t$,
 $t$<div style="font-family: Arial, sans-serif;">
<h2 style="color: #06B6D4;">Your application has been withdrawn</h2>
<p>Hi {{.Entity.contact_name}},</p>
<p>Your {{.Entity.pipeline_label}} application for <strong>{{.Entity.name}}</strong> ({{.Entity.festival_name}}) has been withdrawn.</p>
<p><strong>Reason:</strong> {{.Entity.withdrawal_reason}}</p>
<p>Questions? Email {{.Config.mottfest_contact_email}}.</p>
<p>— Mott Park Recreation Association</p>
</div>$t$)
ON CONFLICT (name) DO UPDATE SET
  description      = EXCLUDED.description,
  entity_type      = EXCLUDED.entity_type,
  subject_template = EXCLUDED.subject_template,
  text_template    = EXCLUDED.text_template,
  html_template    = EXCLUDED.html_template,
  updated_at       = NOW();

-- =============================================================================
-- 4. TRIGGERS
-- =============================================================================

-- 4.1 Submitted: only rows that start in Pending. Organizers entering a record
-- directly in another status (or with no applicant) send nothing to the
-- applicant, and nothing to organizers unless it is Pending.
CREATE OR REPLACE FUNCTION public.notify_mottfest_application_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_data JSONB;
BEGIN
  IF NEW.status_id IS DISTINCT FROM get_status_id(mottfest_entity_type(TG_TABLE_NAME), 'pending') THEN
    RETURN NULL;
  END IF;

  v_data := mottfest_notification_data(TG_TABLE_NAME::TEXT, NEW.id);

  PERFORM metadata.send_notification_to_role(
    ARRAY['mottfest_admin']::TEXT[], 'mottfest_application_submitted',
    TG_TABLE_NAME::TEXT, NEW.id::TEXT, v_data, ARRAY['email']::TEXT[]);

  IF NEW.applicant_id IS NOT NULL THEN
    PERFORM public.create_notification(
      NEW.applicant_id, 'mottfest_application_received',
      TG_TABLE_NAME::TEXT, NEW.id::TEXT, v_data, ARRAY['email']::TEXT[]);
  END IF;

  RETURN NULL;
END;
$$;

-- 4.2 Updates: one applicant email per status change, plus the approved email
-- again when the payment preference moves to Credit Card on an Approved row
-- (the Enable Online Payment action), so the applicant gets the pay link.
CREATE OR REPLACE FUNCTION public.notify_mottfest_application_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_new_key TEXT;
  v_template TEXT;
BEGIN
  IF NEW.applicant_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT status_key INTO v_new_key FROM metadata.statuses WHERE id = NEW.status_id;

  IF OLD.status_id IS DISTINCT FROM NEW.status_id THEN
    v_template := CASE v_new_key
      WHEN 'approved'  THEN 'mottfest_application_approved'
      WHEN 'waived'    THEN 'mottfest_application_waived'
      WHEN 'in_kind'   THEN 'mottfest_sponsorship_in_kind'
      WHEN 'paid'      THEN 'mottfest_payment_received'
      WHEN 'denied'    THEN 'mottfest_application_denied'
      WHEN 'withdrawn' THEN 'mottfest_application_withdrawn'
    END;
  ELSIF v_new_key = 'approved'
    AND OLD.preferred_payment_method_id IS DISTINCT FROM NEW.preferred_payment_method_id
    AND NEW.preferred_payment_method_id = get_status_id('payment_method', 'credit_card') THEN
    v_template := 'mottfest_application_approved';
  END IF;

  IF v_template IS NOT NULL THEN
    PERFORM public.create_notification(
      NEW.applicant_id, v_template, TG_TABLE_NAME::TEXT, NEW.id::TEXT,
      mottfest_notification_data(TG_TABLE_NAME::TEXT, NEW.id), ARRAY['email']::TEXT[]);
  END IF;

  RETURN NULL;
END;
$$;

-- 4.3 System note on every status change. Inserted directly (like the Stripe
-- sync note in script 35) so it also works for webhooks, which run without a
-- user; the actor is then "online card payment" or "System".
CREATE OR REPLACE FUNCTION public.add_mottfest_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_old_name TEXT;
  v_new_name TEXT;
  v_new_key TEXT;
  v_actor TEXT;
  v_row JSONB := to_jsonb(NEW);
  v_method TEXT;
  v_detail TEXT := '';
BEGIN
  SELECT display_name INTO v_old_name FROM metadata.statuses WHERE id = OLD.status_id;
  SELECT display_name, status_key INTO v_new_name, v_new_key FROM metadata.statuses WHERE id = NEW.status_id;

  SELECT display_name INTO v_actor FROM metadata.civic_os_users WHERE id = current_user_id();
  v_actor := COALESCE(v_actor, CASE WHEN v_new_key = 'paid' THEN 'online card payment' ELSE 'System' END);

  CASE v_new_key
    WHEN 'approved' THEN
      v_detail := format(E'\n\n**Amount due:** %s', mottfest_money_text(NEW.amount_due::numeric));
    WHEN 'paid' THEN
      SELECT display_name INTO v_method FROM metadata.statuses WHERE id = NEW.payment_method_id;
      v_detail := format(E'\n\n**Payment:** %s%s', mottfest_money_text(NEW.paid_amount::numeric),
                         COALESCE(' (' || v_method || ')', ''));
    WHEN 'waived' THEN
      v_detail := COALESCE(E'\n\n**Reason:** ' || NULLIF(v_row ->> 'waiver_reason', ''), '');
    WHEN 'denied' THEN
      v_detail := COALESCE(E'\n\n**Reason:** ' || NULLIF(NEW.denial_reason, ''), '');
    WHEN 'withdrawn' THEN
      v_detail := COALESCE(E'\n\n**Reason:** ' || NULLIF(NEW.withdrawal_reason, ''), '');
    ELSE
      NULL;
  END CASE;

  INSERT INTO metadata.entity_notes (entity_type, entity_id, author_id, content, note_type, is_internal)
  VALUES (TG_TABLE_NAME::TEXT, NEW.id::TEXT, current_user_id(),
          format('**Status changed from %s to %s** by %s%s',
                 COALESCE(v_old_name, 'none'), v_new_name, v_actor, v_detail),
          'system', TRUE);

  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS notify_mottfest_application_submitted_trigger ON public.%I', t);
    EXECUTE format('CREATE TRIGGER notify_mottfest_application_submitted_trigger
                      AFTER INSERT ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.notify_mottfest_application_submitted()', t);

    EXECUTE format('DROP TRIGGER IF EXISTS notify_mottfest_application_update_trigger ON public.%I', t);
    EXECUTE format('CREATE TRIGGER notify_mottfest_application_update_trigger
                      AFTER UPDATE OF status_id, preferred_payment_method_id ON public.%I
                      FOR EACH ROW
                      WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id
                         OR OLD.preferred_payment_method_id IS DISTINCT FROM NEW.preferred_payment_method_id)
                      EXECUTE FUNCTION public.notify_mottfest_application_update()', t);

    EXECUTE format('DROP TRIGGER IF EXISTS add_mottfest_status_change_note_trigger ON public.%I', t);
    EXECUTE format('CREATE TRIGGER add_mottfest_status_change_note_trigger
                      AFTER UPDATE OF status_id ON public.%I
                      FOR EACH ROW
                      WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
                      EXECUTE FUNCTION public.add_mottfest_status_change_note()', t);
  END LOOP;
END;
$$;

-- =============================================================================
-- 5. FUNCTION PRIVILEGES (none of these is callable through the API)
-- =============================================================================

REVOKE ALL ON FUNCTION public.mottfest_notification_data(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_mottfest_application_submitted() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_mottfest_application_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_mottfest_status_change_note() FROM PUBLIC;

COMMIT;

-- =============================================================================
-- Schema decisions (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[], ARRAY['status_id', 'preferred_payment_method_id']::NAME[],
  '36_mottfest_notifications',
  'Mott Fest emails from status triggers, with a Pending guard on submit',
  'accepted',
  'Applicants and organizers need an email at each step: a new application, approval with payment instructions, a waiver, an in-kind acceptance, a payment, a denial and a withdrawal. Organizers can also enter records directly in a non-Pending status, and the clubhouse learned (script 27) that an unguarded submit trigger emails managers about records that need no review.',
  'An AFTER INSERT trigger sends the organizer and applicant emails only when the row starts in Pending. An AFTER UPDATE trigger sends one applicant email per status change, chosen by the new status_key, and sends the approved email again when the payment preference of an Approved row moves to Credit Card. Every template reads one payload built by mottfest_notification_data(), with text coalesced to empty strings and real booleans for branches. Organizer recipients are the mottfest_admin role.',
  'Triggers on the status column fire for every path that changes it: action RPCs, the Stripe sync, and the accepted direct-edit gap, so no path can skip the email. One payload function keeps the eight templates consistent and stops the worker from printing "<no value>" for nulls.',
  'A status corrected back and forth sends an email each way. A late online payment on a withdrawn row changes no status and sends nothing (its system note from script 35 flags it). New statuses need a template mapping in notify_mottfest_application_update().',
  CURRENT_DATE
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions
  WHERE migration_id = '36_mottfest_notifications'
    AND title = 'Mott Fest emails from status triggers, with a Pending guard on submit'
);

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[], ARRAY['status_id']::NAME[],
  '36_mottfest_notifications',
  'System note on every Mott Fest status change',
  'accepted',
  'Organizers need an audit trail of who approved, denied, waived or withdrew an application and why. Status changes also come from Stripe webhooks, which run without a user, and create_entity_note() refuses a missing author outside a database-admin session.',
  'An AFTER UPDATE OF status_id trigger inserts a system note (internal) naming the old and new status, the actor (or "online card payment" / "System"), the amount due or paid, and the denial, withdrawal or waiver reason. It inserts into metadata.entity_notes directly, as the Stripe sync note in script 35 does.',
  'A trigger covers every path that changes status, including direct edits. Inserting directly keeps the webhook path working whatever role the payment worker connects as.',
  'Notes are visible only to roles holding the notes permission (organizers and admins). The note text is in English and not translated.',
  CURRENT_DATE
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions
  WHERE migration_id = '36_mottfest_notifications'
    AND title = 'System note on every Mott Fest status change'
);

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
SELECT
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[], NULL,
  '36_mottfest_notifications',
  'Mott Fest contact email as an instance config key',
  'accepted',
  'Every Mott Fest email tells applicants where to send questions. The address belongs to the association, may change between festivals, and differs between the demo and production.',
  'Add the integrator key mottfest_contact_email (group "Mott Fest", not public) with a placeholder default_value, and read it in templates as {{.Config.mottfest_contact_email}}.',
  'Admins change it at /admin/config without editing templates, and the worker picks it up within a minute. A default keeps emails readable before anyone sets it.',
  'Production must set the real address after install, or emails show the placeholder. Re-running the script never overwrites a value an admin set.',
  CURRENT_DATE
WHERE NOT EXISTS (
  SELECT 1 FROM metadata.schema_decisions
  WHERE migration_id = '36_mottfest_notifications'
    AND title = 'Mott Fest contact email as an instance config key'
);
