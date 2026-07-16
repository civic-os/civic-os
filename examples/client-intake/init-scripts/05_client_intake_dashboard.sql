-- =====================================================
-- Client Intake & Referral - Dashboard
-- =====================================================
-- Staff-facing home page with operational visibility:
-- Intake Pending, Open Referrals, Pending Surveys, Partner Map.
--
-- created_by is NULL (system-seeded, no human owner).
-- Role defaults assign this dashboard to ecs_staff and admin
-- so staff see it automatically on login.

BEGIN;

DO $$
DECLARE
  v_dashboard_id INT;
  v_intake_pending_id INT;
  v_referred_id INT;
  v_survey_pending_id INT;
BEGIN
  SELECT id INTO v_intake_pending_id FROM metadata.statuses
    WHERE entity_type = 'client' AND status_key = 'intake_pending';
  SELECT id INTO v_referred_id FROM metadata.statuses
    WHERE entity_type = 'referral' AND status_key = 'referred';
  SELECT id INTO v_survey_pending_id FROM metadata.statuses
    WHERE entity_type = 'survey' AND status_key = 'pending';

  -- Upsert the dashboard (created_by NULL = system-seeded)
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE display_name = 'ECS Intake Dashboard';

  IF v_dashboard_id IS NOT NULL THEN
    UPDATE metadata.dashboards
    SET description = 'Client intake, referrals, and survey tracking',
        is_public = TRUE,
        sort_order = 1,
        updated_at = NOW()
    WHERE id = v_dashboard_id;
  ELSE
    INSERT INTO metadata.dashboards (
      display_name, description, is_public, created_by, sort_order
    ) VALUES (
      'ECS Intake Dashboard',
      'Client intake, referrals, and survey tracking',
      TRUE, NULL, 1
    )
    RETURNING id INTO v_dashboard_id;
  END IF;

  DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

  -- Widget 1: Recent Clients (Intake Pending)
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, entity_key, title,
    config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    'clients',
    'Intake Pending',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_intake_pending_id)
      ),
      'orderBy', 'created_at',
      'orderDirection', 'desc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'status_id')
    ),
    1, 1, 1
  );

  -- Widget 2: Open Referrals
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, entity_key, title,
    config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'filtered_list',
    'referrals',
    'Open Referrals',
    jsonb_build_object(
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_referred_id)
      ),
      'orderBy', 'referral_date',
      'orderDirection', 'desc',
      'limit', 10,
      'showColumns', jsonb_build_array('display_name', 'client_id', 'partner_id', 'referral_type_id', 'referral_date')
    ),
    2, 1, 1
  );

  -- Widget 3: Pending Surveys
  IF v_survey_pending_id IS NOT NULL THEN
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'follow_up_surveys',
      'Pending Surveys',
      jsonb_build_object(
        'filters', jsonb_build_array(
          jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_survey_pending_id)
        ),
        'orderBy', 'created_at',
        'orderDirection', 'asc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'referral_id', 'status_id')
      ),
      3, 1, 1
    );
  END IF;

  -- Widget 4: Partner Map
  INSERT INTO metadata.dashboard_widgets (
    dashboard_id, widget_type, entity_key, title,
    config, sort_order, width, height
  ) VALUES (
    v_dashboard_id,
    'map',
    'partners',
    'Partner Locations',
    jsonb_build_object(
      'geoColumn', 'location',
      'labelColumn', 'display_name',
      'filters', jsonb_build_array(
        jsonb_build_object('column', 'active', 'operator', 'eq', 'value', true)
      ),
      'center', jsonb_build_object('lat', 43.01, 'lng', -83.69),
      'zoom', 12
    ),
    4, 2, 2
  );

  -- Assign this dashboard as the default for ecs_staff and admin roles
  INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
  SELECT r.id, v_dashboard_id, CASE r.role_key WHEN 'admin' THEN 10 ELSE 0 END
  FROM metadata.roles r
  WHERE r.role_key IN ('ecs_staff', 'admin')
  ON CONFLICT (role_id) DO UPDATE
    SET dashboard_id = EXCLUDED.dashboard_id,
        priority = EXCLUDED.priority;

END $$;

COMMIT;
