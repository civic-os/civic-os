-- ============================================================================
-- Client Intake & Referral - Post-Launch Fixes
-- ============================================================================
-- Incremental fixes applied after initial production deployment.
-- Each section is dated and described for traceability.
-- ============================================================================

BEGIN;

-- =====================================================
-- 2026-06-05: Rename display labels to ECS branding
-- =====================================================

UPDATE metadata.roles
SET display_name = 'Staff'
WHERE role_key = 'staff' AND display_name = 'Staff';

UPDATE metadata.dashboards
SET display_name = 'ECS Intake Dashboard'
WHERE display_name = 'ECS Intake Dashboard';


-- =====================================================
-- 2026-06-05: System notes on Client at key junctures
-- =====================================================
-- Adds create_entity_note() calls to every client status
-- change, referral event, and survey lifecycle event so
-- the Client detail page has a complete audit trail.

-- 1. activate_client — note on Intake Pending → Active
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

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := p_entity_id::TEXT,
    p_content     := 'Client activated (Intake Pending → Active)',
    p_note_type   := 'system'
  );
END;
$$;

-- 2. deactivate_client — note on Active → Inactive
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

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := p_entity_id::TEXT,
    p_content     := 'Client deactivated (Active → Inactive)',
    p_note_type   := 'system'
  );
END;
$$;

-- 3. reactivate_client — note on Inactive → Active
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

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := p_entity_id::TEXT,
    p_content     := 'Client reactivated (Inactive → Active)',
    p_note_type   := 'system'
  );
END;
$$;

