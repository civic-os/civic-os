-- 30_revoke_public_execute.sql
-- Client Intake example: revoke PUBLIC EXECUTE and guard staff RPCs.
--
-- Findings addressed:
--   - Client and referral action RPCs (activate/deactivate/reactivate/refer_client, complete_referral,
--     mark_referral_not_completed) and their *_by_user profile wrappers were SECURITY DEFINER with no
--     authorization check. Anyone could change any client record and trigger referral emails that
--     contain client PII. The staff/admin restriction only existed in the UI.
--   - revoke_client_consent had no guard and can block a client's referrals.
--   - send_newsletter had no guard (mass email). It is split into a guarded public RPC and an
--     internal _send_newsletter() used by the scheduled check_scheduled_newsletters() job, which
--     runs without a user session and therefore must not go through the permission check.
--   - send_referral_notification, run_survey_reminders and check_scheduled_newsletters were granted to
--     authenticated, letting any logged-in user trigger emails on demand. The worker runs them as
--     postgres and needs no grant.
--
-- Companion to core migration v0-76-5-revoke-public-execute. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so a bare GRANT ... TO authenticated never removed anonymous
-- (web_anon) access. This script revokes PUBLIC from this example's non-anonymous functions,
-- and adds in-body authorization checks to SECURITY DEFINER RPCs that had none.
--
-- Safe to re-run: REVOKE/GRANT are idempotent and CREATE OR REPLACE keeps existing ACLs.

BEGIN;

-- ===========================================================================
-- 1. Authorization guards (CREATE OR REPLACE keeps the existing ACL)
-- Client actions are registered for the staff and admin roles (clients:update / referrals:*).
-- ===========================================================================

CREATE OR REPLACE FUNCTION activate_client(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  -- Authorization guard: clients:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to activate clients';
  END IF;
  IF NOT has_permission('clients', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires clients:update permission';
  END IF;

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

CREATE OR REPLACE FUNCTION deactivate_client(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  -- Authorization guard: clients:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to deactivate clients';
  END IF;
  IF NOT has_permission('clients', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires clients:update permission';
  END IF;

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

CREATE OR REPLACE FUNCTION reactivate_client(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_key TEXT;
BEGIN
  -- Authorization guard: clients:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to reactivate clients';
  END IF;
  IF NOT has_permission('clients', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires clients:update permission';
  END IF;

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
  -- Authorization guard: referrals:create
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to refer clients';
  END IF;
  IF NOT has_permission('referrals', 'create') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires referrals:create permission';
  END IF;

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
  -- Authorization guard: referrals:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to complete referrals';
  END IF;
  IF NOT has_permission('referrals', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires referrals:update permission';
  END IF;

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
  -- Authorization guard: referrals:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to update referrals';
  END IF;
  IF NOT has_permission('referrals', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires referrals:update permission';
  END IF;

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

-- Profile-page wrappers (delegate to the guarded RPCs above; checked up front as well)

CREATE OR REPLACE FUNCTION activate_client_by_user(p_entity_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  -- Authorization guard: clients:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to activate clients';
  END IF;
  IF NOT has_permission('clients', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires clients:update permission';
  END IF;

  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM activate_client(v_client_id);
END;
$$;

CREATE OR REPLACE FUNCTION deactivate_client_by_user(p_entity_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  -- Authorization guard: clients:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to deactivate clients';
  END IF;
  IF NOT has_permission('clients', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires clients:update permission';
  END IF;

  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM deactivate_client(v_client_id);
END;
$$;

CREATE OR REPLACE FUNCTION reactivate_client_by_user(p_entity_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  -- Authorization guard: clients:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to reactivate clients';
  END IF;
  IF NOT has_permission('clients', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires clients:update permission';
  END IF;

  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM reactivate_client(v_client_id);
END;
$$;

CREATE OR REPLACE FUNCTION refer_client_by_user(
  p_entity_id UUID,
  p_partner_id BIGINT,
  p_referral_type_id INT,
  p_referral_date DATE DEFAULT CURRENT_DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id BIGINT;
BEGIN
  -- Authorization guard: referrals:create
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to refer clients';
  END IF;
  IF NOT has_permission('referrals', 'create') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires referrals:create permission';
  END IF;

  SELECT id INTO v_client_id FROM clients WHERE user_id = p_entity_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'No client record found for this user';
  END IF;
  PERFORM refer_client(v_client_id, p_partner_id, p_referral_type_id, p_referral_date);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_client_consent(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata, public
AS $$
BEGIN
  -- Authorization guard: client_consents:update
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING HINT = 'Must be logged in to revoke consent';
  END IF;
  IF NOT has_permission('client_consents', 'update') THEN
    RAISE EXCEPTION 'Permission denied'
      USING HINT = 'Requires client_consents:update permission';
  END IF;

  UPDATE client_consents SET revoked_date = CURRENT_DATE WHERE id = p_entity_id;
  RETURN jsonb_build_object('success', true, 'message', 'Consent revoked');
END;
$$;

-- send_newsletter(): the sending logic moves to the internal _send_newsletter(); the public RPC
-- keeps its name (entity action "Send Now") and only adds the permission check.

CREATE OR REPLACE FUNCTION _send_newsletter(p_entity_id BIGINT)
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

CREATE OR REPLACE FUNCTION send_newsletter(p_entity_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Authorization guard: newsletters:update (staff, admin)
    IF current_user_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING HINT = 'Must be logged in to send newsletters';
    END IF;
    IF NOT has_permission('newsletters', 'update') THEN
        RAISE EXCEPTION 'Permission denied'
            USING HINT = 'Requires newsletters:update permission';
    END IF;

    PERFORM _send_newsletter(p_entity_id);
END;
$$;

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
        PERFORM _send_newsletter(v_newsletter.id);
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

-- ===========================================================================
-- 2. REVOKE EXECUTE FROM PUBLIC - authenticated-only functions
-- (explicit GRANT ... TO authenticated from the earlier scripts stays in place)
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.get_partners_for_client_needs(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_referral_service_options(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.activate_client(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deactivate_client(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reactivate_client(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refer_client(bigint, bigint, integer, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_referral(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_referral_not_completed(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.activate_client_by_user(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deactivate_client_by_user(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reactivate_client_by_user(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refer_client_by_user(uuid, bigint, integer, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_client_consent(bigint, integer, date, date, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_client_consent(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_client_consent(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.send_newsletter(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.schedule_newsletter(bigint, timestamp with time zone) FROM PUBLIC;

-- ===========================================================================
-- 3. Internal functions - scheduled jobs (worker runs as postgres) and helpers called only by
-- SECURITY DEFINER functions or triggers; no API role needs them
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public._send_newsletter(bigint) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_referral_notification(bigint) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_survey_reminders() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_scheduled_newsletters() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_client_consent_gate(bigint) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.run_consent_maintenance() FROM PUBLIC, authenticated;

-- ===========================================================================
-- 4. Internal trigger functions
-- Trigger functions: EXECUTE is only checked when a trigger is created, never when it fires,
-- so revoking PUBLIC here does not affect the triggers.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.auto_set_client_user_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_survey_for_referral() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_complete_survey() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trigger_referral_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.client_consents_gate_sync() FROM PUBLIC;

COMMIT;
