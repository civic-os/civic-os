-- =====================================================
-- Exemplary Community Services (demo instance)
-- 26: Consent Subsystem
-- =====================================================
-- Runs AFTER the reskinned ECS base scripts (01-25).
-- Consent is a record, not a document (decided 2026-07-15):
-- the client attests, the record expires on a clock, and the
-- referral gate reads the record. Evidence files are optional
-- proof, not the mechanism.
--
-- Requires Civic OS v0.34.0+ (Status, Category, Entity Actions
-- with params v0.32.0+, Scheduled Jobs v0.22.0+, Notifications).
--
-- Style: dates yyyy-mm-dd; semicolons and commas over emdashes
-- in all instance copy.
-- =====================================================

BEGIN;

-- =====================================================
-- 1. CATEGORY: consent method
-- =====================================================

INSERT INTO metadata.category_groups (entity_type, display_name, description)
VALUES ('consent_method', 'Consent Method', 'How the client''s consent was captured')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order) VALUES
  ('consent_method', 'Verbal',  'verbal',  '#3B82F6', 1),
  ('consent_method', 'Written', 'written', '#8B5CF6', 2),
  ('consent_method', 'Portal',  'portal',  '#10B981', 3)
ON CONFLICT DO NOTHING;

-- =====================================================
-- 1b. CATEGORY: consent gate state (on clients)
-- =====================================================
-- Denormalized summary of the client's current consent posture.
-- Rendered as a colored badge on the client list/detail.

INSERT INTO metadata.category_groups (entity_type, display_name, description)
VALUES ('consent_state', 'Consent State', 'Denormalized consent gate status on clients')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, category_key, color, sort_order) VALUES
  ('consent_state', 'None',    'none',    '#9CA3AF', 1),
  ('consent_state', 'Pending', 'pending', '#F59E0B', 2),
  ('consent_state', 'Active',  'active',  '#22C55E', 3),
  ('consent_state', 'Expired', 'expired', '#EF4444', 4),
  ('consent_state', 'Revoked', 'revoked', '#991B1B', 5)
ON CONFLICT DO NOTHING;

-- =====================================================
-- 2. STATUSES: client_consent workflow
-- =====================================================
-- Revoked is a client decision; Expired is a clock;
-- Superseded is replacement by a newer consent. Three
-- different truths, three different statuses.

INSERT INTO metadata.status_types (entity_type, display_name, description)
VALUES ('client_consent', 'Client Consent', 'Consent record lifecycle')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, color, status_key, is_initial, is_terminal, sort_order) VALUES
  ('client_consent', 'Pending',    '#FCD34D', 'pending',    TRUE,  FALSE, 1),
  ('client_consent', 'Active',     '#22C55E', 'active',     FALSE, FALSE, 2),
  ('client_consent', 'Expired',    '#9CA3AF', 'expired',    FALSE, TRUE,  3),
  ('client_consent', 'Revoked',    '#EF4444', 'revoked',    FALSE, TRUE,  4),
  ('client_consent', 'Superseded', '#6B7280', 'superseded', FALSE, TRUE,  5)
ON CONFLICT DO NOTHING;

-- =====================================================
-- 3. TABLES
-- =====================================================

CREATE TABLE public.client_consents (
  id            BIGSERIAL PRIMARY KEY,
  display_name  TEXT GENERATED ALWAYS AS ('Consent #' || id) STORED,
  client_id     BIGINT NOT NULL REFERENCES public.clients(id),
  status_id     INT    NOT NULL REFERENCES metadata.statuses(id),
  method_id     INT             REFERENCES metadata.categories(id),
  granted_date  DATE,
  expires_date  DATE,
  revoked_date  DATE,
  captured_by   UUID            REFERENCES metadata.civic_os_users(id),
  evidence_file UUID            REFERENCES metadata.files(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ,
  CONSTRAINT consent_dates_ordered CHECK (
    granted_date IS NULL OR expires_date IS NULL OR expires_date > granted_date
  )
);

CREATE INDEX idx_client_consents_client_id     ON public.client_consents(client_id);
CREATE INDEX idx_client_consents_status_id     ON public.client_consents(status_id);
CREATE INDEX idx_client_consents_method_id     ON public.client_consents(method_id);
CREATE INDEX idx_client_consents_captured_by   ON public.client_consents(captured_by);
CREATE INDEX idx_client_consents_evidence_file ON public.client_consents(evidence_file);
CREATE INDEX idx_client_consents_expires_date  ON public.client_consents(expires_date);

CREATE TRIGGER set_created_at_trigger BEFORE INSERT ON public.client_consents
  FOR EACH ROW EXECUTE FUNCTION public.set_created_at();
CREATE TRIGGER set_updated_at_trigger BEFORE INSERT OR UPDATE ON public.client_consents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotency ledger for the staff reminder ladder. Not a UI
-- entity; no metadata.entities row.
CREATE TABLE public.consent_reminder_log (
  consent_id BIGINT NOT NULL REFERENCES public.client_consents(id) ON DELETE CASCADE,
  days_out   INT    NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consent_id, days_out)
);

