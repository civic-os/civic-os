-- ============================================================================
-- SEED DEMO DATA: Exemplary Community Services (ECS)
-- ============================================================================
-- Generates realistic relationship data ON TOP of existing clients/partners
-- created by `npm run generate` or already in a live database.
--
-- Idempotent: TRUNCATEs junction/consent/referral data; preserves base
-- client and partner records.
--
-- Usage:
--   psql $DB_URL -f seed-demo-data.sql
--   -- or via wrapper:
--   ./seed-demo-data.sh [optional-db-url]
-- ============================================================================

SET search_path = public, metadata;

DO $$
DECLARE
  -- ── Status IDs ──
  v_consent_pending_id    INT;
  v_consent_active_id     INT;
  v_consent_expired_id    INT;
  v_consent_revoked_id    INT;
  v_consent_superseded_id INT;
  v_referral_referred_id  INT;
  v_referral_completed_id INT;
  v_referral_not_completed_id INT;
  v_survey_pending_id     INT;
  v_survey_completed_id   INT;
  v_survey_expired_id     INT;

  -- ── Category IDs ──
  v_method_verbal_id   INT;
  v_method_written_id  INT;
  v_method_portal_id   INT;
  v_warm_id            INT;
  v_info_id            INT;

  -- ── Survey category ID arrays ──
  v_helpfulness_ids    INT[];
  v_ttc_ids            INT[];
  v_outcome_ids        INT[];
  v_not_helpful_id     INT;
  v_no_action_id       INT;

  -- ── Service category IDs ──
  v_all_svc_ids        BIGINT[];
  v_common_svc_ids     BIGINT[];  -- Employment, Housing, Healthcare, Education

  -- ── Counts ──
  v_client_count       INT;
  v_partner_count      INT;

  -- ── Loop variables ──
  v_client_id          BIGINT;
  v_partner_id         BIGINT;
  v_referral_id        BIGINT;
  v_svc_id             BIGINT;
  v_n                  INT;
  v_i                  INT;
  v_granted            DATE;
  v_method_id          INT;
  v_method_ids         INT[];
  v_rand               FLOAT;
  v_days_ago           INT;
  v_referral_date      DATE;
  v_client_needs       BIGINT[];
  v_partner_svcs       BIGINT[];
  v_overlap            BIGINT[];
  v_referral_count     INT := 0;
  v_attempt            INT;
  v_completed_date     DATE;

  -- ── Temp arrays ──
  v_client_ids         BIGINT[];
  v_partner_ids        BIGINT[];

  -- ── Superseded tracking ──
  v_superseded_count   INT := 0;