-- 4. refer_client — note with partner name, type, and services
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
  v_partner_name TEXT;
  v_referral_type TEXT;
  v_service_cats TEXT;
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

  -- Lookup names for the note
  SELECT display_name INTO v_partner_name FROM partners WHERE id = p_partner_id;
  SELECT display_name INTO v_referral_type FROM metadata.categories WHERE id = p_referral_type_id;
  SELECT string_agg(sc.display_name, ', ' ORDER BY sc.sort_order)
  INTO v_service_cats
  FROM referral_service_categories rsc
  JOIN service_categories sc ON rsc.service_category_id = sc.id
  WHERE rsc.referral_id = v_referral_id;

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := p_entity_id::TEXT,
    p_content     := format(
      '%s referral created to **%s** for: %s',
      COALESCE(v_referral_type, 'Referral'),
      COALESCE(v_partner_name, 'Unknown'),
      COALESCE(v_service_cats, 'Not specified')
    ),
    p_note_type   := 'system'
  );

  -- Send notification email (property_change_triggers don't fire inside RPCs)
  PERFORM send_referral_notification(v_referral_id);
END;
$$;

-- 5. complete_referral — note on Client when referral completed
CREATE OR REPLACE FUNCTION complete_referral(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
  v_client_id BIGINT;
  v_partner_name TEXT;
BEGIN
  SELECT s.status_key, r.client_id, p.display_name
  INTO v_current_key, v_client_id, v_partner_name
  FROM referrals r
  JOIN metadata.statuses s ON r.status_id = s.id
  JOIN partners p ON r.partner_id = p.id
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

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := v_client_id::TEXT,
    p_content     := format('Referral to **%s** marked as completed', COALESCE(v_partner_name, 'Unknown')),
    p_note_type   := 'system'
  );
END;
$$;

-- 6. mark_referral_not_completed — note on Client with outcome notes
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
  v_client_id BIGINT;
  v_partner_name TEXT;
  v_note_content TEXT;
BEGIN
  SELECT s.status_key, r.client_id, p.display_name
  INTO v_current_key, v_client_id, v_partner_name
  FROM referrals r
  JOIN metadata.statuses s ON r.status_id = s.id
  JOIN partners p ON r.partner_id = p.id
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

  v_note_content := format('Referral to **%s** marked as not completed', COALESCE(v_partner_name, 'Unknown'));
  IF p_outcome_notes IS NOT NULL AND TRIM(p_outcome_notes) != '' THEN
    v_note_content := v_note_content || E'\n\nOutcome notes: ' || p_outcome_notes;
  END IF;

  PERFORM create_entity_note(
    p_entity_type := 'clients',
    p_entity_id   := v_client_id::TEXT,
    p_content     := v_note_content,
    p_note_type   := 'system'
  );
END;
$$;

-- 7. auto_complete_survey — note on Client when survey completed
CREATE OR REPLACE FUNCTION auto_complete_survey()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_client_id BIGINT;
  v_partner_name TEXT;
BEGIN
  -- Only act on pending surveys where all three responses are now filled
  IF NEW.helpfulness_id IS NOT NULL
     AND NEW.time_to_contact_id IS NOT NULL
     AND NEW.outcome_id IS NOT NULL
     AND OLD.status_id = get_status_id('survey', 'pending')
  THEN
    NEW.status_id := get_status_id('survey', 'completed');
    NEW.completed_date := CURRENT_DATE;

    -- Look up client and partner through the referral chain
    SELECT r.client_id, p.display_name
    INTO v_client_id, v_partner_name
    FROM referrals r
    JOIN partners p ON r.partner_id = p.id
    WHERE r.id = NEW.referral_id;

    PERFORM create_entity_note(
      p_entity_type := 'clients',
      p_entity_id   := v_client_id::TEXT,
      p_content     := format('Follow-up survey completed for referral to **%s**', COALESCE(v_partner_name, 'Unknown')),
      p_note_type   := 'system'
    );
  END IF;

  RETURN NEW;
END;
$$;

-- 8. run_survey_reminders — note on Client when survey expires
--    Replaces bulk UPDATE with per-row loop so each client gets a note.
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
      c.id AS client_id,
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

  -- Expire surveys older than 7 days — loop so each client gets a note
  FOR v_survey IN
    SELECT s.id AS survey_id, r.client_id, p.display_name AS partner_name
    FROM follow_up_surveys s
    JOIN referrals r ON s.referral_id = r.id
    JOIN partners p ON r.partner_id = p.id
    WHERE s.status_id = v_pending_status_id
      AND (CURRENT_DATE - r.referral_date) > 7
  LOOP
    UPDATE follow_up_surveys
    SET status_id = v_expired_status_id,
        updated_at = NOW()
    WHERE id = v_survey.survey_id;

    PERFORM create_entity_note(
      p_entity_type := 'clients',
      p_entity_id   := v_survey.client_id::TEXT,
      p_content     := format('Follow-up survey expired (no response after 7 days) for referral to **%s**', COALESCE(v_survey.partner_name, 'Unknown')),
      p_note_type   := 'system',
      p_author_id   := NULL
    );

    v_surveys_expired := v_surveys_expired + 1;
  END LOOP;

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


-- =====================================================
-- 2026-06-05: Survey display_name with partner + date
-- =====================================================
-- Replace static "Survey #123" generated column with a
-- trigger-set name like "GISD Adult Ed, 2026-06-01" so
-- list/detail pages show meaningful context at a glance.

-- Drop the GENERATED expression so the column becomes a regular TEXT
ALTER TABLE follow_up_surveys ALTER COLUMN display_name DROP EXPRESSION;

-- Set display_name during survey creation (fires AFTER INSERT on referrals)
CREATE OR REPLACE FUNCTION create_survey_for_referral()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_name TEXT;
  v_partner_name TEXT;
  v_display TEXT;
BEGIN
  SELECT c.first_name || ' ' || c.last_name
  INTO v_client_name
  FROM clients c
  WHERE c.id = NEW.client_id;

  SELECT p.display_name
  INTO v_partner_name
  FROM partners p
  WHERE p.id = NEW.partner_id;

  v_display := COALESCE(v_client_name, 'Unknown') || ' → ' || COALESCE(v_partner_name, 'Unknown') || ', ' || to_char(NEW.referral_date, 'YYYY-MM-DD');

  INSERT INTO follow_up_surveys (referral_id, display_name)
  VALUES (NEW.id, v_display);

  RETURN NEW;
END;
$$;

-- Backfill any existing surveys that still have "Survey #N" display names
UPDATE follow_up_surveys s
SET display_name = c.first_name || ' ' || c.last_name || ' → ' || p.display_name || ', ' || to_char(r.referral_date, 'YYYY-MM-DD')
FROM referrals r
JOIN clients c ON r.client_id = c.id
JOIN partners p ON r.partner_id = p.id
WHERE s.referral_id = r.id
  AND s.display_name LIKE 'Survey #%';


-- =====================================================
-- 2026-06-05: Ensure Activate Client action role grants
-- =====================================================
-- Idempotent: re-assert that client actions are granted
-- only to staff and admin. The framework defaults to
-- admin-only when no grants exist, but explicit grants
-- make the intent visible in the Permissions UI.

INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'clients'
  AND ea.action_name IN ('activate', 'refer', 'deactivate', 'reactivate')
  AND r.role_key IN ('staff', 'admin')
ON CONFLICT DO NOTHING;


-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