-- =====================================================
-- 4. GATE FIELDS ON CLIENTS
-- =====================================================
-- Entity action conditions evaluate the record's own fields
-- only, so the gate state is denormalized onto clients and
-- maintained by trigger + daily job. consent_note carries the
-- dated, human-readable reason the button is disabled.

ALTER TABLE public.clients
  ADD COLUMN consent_state_id INT REFERENCES metadata.categories(id),
  ADD COLUMN consent_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN consent_note TEXT NOT NULL DEFAULT 'No consent on record';

-- Default consent_state_id to 'none' category
UPDATE public.clients SET consent_state_id = (
  SELECT id FROM metadata.categories WHERE entity_type = 'consent_state' AND category_key = 'none'
);

-- Index for the category FK
CREATE INDEX idx_clients_consent_state_id ON public.clients(consent_state_id);

CREATE OR REPLACE FUNCTION public.recompute_client_consent_gate(p_client_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  r RECORD;
  v_cat_key   TEXT := 'none';
  v_active    BOOLEAN := FALSE;
  v_note      TEXT := 'No consent on record';
  v_state_id  INT;
BEGIN
  -- Priority: Active > Pending > latest terminal. Superseded never governs.
  SELECT cc.expires_date INTO r
  FROM client_consents cc
  JOIN metadata.statuses s ON s.id = cc.status_id
  WHERE cc.client_id = p_client_id
    AND s.entity_type = 'client_consent' AND s.status_key = 'active'
  ORDER BY cc.granted_date DESC NULLS LAST, cc.id DESC
  LIMIT 1;

  IF FOUND THEN
    v_cat_key := 'active';
    v_active  := TRUE;
    v_note    := 'Consent active; expires ' || to_char(r.expires_date, 'YYYY-MM-DD');
  ELSE
    PERFORM 1
    FROM client_consents cc
    JOIN metadata.statuses s ON s.id = cc.status_id
    WHERE cc.client_id = p_client_id
      AND s.entity_type = 'client_consent' AND s.status_key = 'pending';

    IF FOUND THEN
      v_cat_key := 'pending';
      v_note    := 'Consent pending client confirmation';
    ELSE
      SELECT s.status_key, cc.expires_date, cc.revoked_date INTO r
      FROM client_consents cc
      JOIN metadata.statuses s ON s.id = cc.status_id
      WHERE cc.client_id = p_client_id
        AND s.entity_type = 'client_consent'
        AND s.status_key IN ('expired', 'revoked')
      ORDER BY COALESCE(cc.revoked_date, cc.expires_date) DESC NULLS LAST, cc.id DESC
      LIMIT 1;

      IF FOUND THEN
        IF r.status_key = 'revoked' THEN
          v_cat_key := 'revoked';
          v_note    := 'Consent revoked'
                       || COALESCE(' ' || to_char(r.revoked_date, 'YYYY-MM-DD'), '');
        ELSE
          v_cat_key := 'expired';
          v_note    := 'Consent expired'
                       || COALESCE(' ' || to_char(r.expires_date, 'YYYY-MM-DD'), '');
        END IF;
      END IF;
    END IF;
  END IF;

  SELECT id INTO v_state_id
  FROM metadata.categories
  WHERE entity_type = 'consent_state' AND category_key = v_cat_key;

  UPDATE clients
  SET consent_state_id = v_state_id, consent_active = v_active, consent_note = v_note
  WHERE id = p_client_id
    AND (consent_state_id IS DISTINCT FROM v_state_id
         OR consent_active IS DISTINCT FROM v_active
         OR consent_note IS DISTINCT FROM v_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.client_consents_gate_sync()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
  PERFORM recompute_client_consent_gate(NEW.client_id);
  IF TG_OP = 'UPDATE' AND OLD.client_id IS DISTINCT FROM NEW.client_id THEN
    PERFORM recompute_client_consent_gate(OLD.client_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_consents_gate_sync
  AFTER INSERT OR UPDATE OF status_id, expires_date, revoked_date, client_id
  ON public.client_consents
  FOR EACH ROW EXECUTE FUNCTION public.client_consents_gate_sync();

-- =====================================================
-- 5. VIEWS
-- =====================================================

-- Governing consent per client (audit story: history behind, one current)
CREATE OR REPLACE VIEW public.client_current_consents
WITH (security_invoker = true) AS
SELECT DISTINCT ON (cc.client_id)
  cc.id, cc.display_name, cc.client_id, cc.status_id, cc.method_id,
  cc.granted_date, cc.expires_date, cc.revoked_date, cc.captured_by,
  cc.created_at, cc.updated_at
FROM public.client_consents cc
JOIN metadata.statuses s ON s.id = cc.status_id
WHERE s.entity_type = 'client_consent' AND s.status_key <> 'superseded'
ORDER BY cc.client_id,
         (s.status_key = 'active') DESC,
         (s.status_key = 'pending') DESC,
         COALESCE(cc.revoked_date, cc.expires_date, cc.granted_date) DESC NULLS LAST,
         cc.id DESC;

-- Dashboard filtered-list source: active consents expiring within 30 days
CREATE OR REPLACE VIEW public.consents_expiring_soon
WITH (security_invoker = true) AS
SELECT cc.id, cc.display_name, cc.client_id, c.display_name AS client_name,
       cc.expires_date, (cc.expires_date - CURRENT_DATE) AS days_remaining
FROM public.client_consents cc
JOIN metadata.statuses s ON s.id = cc.status_id
JOIN public.clients c ON c.id = cc.client_id
WHERE s.entity_type = 'client_consent' AND s.status_key = 'active'
  AND cc.expires_date <= CURRENT_DATE + 30
ORDER BY cc.expires_date;

GRANT SELECT ON public.client_current_consents, public.consents_expiring_soon TO authenticated;

-- =====================================================
-- 6. RPCS
-- =====================================================

-- Staff-assisted capture (DS-08, primary path). Supersedes any
-- prior Active or Pending consent; history stays truthful.
CREATE OR REPLACE FUNCTION public.record_client_consent(
  p_entity_id    BIGINT,
  p_method_id    INT,
  p_granted_date DATE DEFAULT CURRENT_DATE,
  p_expires_date DATE DEFAULT NULL,
  p_evidence     UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_expires DATE := COALESCE(p_expires_date, p_granted_date + INTERVAL '1 year');
BEGIN
  IF NOT has_permission('client_consents', 'create') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  UPDATE client_consents cc
  SET status_id = get_status_id('client_consent', 'superseded')
  FROM metadata.statuses s
  WHERE s.id = cc.status_id
    AND cc.client_id = p_entity_id
    AND s.entity_type = 'client_consent'
    AND s.status_key IN ('active', 'pending');

  INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date, captured_by, evidence_file)
  VALUES (p_entity_id, get_status_id('client_consent', 'active'), p_method_id,
          p_granted_date, v_expires, current_user_id(), p_evidence);

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := p_entity_id::TEXT,
    p_content     := 'Consent recorded; active through ' || to_char(v_expires, 'YYYY-MM-DD'),
    p_note_type   := 'system'
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Consent recorded; active through ' || to_char(v_expires, 'YYYY-MM-DD'),
    'refresh', true
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_client_consent(BIGINT, INT, DATE, DATE, UUID) TO authenticated;

-- Request Consent (DS-10 companion action). Creates a Pending
-- record and emails the client; honest failure if no email.
CREATE OR REPLACE FUNCTION public.request_client_consent(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_client RECORD;
  v_consent_id BIGINT;
BEGIN
  IF NOT has_permission('client_consents', 'create') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  SELECT * INTO v_client FROM clients WHERE id = p_entity_id;

  IF v_client.email IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Client has no email address; record consent manually.');
  END IF;

  INSERT INTO client_consents (client_id, status_id, captured_by)
  VALUES (p_entity_id, get_status_id('client_consent', 'pending'), current_user_id())
  RETURNING id INTO v_consent_id;

  IF v_client.user_id IS NOT NULL THEN
    PERFORM create_notification(
      p_user_id       := v_client.user_id,
      p_template_name := 'consent_request',
      p_entity_type   := 'client_consents',
      p_entity_id     := v_consent_id::TEXT,
      p_entity_data   := jsonb_build_object(
        'client_name', v_client.display_name,
        'org_name', 'Exemplary Community Services'),
      p_channels      := ARRAY['email']::TEXT[]
    );
  END IF;

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := p_entity_id::TEXT,
    p_content     := 'Consent request sent to ' || v_client.display_name,
    p_note_type   := 'system'
  );

  RETURN jsonb_build_object('success', true,
    'message', 'Consent request sent to ' || v_client.display_name, 'refresh', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_client_consent(BIGINT) TO authenticated;

-- Transition RPC: stamp revoked_date on Active/Pending -> Revoked
CREATE OR REPLACE FUNCTION public.revoke_client_consent(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
  UPDATE client_consents SET revoked_date = CURRENT_DATE WHERE id = p_entity_id;
  RETURN jsonb_build_object('success', true, 'message', 'Consent revoked');
END;
$$;
GRANT EXECUTE ON FUNCTION public.revoke_client_consent(BIGINT) TO authenticated;

-- =====================================================
-- 7. STATUS TRANSITIONS
-- =====================================================

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
  ('client_consent', get_status_id('client_consent', 'pending'), get_status_id('client_consent', 'active'),
   NULL, 'Confirm', 'Client confirmed consent; record becomes active.'),
  ('client_consent', get_status_id('client_consent', 'active'), get_status_id('client_consent', 'revoked'),
   'revoke_client_consent', 'Revoke', 'Client withdrew consent; referral is blocked.'),
  ('client_consent', get_status_id('client_consent', 'pending'), get_status_id('client_consent', 'revoked'),
   'revoke_client_consent', 'Client Declined', 'Client declined to give consent.')
ON CONFLICT DO NOTHING;
-- Active -> Expired is system-only via run_consent_maintenance(); no manual transition.

-- =====================================================
-- 8. ENTITY ACTIONS
-- =====================================================

-- Gate the existing Refer Client action (action_name = 'refer' in 06_actions.sql).
UPDATE metadata.entity_actions
SET enabled_condition = '{"field": "consent_active", "operator": "eq", "value": true}'::jsonb,
    disabled_tooltip  = 'Referral requires active consent; see Consent State on this record.'
WHERE table_name = 'clients' AND action_name = 'refer';

-- Record Consent (staff-assisted capture with params modal)
-- sort_order=25 avoids conflict with deactivate at 20
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, refresh_after_action)
VALUES ('clients', 'record_consent', 'Record Consent',
    'Record verbal, written, or portal consent on the client''s behalf.',
    'record_client_consent', 'verified_user', 'success', 25, FALSE, TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO metadata.entity_action_params (entity_action_id, param_name, display_name, param_type, required, sort_order, category_entity_type, default_value, placeholder, file_type)
SELECT ea.id, x.param_name, x.display_name, x.param_type, x.required, x.sort_order, x.category_entity_type, x.default_value, x.placeholder, x.file_type
FROM metadata.entity_actions ea,
(VALUES
  ('p_method_id',    'Consent Method',      'category', TRUE,  10, 'consent_method', NULL,                    NULL,                                     NULL),
  ('p_granted_date', 'Granted Date',        'date',     TRUE,  20, NULL,             CURRENT_DATE::TEXT,      NULL,                                     NULL),
  ('p_expires_date', 'Expires Date',        'date',     FALSE, 30, NULL,             NULL,                    'Defaults to one year from granted date', NULL),
  ('p_evidence',     'Evidence (optional)', 'file',     FALSE, 40, NULL,             NULL,                    NULL,                                     'any')
) AS x(param_name, display_name, param_type, required, sort_order, category_entity_type, default_value, placeholder, file_type)
WHERE ea.table_name = 'clients' AND ea.action_name = 'record_consent'
ON CONFLICT DO NOTHING;

-- Request Consent (fires notification; sits beside the gated button)
-- sort_order=35 avoids conflict with deactivate at 20 and record_consent at 25
INSERT INTO metadata.entity_actions (table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message, visibility_condition, refresh_after_action)
VALUES ('clients', 'request_consent', 'Request Consent',
    'Email the client a request to confirm consent for referrals.',
    'request_client_consent', 'mark_email_unread', 'secondary', 35, TRUE,
    'Send this client a consent request by email?',
    '{"field": "consent_active", "operator": "eq", "value": false}'::jsonb, TRUE)
ON CONFLICT DO NOTHING;

-- Entity action role grants for consent actions
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'clients'
  AND ea.action_name IN ('record_consent', 'request_consent')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- =====================================================
-- 9. SCHEDULED JOB: expiry + staff reminder ladder
-- =====================================================
-- Staff-only ladder at 30/14/7 days (decided 2026-07-15);
-- consent expiring has an operational consequence, so the
-- warning goes to the person who can act on it.

CREATE OR REPLACE FUNCTION public.run_consent_maintenance()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_expired  INT := 0;
  v_reminded INT := 0;
  r RECORD;
BEGIN
  -- 1. Expire overdue active consents; row trigger recomputes each gate.
  UPDATE client_consents cc
  SET status_id = get_status_id('client_consent', 'expired')
  FROM metadata.statuses s
  WHERE s.id = cc.status_id
    AND s.entity_type = 'client_consent' AND s.status_key = 'active'
    AND cc.expires_date < CURRENT_DATE;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- 2. Staff reminders at 30, 14, and 7 days out; idempotent via log.
  FOR r IN
    SELECT cc.id, cc.expires_date, cc.captured_by,
           (cc.expires_date - CURRENT_DATE) AS days_out,
           c.display_name AS client_name
    FROM client_consents cc
    JOIN metadata.statuses s ON s.id = cc.status_id
    JOIN clients c ON c.id = cc.client_id
    WHERE s.entity_type = 'client_consent' AND s.status_key = 'active'
      AND (cc.expires_date - CURRENT_DATE) IN (30, 14, 7)
      AND cc.captured_by IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM consent_reminder_log l
        WHERE l.consent_id = cc.id AND l.days_out = (cc.expires_date - CURRENT_DATE))
  LOOP
    INSERT INTO consent_reminder_log (consent_id, days_out)
    VALUES (r.id, r.days_out) ON CONFLICT DO NOTHING;

    PERFORM create_notification(
      p_user_id       := r.captured_by,
      p_template_name := 'consent_expiring_staff',
      p_entity_type   := 'client_consents',
      p_entity_id     := r.id::TEXT,
      p_entity_data   := jsonb_build_object(
        'client_name', r.client_name,
        'expires_date', to_char(r.expires_date, 'YYYY-MM-DD'),
        'days_remaining', r.days_out),
      p_channels      := ARRAY['email']::TEXT[]
    );
    v_reminded := v_reminded + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Expired %s consents; sent %s staff reminders', v_expired, v_reminded),
    'details', jsonb_build_object('expired', v_expired, 'reminders_sent', v_reminded)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

INSERT INTO metadata.scheduled_jobs (name, function_name, schedule, timezone, description)
VALUES ('consent_maintenance', 'run_consent_maintenance', '0 8 * * *', 'America/Detroit',
        'Expires overdue consents and sends staff reminders at 30, 14, and 7 days before expiry')
ON CONFLICT (name) DO UPDATE SET
  function_name = EXCLUDED.function_name,
  schedule = EXCLUDED.schedule,
  timezone = EXCLUDED.timezone,
  description = EXCLUDED.description;

-- =====================================================
-- 10. NOTIFICATION TEMPLATES
-- =====================================================

INSERT INTO metadata.notification_templates (name, subject_template, html_template, text_template) VALUES
('consent_expiring_staff',
 'Consent expiring for {{.Entity.client_name}} on {{.Entity.expires_date}}',
 '<p>Referral consent for <strong>{{.Entity.client_name}}</strong> expires on {{.Entity.expires_date}}; {{.Entity.days_remaining}} days remain.</p><p>Renew the consent to avoid interrupting referrals: <a href="{{.Metadata.site_url}}/view/client_consents/{{.Entity.id}}">open the consent record</a>.</p>',
 'Referral consent for {{.Entity.client_name}} expires on {{.Entity.expires_date}}; {{.Entity.days_remaining}} days remain. Renew it at {{.Metadata.site_url}}/view/client_consents/{{.Entity.id}}'),
('consent_request',
 '{{.Entity.org_name}}: please confirm your consent for referrals',
 '<p>Hello {{.Entity.client_name}},</p><p>{{.Entity.org_name}} needs your consent to share your information with partner organizations that can help with your service needs. Please log in to confirm: <a href="{{.Metadata.site_url}}">open the portal</a>.</p>',
 'Hello {{.Entity.client_name}}, {{.Entity.org_name}} needs your consent to share your information with partner organizations. Please log in to confirm: {{.Metadata.site_url}}')
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- 11. ENTITY METADATA
-- =====================================================

-- client_consents entity
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('client_consents', 'Client Consents',
        'Consent records with expiration; the referral gate reads these.', 6, TRUE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

-- client_current_consents VIEW entity (read-only, no sidebar)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('client_current_consents', 'Current Consents',
        'Governing consent per client (most recent non-superseded).', 36, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

-- consents_expiring_soon VIEW entity (read-only, no sidebar — dashboard source)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_in_sidebar)
VALUES ('consents_expiring_soon', 'Consents Expiring Soon',
        'Active consents expiring within 30 days (dashboard source).', 37, FALSE)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_in_sidebar = EXCLUDED.show_in_sidebar;

-- Properties: label and order the consent record fields
-- Hide revoked_date, captured_by, evidence_file from list (rarely populated)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, status_entity_type, category_entity_type) VALUES
  ('client_consents', 'client_id',     'Client',      10, TRUE,  NULL,              NULL),
  ('client_consents', 'status_id',     'Status',      20, TRUE,  'client_consent',  NULL),
  ('client_consents', 'method_id',     'Method',      30, TRUE,  NULL,              'consent_method'),
  ('client_consents', 'granted_date',  'Granted',     40, TRUE,  NULL,              NULL),
  ('client_consents', 'expires_date',  'Expires',     50, TRUE,  NULL,              NULL),
  ('client_consents', 'revoked_date',  'Revoked',     60, FALSE, NULL,              NULL),
  ('client_consents', 'captured_by',   'Captured By', 70, FALSE, NULL,              NULL),
  ('client_consents', 'evidence_file', 'Evidence',    80, FALSE, NULL,              NULL)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  status_entity_type = EXCLUDED.status_entity_type,
  category_entity_type = EXCLUDED.category_entity_type;

-- On clients: consent gate columns are read-only display
-- consent_state_id = Category badge, consent_active = hidden (action gating only)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_create, show_on_edit, show_on_list, show_on_detail, category_entity_type) VALUES
  ('clients', 'consent_state_id', 'Consent State',  55, FALSE, FALSE, TRUE,  TRUE,  'consent_state'),
  ('clients', 'consent_active',   'Consent Active', 56, FALSE, FALSE, FALSE, FALSE, NULL),
  ('clients', 'consent_note',     'Consent Status', 57, FALSE, FALSE, FALSE, TRUE,  NULL)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_list = EXCLUDED.show_on_list,
  show_on_detail = EXCLUDED.show_on_detail,
  category_entity_type = EXCLUDED.category_entity_type;

-- Enable entity notes on consent records
SELECT enable_entity_notes('client_consents');

-- =====================================================
-- 12. PERMISSIONS AND RLS
-- =====================================================

GRANT SELECT, INSERT, UPDATE ON public.client_consents TO authenticated;
GRANT USAGE ON SEQUENCE public.client_consents_id_seq TO authenticated;

ALTER TABLE public.client_consents ENABLE ROW LEVEL SECURITY;

-- Staff: full read/create/update via permission system
-- Clients: read own consents via ownership chain
CREATE POLICY client_consents_read ON public.client_consents FOR SELECT TO authenticated
  USING (
    has_permission('client_consents', 'read')
    OR EXISTS (SELECT 1 FROM public.clients c
               WHERE c.id = client_consents.client_id AND c.user_id = current_user_id())
  );
CREATE POLICY client_consents_create ON public.client_consents FOR INSERT TO authenticated
  WITH CHECK (has_permission('client_consents', 'create'));
CREATE POLICY client_consents_update ON public.client_consents FOR UPDATE TO authenticated
  USING (has_permission('client_consents', 'update'));
-- No delete policy; consent history is never deleted.

-- Permission entries for client_consents
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('client_consents', 'read'),
  ('client_consents', 'create'),
  ('client_consents', 'update')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Grant client_consents permissions to staff and admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'client_consents'
  AND p.permission IN ('read', 'create', 'update')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- Entity notes permissions: remove default user/editor grants,
-- keep only staff and admin
DELETE FROM metadata.permission_roles
WHERE permission_id IN (
  SELECT p.id FROM metadata.permissions p
  WHERE p.table_name = 'client_consents:notes'
)
AND role_id IN (
  SELECT r.id FROM metadata.roles r
  WHERE r.role_key IN ('user', 'editor')
);

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'client_consents:notes'
  AND p.permission IN ('read', 'create')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;

-- consent_reminder_log stays internal: no grants beyond definer functions.
-- Hide from sidebar (auto-discovered by schema_entities VIEW otherwise).
INSERT INTO metadata.entities (table_name, display_name, show_in_sidebar)
VALUES ('consent_reminder_log', 'Consent Reminder Log', FALSE)
ON CONFLICT (table_name) DO UPDATE SET show_in_sidebar = FALSE;

-- =====================================================
-- 13. SCHEMA DECISIONS
-- =====================================================

INSERT INTO metadata.schema_decisions (entity_types, title, context, decision, rationale, consequences) VALUES
(ARRAY['client_consents'],
 'Consent is a record with history, not a document',
 'The referral gate needs a queryable, self-expiring source of truth; uploads depend on someone remembering to upload.',
 'client_consents keeps full history; statuses Pending, Active, Expired, Revoked, Superseded; a current-consent view picks the governing record; evidence files are optional proof.',
 'Revoked (client decision), Expired (clock), and Superseded (replacement) are different truths and stay distinguishable; the audit trail is intact.',
 'At most one Active consent is enforced by process (record_client_consent supersedes), not by constraint.'),
(ARRAY['clients', 'client_consents'],
 'Denormalized consent gate state on clients',
 'entity_actions conditions evaluate only the record''s own fields, and disabled_tooltip is static text.',
 'clients.consent_state_id (Category FK), consent_active (BOOLEAN), and consent_note are trigger-maintained from client_consents; Refer Client is enabled only when consent_active = true; the Category badge shows the state with color; the dated reason displays as a read-only property.',
 'Keeps the gate metadata-driven with zero frontend code; the visible reason satisfies the requirement that a disabled button states why.',
 'Duplication managed by trigger + daily job; a future cross-entity condition or templated-tooltip feature would remove it.'),
(ARRAY['client_consents'],
 'Staff-only reminder ladder at 30/14/7 days',
 'Consent expiring has an operational consequence for staff; clients cannot be assumed to have email.',
 'run_consent_maintenance() notifies captured_by at 30, 14, and 7 days before expiry; idempotent via consent_reminder_log.',
 'The warning goes to the person who can schedule a renewal; no client-email dependency.',
 'If the capturing staff member leaves, reminders for their consents stop; reassignment is a manual step.')
ON CONFLICT DO NOTHING;

-- =====================================================
-- FINISH
-- =====================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