BEGIN
  -- ================================================================
  -- 0. LOOK UP IDS (never hardcode numeric IDs)
  -- ================================================================

  -- Consent statuses
  SELECT id INTO v_consent_pending_id    FROM metadata.statuses WHERE entity_type = 'client_consent' AND status_key = 'pending';
  SELECT id INTO v_consent_active_id     FROM metadata.statuses WHERE entity_type = 'client_consent' AND status_key = 'active';
  SELECT id INTO v_consent_expired_id    FROM metadata.statuses WHERE entity_type = 'client_consent' AND status_key = 'expired';
  SELECT id INTO v_consent_revoked_id    FROM metadata.statuses WHERE entity_type = 'client_consent' AND status_key = 'revoked';
  SELECT id INTO v_consent_superseded_id FROM metadata.statuses WHERE entity_type = 'client_consent' AND status_key = 'superseded';

  -- Referral statuses
  SELECT id INTO v_referral_referred_id      FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'referred';
  SELECT id INTO v_referral_completed_id     FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'completed';
  SELECT id INTO v_referral_not_completed_id FROM metadata.statuses WHERE entity_type = 'referral' AND status_key = 'not_completed';

  -- Survey statuses
  SELECT id INTO v_survey_pending_id   FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'pending';
  SELECT id INTO v_survey_completed_id FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'completed';
  SELECT id INTO v_survey_expired_id   FROM metadata.statuses WHERE entity_type = 'survey' AND status_key = 'expired';

  -- Consent method categories
  SELECT id INTO v_method_verbal_id  FROM metadata.categories WHERE entity_type = 'consent_method' AND category_key = 'verbal';
  SELECT id INTO v_method_written_id FROM metadata.categories WHERE entity_type = 'consent_method' AND category_key = 'written';
  SELECT id INTO v_method_portal_id  FROM metadata.categories WHERE entity_type = 'consent_method' AND category_key = 'portal';
  v_method_ids := ARRAY[v_method_verbal_id, v_method_written_id, v_method_portal_id];

  -- Referral type categories
  SELECT id INTO v_warm_id FROM metadata.categories WHERE entity_type = 'referral_type' AND category_key = 'warm';
  SELECT id INTO v_info_id FROM metadata.categories WHERE entity_type = 'referral_type' AND category_key = 'info';

  -- Survey response categories (arrays for random selection)
  SELECT array_agg(id ORDER BY sort_order) INTO v_helpfulness_ids
  FROM metadata.categories WHERE entity_type = 'helpfulness';

  SELECT array_agg(id ORDER BY sort_order) INTO v_ttc_ids
  FROM metadata.categories WHERE entity_type = 'time_to_contact';

  SELECT array_agg(id ORDER BY sort_order) INTO v_outcome_ids
  FROM metadata.categories WHERE entity_type = 'outcome';

  SELECT id INTO v_not_helpful_id FROM metadata.categories WHERE entity_type = 'helpfulness' AND category_key = 'not_helpful';
  SELECT id INTO v_no_action_id  FROM metadata.categories WHERE entity_type = 'outcome'      AND category_key = 'no_action';

  -- Service categories
  SELECT array_agg(id ORDER BY id) INTO v_all_svc_ids FROM service_categories;

  -- Common service categories (weighted toward these)
  SELECT array_agg(id) INTO v_common_svc_ids
  FROM service_categories
  WHERE display_name IN ('Employment / Job Placement', 'Housing Assistance',
                         'Healthcare / Medical', 'Education (non-ESL)');

  -- Validate we found everything
  IF v_consent_active_id IS NULL THEN
    RAISE EXCEPTION 'Missing client_consent statuses. Was 26_consent_subsystem.sql run?';
  END IF;
  IF v_referral_referred_id IS NULL THEN
    RAISE EXCEPTION 'Missing referral statuses. Was 01_client_intake_schema.sql run?';
  END IF;
  IF array_length(v_all_svc_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No service categories found. Was 01_client_intake_schema.sql run?';
  END IF;

  -- ================================================================
  -- 1. TRUNCATE RELATIONSHIP DATA (preserve base records)
  -- ================================================================

  RAISE NOTICE '── Cleaning relationship data...';

  -- Referral cascade deletes surveys and referral_service_categories
  TRUNCATE referral_service_categories, follow_up_surveys, referrals CASCADE;
  TRUNCATE client_consents CASCADE;
  TRUNCATE consent_reminder_log CASCADE;
  TRUNCATE client_service_needs CASCADE;
  TRUNCATE partner_service_categories CASCADE;

  -- Reset consent gate on all clients
  UPDATE clients SET
    consent_state_id = (SELECT id FROM metadata.categories WHERE entity_type = 'consent_state' AND category_key = 'none'),
    consent_active = FALSE,
    consent_note = 'No consent on record';

  -- Collect base record IDs
  SELECT array_agg(id ORDER BY id) INTO v_client_ids FROM clients;
  SELECT array_agg(id ORDER BY id) INTO v_partner_ids FROM partners;
  v_client_count  := array_length(v_client_ids, 1);
  v_partner_count := array_length(v_partner_ids, 1);

  IF v_client_count IS NULL OR v_client_count = 0 THEN
    RAISE EXCEPTION 'No clients found. Run `npm run generate client-intake` first.';
  END IF;
  IF v_partner_count IS NULL OR v_partner_count = 0 THEN
    RAISE EXCEPTION 'No partners found. Run `npm run generate client-intake` first.';
  END IF;

  RAISE NOTICE '  Found % clients, % partners', v_client_count, v_partner_count;

  -- ================================================================
  -- A. PARTNER SERVICE CATEGORIES
  --    Each partner gets 2-5 random service categories.
  --    Every service category must have at least 2 partners.
  -- ================================================================

  RAISE NOTICE '── Assigning partner service categories...';

  FOR v_i IN 1..v_partner_count LOOP
    v_partner_id := v_partner_ids[v_i];
    v_n := 2 + floor(random() * 4)::INT;  -- 2..5

    INSERT INTO partner_service_categories (partner_id, service_category_id)
    SELECT v_partner_id, sc_id
    FROM (
      SELECT unnest(v_all_svc_ids) AS sc_id
      ORDER BY random()
      LIMIT v_n
    ) sub
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Ensure every service category has at least 2 partners
  FOR v_svc_id IN SELECT unnest(v_all_svc_ids) LOOP
    WHILE (SELECT count(*) FROM partner_service_categories WHERE service_category_id = v_svc_id) < 2 LOOP
      v_partner_id := v_partner_ids[1 + floor(random() * v_partner_count)::INT];
      INSERT INTO partner_service_categories (partner_id, service_category_id)
      VALUES (v_partner_id, v_svc_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  RAISE NOTICE '  Partner service categories assigned.';

  -- ================================================================
  -- B. CLIENT SERVICE NEEDS
  --    Each client gets 1-3 service areas, weighted toward common ones.
  -- ================================================================

  RAISE NOTICE '── Assigning client service needs...';

  FOR v_i IN 1..v_client_count LOOP
    v_client_id := v_client_ids[v_i];
    v_n := 1 + floor(random() * 3)::INT;  -- 1..3

    INSERT INTO client_service_needs (client_id, service_category_id)
    SELECT v_client_id, sc_id
    FROM (
      -- 70% chance each pick comes from common categories
      SELECT CASE
        WHEN random() < 0.7 AND v_common_svc_ids IS NOT NULL
        THEN v_common_svc_ids[1 + floor(random() * array_length(v_common_svc_ids, 1))::INT]
        ELSE v_all_svc_ids[1 + floor(random() * array_length(v_all_svc_ids, 1))::INT]
      END AS sc_id
      FROM generate_series(1, v_n + 2)  -- generate extras to handle dedup
    ) sub
    GROUP BY sc_id  -- dedup
    LIMIT v_n
    ON CONFLICT DO NOTHING;
  END LOOP;

  RAISE NOTICE '  Client service needs assigned.';

  -- ================================================================
  -- C. CONSENTS
  --    Every client gets at least one consent record.
  --    Distribution: ~80% Active, 8-10 expiring within 30 days,
  --    ≥3 Expired, ≥1 Revoked, ~5 Pending, ~5 Superseded.
  -- ================================================================

  RAISE NOTICE '── Generating consent records...';

  FOR v_i IN 1..v_client_count LOOP
    v_client_id := v_client_ids[v_i];
    v_rand := random();
    v_method_id := v_method_ids[1 + floor(random() * 3)::INT];

    IF v_i <= 5 THEN
      -- ── Pending: no granted_date, no expires_date ──
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date)
      VALUES (v_client_id, v_consent_pending_id, NULL, NULL, NULL);

    ELSIF v_i <= 10 AND v_superseded_count < 5 THEN
      -- ── Superseded pair: old superseded + new active ──
      -- Old consent: granted ~18 months ago, superseded
      v_granted := CURRENT_DATE - (500 + floor(random() * 60)::INT);
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date)
      VALUES (v_client_id, v_consent_superseded_id, v_method_id, v_granted, v_granted + 365);

      -- New consent: granted recently, active
      v_granted := CURRENT_DATE - floor(random() * 120)::INT;
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date)
      VALUES (v_client_id, v_consent_active_id, v_method_id, v_granted, v_granted + 365);

      v_superseded_count := v_superseded_count + 1;

    ELSIF v_i <= 13 THEN
      -- ── Expired: granted > 1 year ago ──
      v_granted := CURRENT_DATE - (370 + floor(random() * 60)::INT);
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date)
      VALUES (v_client_id, v_consent_expired_id, v_method_id, v_granted, v_granted + 365);

    ELSIF v_i = 14 THEN
      -- ── Revoked: was active, then revoked ──
      v_granted := CURRENT_DATE - (60 + floor(random() * 90)::INT);
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date, revoked_date)
      VALUES (v_client_id, v_consent_revoked_id, v_method_id, v_granted, v_granted + 365,
              v_granted + (10 + floor(random() * 30)::INT));

    ELSIF v_i <= 24 THEN
      -- ── Expiring soon (within 30 days): 10 records ──
      -- Several inside 7 days for demo urgency
      IF v_i <= 18 THEN
        -- Expiring within 7 days
        v_granted := CURRENT_DATE - (360 + floor(random() * 5)::INT);
      ELSE
        -- Expiring within 8-30 days
        v_granted := CURRENT_DATE - (338 + floor(random() * 22)::INT);
      END IF;
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date)
      VALUES (v_client_id, v_consent_active_id, v_method_id, v_granted, v_granted + 365);

    ELSE
      -- ── Active (bulk): granted within past ~380 days, expires in future ──
      v_granted := CURRENT_DATE - floor(random() * 300)::INT;
      INSERT INTO client_consents (client_id, status_id, method_id, granted_date, expires_date)
      VALUES (v_client_id, v_consent_active_id, v_method_id, v_granted, v_granted + 365);
    END IF;
  END LOOP;

  -- Recompute consent gate for every client
  RAISE NOTICE '  Recomputing consent gates...';
  FOR v_i IN 1..v_client_count LOOP
    PERFORM recompute_client_consent_gate(v_client_ids[v_i]);
  END LOOP;

  RAISE NOTICE '  Consent records created and gates recomputed.';

  -- ================================================================
  -- D. REFERRALS (~400, spread across ~90 days ending today)
  --    Each referral matches client service needs to partner offerings.
  --    Status: ~60% Completed, ~15% Not Completed, ~25% Referred.
  --    Auto-populate referral_service_categories junction.
  -- ================================================================

  RAISE NOTICE '── Generating referrals...';

  -- Disable the notification trigger during bulk insert (no emails for seed data)
  ALTER TABLE referrals DISABLE TRIGGER ALL;

  v_referral_count := 0;

  WHILE v_referral_count < 400 LOOP
    v_attempt := 0;

    -- Pick a random client with active consent and service needs
    LOOP
      v_attempt := v_attempt + 1;
      IF v_attempt > 50 THEN
        -- Safety valve: break and accept fewer referrals
        EXIT;
      END IF;

      v_client_id := v_client_ids[1 + floor(random() * v_client_count)::INT];

      -- Skip clients without active consent (indices 1-5 Pending, 11-13 Expired, 14 Revoked)
      -- These clients should have zero referrals for demo realism
      IF v_client_id = ANY(v_client_ids[1:5] || v_client_ids[11:14]) THEN
        CONTINUE;
      END IF;

      -- Get client's service needs
      SELECT array_agg(service_category_id) INTO v_client_needs
      FROM client_service_needs
      WHERE client_id = v_client_id;

      IF v_client_needs IS NULL THEN
        CONTINUE;
      END IF;

      -- Find a partner offering at least one matching service
      SELECT p.partner_id INTO v_partner_id
      FROM (
        SELECT psc.partner_id
        FROM partner_service_categories psc
        WHERE psc.service_category_id = ANY(v_client_needs)
        GROUP BY psc.partner_id
        ORDER BY random()
        LIMIT 1
      ) p;

      IF v_partner_id IS NOT NULL THEN
        EXIT;  -- Found a valid match
      END IF;
    END LOOP;

    IF v_attempt > 50 THEN
      EXIT;  -- Could not find enough valid matches
    END IF;

    -- Referral date: distributed across 90 days ending today
    -- Weekday clustering: regenerate until weekday (Mon-Fri)
    LOOP
      v_days_ago := floor(random() * 90)::INT;
      v_referral_date := CURRENT_DATE - v_days_ago;
      EXIT WHEN EXTRACT(DOW FROM v_referral_date) BETWEEN 1 AND 5;
    END LOOP;

    -- Determine status based on age and distribution
    v_rand := random();

    IF v_days_ago > 14 AND v_rand < 0.71 THEN
      -- Completed (~71% of >14-day referrals → ~60% overall)
      v_completed_date := v_referral_date + (3 + floor(random() * 12)::INT);
      INSERT INTO referrals (client_id, partner_id, referral_type_id, referral_date, status_id, completed_date)
      VALUES (v_client_id, v_partner_id,
              CASE WHEN random() < 0.6 THEN v_warm_id ELSE v_info_id END,
              v_referral_date, v_referral_completed_id, v_completed_date)
      RETURNING id INTO v_referral_id;

    ELSIF v_days_ago > 14 AND v_rand < 0.89 THEN
      -- Not Completed (~15%)
      INSERT INTO referrals (client_id, partner_id, referral_type_id, referral_date, status_id, outcome_notes)
      VALUES (v_client_id, v_partner_id,
              CASE WHEN random() < 0.6 THEN v_warm_id ELSE v_info_id END,
              v_referral_date, v_referral_not_completed_id,
              (ARRAY[
                'Client did not respond to partner contact attempts.',
                'Partner program at capacity; placed on waitlist.',
                'Client moved out of service area.',
                'Client found alternative services independently.',
                'Transportation barriers prevented client from accessing services.',
                'Client''s schedule conflicts with available program hours.',
                'Language barriers; interpreter not available at partner.',
                'Client declined after initial consultation.'
              ])[1 + floor(random() * 8)::INT])
      RETURNING id INTO v_referral_id;

    ELSE
      -- Referred / still open (~25%, mostly recent)
      INSERT INTO referrals (client_id, partner_id, referral_type_id, referral_date, status_id)
      VALUES (v_client_id, v_partner_id,
              CASE WHEN random() < 0.6 THEN v_warm_id ELSE v_info_id END,
              v_referral_date, v_referral_referred_id)
      RETURNING id INTO v_referral_id;
    END IF;

    -- Auto-populate referral_service_categories from intersection of
    -- client needs and partner offerings
    SELECT array_agg(csn.service_category_id) INTO v_overlap
    FROM client_service_needs csn
    JOIN partner_service_categories psc ON csn.service_category_id = psc.service_category_id
    WHERE csn.client_id = v_client_id AND psc.partner_id = v_partner_id;

    IF v_overlap IS NOT NULL THEN
      INSERT INTO referral_service_categories (referral_id, service_category_id)
      SELECT v_referral_id, unnest(v_overlap)
      ON CONFLICT DO NOTHING;
    END IF;

    v_referral_count := v_referral_count + 1;
  END LOOP;

  -- Re-enable triggers
  ALTER TABLE referrals ENABLE TRIGGER ALL;

  RAISE NOTICE '  Created % referrals.', v_referral_count;

  -- ================================================================
  -- E. FOLLOW-UP SURVEYS
  --    The create_survey_after_referral_insert trigger was disabled
  --    during bulk insert, so we create surveys manually.
  --    Then update based on referral age and status.
  -- ================================================================

  RAISE NOTICE '── Generating follow-up surveys...';

  -- Create surveys for all referrals with display_name = "ClientName → PartnerName, date"
  INSERT INTO follow_up_surveys (referral_id, display_name)
  SELECT r.id,
         c.first_name || ' ' || c.last_name || ' → ' || p.display_name || ', ' || to_char(r.referral_date, 'YYYY-MM-DD')
  FROM referrals r
  JOIN clients c ON r.client_id = c.id
  JOIN partners p ON r.partner_id = p.id
  ON CONFLICT (referral_id) DO NOTHING;

  -- Completed referrals > 7 days old: mark survey Completed
  UPDATE follow_up_surveys s
  SET status_id = v_survey_completed_id,
      helpfulness_id = v_helpfulness_ids[1 + floor(random() * array_length(v_helpfulness_ids, 1))::INT],
      time_to_contact_id = v_ttc_ids[1 + floor(random() * array_length(v_ttc_ids, 1))::INT],
      outcome_id = v_outcome_ids[1 + floor(random() * array_length(v_outcome_ids, 1))::INT],
      completed_date = r.completed_date + (1 + floor(random() * 3)::INT)
  FROM referrals r
  WHERE s.referral_id = r.id
    AND r.status_id = v_referral_completed_id
    AND (CURRENT_DATE - r.referral_date) > 7;

  -- Non-completed referrals > 7 days old: mark survey Expired
  UPDATE follow_up_surveys s
  SET status_id = v_survey_expired_id
  FROM referrals r
  WHERE s.referral_id = r.id
    AND r.status_id = v_referral_not_completed_id
    AND (CURRENT_DATE - r.referral_date) > 7;

  -- Referrals <= 7 days old: keep survey Pending (already default)

  -- Ensure at least 2 surveys with "Not Helpful" + "No Action Taken"
  UPDATE follow_up_surveys
  SET helpfulness_id = v_not_helpful_id,
      outcome_id = v_no_action_id
  WHERE id IN (
    SELECT s.id
    FROM follow_up_surveys s
    WHERE s.status_id = v_survey_completed_id
    ORDER BY random()
    LIMIT 2
  );

  RAISE NOTICE '  Follow-up surveys generated and updated.';

  -- ================================================================
  -- DONE
  -- ================================================================

  RAISE NOTICE '── Seed demo data complete.';
  RAISE NOTICE '  Clients: %', v_client_count;
  RAISE NOTICE '  Partners: %', v_partner_count;
  RAISE NOTICE '  Referrals: %', v_referral_count;

END;
$$;

-- Reset sequences after explicit inserts
SELECT setval('client_consents_id_seq', COALESCE((SELECT MAX(id) FROM client_consents), 0) + 1, false);
SELECT setval('referrals_id_seq', COALESCE((SELECT MAX(id) FROM referrals), 0) + 1, false);
SELECT setval('follow_up_surveys_id_seq', COALESCE((SELECT MAX(id) FROM follow_up_surveys), 0) + 1, false);

NOTIFY pgrst, 'reload schema';
