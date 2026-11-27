-- ============================================================================
-- MOTT PARK - COMPLETE SCHEMA RESET
-- ============================================================================
-- Drops all Mott Park tables and clears related metadata.
-- Run this to prepare for a fresh run of scripts 01-05.
--
-- This script:
--   1. Drops all application tables (with CASCADE for dependencies)
--   2. Clears metadata.entities, properties, validations, etc.
--   3. Clears metadata.permissions and permission_roles
--   4. Clears metadata.statuses for Mott Park entity types
--   5. Clears notification templates
--   6. Clears dashboards and widgets
--
-- After running this, execute scripts 01-05 in order to rebuild.
--
-- Section 0 removes the Mott Fest module (scripts 34-38) on its own: run
-- only Section 0 (it is one DO block plus its drops) to remove the module and
-- keep the clubhouse, then re-apply 34-38. It runs first because the module's
-- tables reference clubhouse-era statuses (payment_method).
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 0: MOTT FEST MODULE (scripts 34-38, 40)
-- ============================================================================

DO $$
DECLARE
  v_tables TEXT[] := ARRAY['festival', 'vendor_application', 'food_truck_application',
                           'sponsorship_application', 'feedback_response', 'feedback_submission',
                           'current_festival', 'mottfest_revenue_summary', 'mottfest_current_summary'];
  v_status_types TEXT[] := ARRAY['festival', 'vendor_application', 'food_truck_application',
                                 'sponsorship_application'];
  v_category_types TEXT[] := ARRAY['vendor_type', 'sponsorship_tier', 'tshirt_size', 'worth_it'];
  v_dashboards TEXT[] := ARRAY['Mott Fest', 'Mott Fest Management', 'Thanks for your feedback'];
  v_role_id INT := (SELECT id FROM metadata.roles WHERE role_key = 'mottfest_admin');
  v_mottfest_dashboard BIGINT := (SELECT id FROM metadata.dashboards WHERE display_name = 'Mott Fest');
  v_fn REGPROCEDURE;
BEGIN
  -- Banner on the clubhouse dashboard (found by its link, as script 40 does);
  -- the clubhouse welcome header beside it goes back to full width.
  IF v_mottfest_dashboard IS NOT NULL THEN
    DELETE FROM metadata.dashboard_widgets
     WHERE dashboard_id <> ALL (SELECT id FROM metadata.dashboards WHERE display_name = ANY (v_dashboards))
       AND config->>'content' LIKE '%/dashboard/' || v_mottfest_dashboard || '"%';
    IF FOUND THEN
      UPDATE metadata.dashboard_widgets
         SET width = 2
       WHERE id = (SELECT w.id FROM metadata.dashboard_widgets w
                     JOIN metadata.dashboards d ON d.id = w.dashboard_id
                    WHERE d.display_name = 'Mott Park Clubhouse Reservations'
                      AND w.widget_type = 'markdown' AND COALESCE(w.title, '') = ''
                    ORDER BY w.sort_order, w.id LIMIT 1)
         AND width = 1;
    END IF;
  END IF;

  -- Dashboards (widgets and dashboard_roles go first)
  DELETE FROM metadata.dashboard_roles
   WHERE dashboard_id IN (SELECT id FROM metadata.dashboards WHERE display_name = ANY (v_dashboards));
  DELETE FROM metadata.dashboard_widgets
   WHERE dashboard_id IN (SELECT id FROM metadata.dashboards WHERE display_name = ANY (v_dashboards));
  DELETE FROM metadata.dashboards WHERE display_name = ANY (v_dashboards);

  -- Menu: children of the heading, hidden helper nodes, then the heading
  DELETE FROM metadata.menu_nodes WHERE parent_node_key = 'mottfest' OR target_key = ANY (v_tables);
  DELETE FROM metadata.menu_nodes WHERE node_key = 'mottfest';

  -- Notifications before their templates (FK by name)
  DELETE FROM metadata.notifications
   WHERE template_name LIKE 'mottfest\_%' OR entity_type = ANY (v_tables);
  DELETE FROM metadata.notification_templates WHERE name LIKE 'mottfest\_%';

  -- Payments opened by the module (refunds first; the sample users are RESTRICTed by these)
  DELETE FROM payments.refunds
   WHERE transaction_id IN (SELECT id FROM payments.transactions WHERE entity_type = ANY (v_tables));
  -- Guarded: PL/pgSQL resolves table names only when a statement runs, so a
  -- reset of an instance without the module would fail here.
  IF to_regclass('public.vendor_application') IS NOT NULL THEN
    UPDATE vendor_application      SET payment_transaction_id = NULL WHERE payment_transaction_id IS NOT NULL;
    UPDATE food_truck_application  SET payment_transaction_id = NULL WHERE payment_transaction_id IS NOT NULL;
    UPDATE sponsorship_application SET payment_transaction_id = NULL WHERE payment_transaction_id IS NOT NULL;
  END IF;
  DELETE FROM payments.transactions WHERE entity_type = ANY (v_tables);

  -- Per-entity metadata
  DELETE FROM metadata.entity_action_roles
   WHERE entity_action_id IN (SELECT id FROM metadata.entity_actions WHERE table_name = ANY (v_tables));
  DELETE FROM metadata.entity_action_params
   WHERE entity_action_id IN (SELECT id FROM metadata.entity_actions WHERE table_name = ANY (v_tables));
  DELETE FROM metadata.entity_actions WHERE table_name = ANY (v_tables);
  DELETE FROM metadata.permission_roles
   WHERE permission_id IN (SELECT id FROM metadata.permissions WHERE table_name = ANY (v_tables)
                              OR table_name = ANY (SELECT t || ':notes' FROM unnest(v_tables) t));
  DELETE FROM metadata.permissions
   WHERE table_name = ANY (v_tables) OR table_name = ANY (SELECT t || ':notes' FROM unnest(v_tables) t);
  DELETE FROM metadata.entity_notes WHERE entity_type = ANY (v_tables);
  DELETE FROM metadata.files WHERE entity_type = ANY (v_tables);
  DELETE FROM metadata.static_text WHERE table_name = ANY (v_tables);
  DELETE FROM metadata.validations WHERE table_name = ANY (v_tables);
  DELETE FROM metadata.constraint_messages WHERE table_name = ANY (v_tables);
  DELETE FROM metadata.properties WHERE table_name = ANY (v_tables);
  DELETE FROM metadata.entities WHERE table_name = ANY (v_tables);

  -- Role (the user_roles and roles deletes queue the Keycloak sync)
  IF v_role_id IS NOT NULL THEN
    DELETE FROM metadata.user_roles WHERE role_id = v_role_id;
    DELETE FROM metadata.entity_action_roles WHERE role_id = v_role_id;
    DELETE FROM metadata.permission_roles WHERE role_id = v_role_id;
    DELETE FROM metadata.dashboard_roles WHERE role_id = v_role_id;
    DELETE FROM metadata.dashboard_role_defaults WHERE role_id = v_role_id;
    DELETE FROM metadata.role_can_manage WHERE v_role_id IN (manager_role_id, managed_role_id);
    DELETE FROM metadata.roles WHERE id = v_role_id;
  END IF;

  -- Contact email setting
  DELETE FROM metadata.instance_config WHERE config_key LIKE 'mottfest\_%';
  DELETE FROM metadata.instance_config_groups WHERE group_key = 'mottfest';

  -- Decision records written by 34-37 and 40
  DELETE FROM metadata.schema_decisions WHERE migration_id LIKE '__\_mottfest\_%';

  -- Views, tables (CASCADE takes triggers, policies, indexes), then functions
  DROP VIEW IF EXISTS feedback_submission, current_festival,
                      mottfest_current_summary, mottfest_revenue_summary CASCADE;
  DROP TABLE IF EXISTS feedback_response, sponsorship_application, food_truck_application,
                       vendor_application, festival CASCADE;
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname LIKE 'mottfest\_%'
         OR p.proname LIKE '%mottfest%'
         OR p.proname IN ('approve_vendor_application', 'waive_and_approve_vendor_application',
                          'deny_vendor_application', 'withdraw_vendor_application', 'record_vendor_payment',
                          'approve_food_truck_application', 'deny_food_truck_application',
                          'withdraw_food_truck_application', 'record_food_truck_payment',
                          'approve_sponsorship', 'deny_sponsorship', 'withdraw_sponsorship',
                          'record_sponsorship_payment',
                          'enable_online_payment_vendor_application',
                          'enable_online_payment_food_truck_application',
                          'enable_online_payment_sponsorship',
                          'initiate_vendor_application_payment', 'initiate_food_truck_application_payment',
                          'initiate_sponsorship_payment',
                          'open_festival', 'close_festival', 'complete_festival',
                          'get_current_festival', 'get_manual_payment_methods'))
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', v_fn);
  END LOOP;

  -- Status and category sets (the tables that referenced them are gone)
  DELETE FROM metadata.status_transitions WHERE entity_type = ANY (v_status_types);
  DELETE FROM metadata.statuses WHERE entity_type = ANY (v_status_types);
  DELETE FROM metadata.status_types WHERE entity_type = ANY (v_status_types);
  DELETE FROM metadata.categories WHERE entity_type = ANY (v_category_types);
  DELETE FROM metadata.category_groups WHERE entity_type = ANY (v_category_types);

  -- Sample placeholder users from script 38 (private rows cascade)
  DELETE FROM metadata.civic_os_users WHERE id::text LIKE '5a3b1e00-0000-4000-8000-%';

  RAISE NOTICE 'Mott Fest module removed';
END;
$$;

-- ============================================================================
-- SECTION 1: DROP APPLICATION TABLES
-- ============================================================================
-- Order matters due to foreign key dependencies
-- CASCADE handles any remaining dependencies

-- Drop computed field functions first (depends on table types)
DROP FUNCTION IF EXISTS public.reservation_payments_display_name(reservation_payments) CASCADE;
DROP FUNCTION IF EXISTS set_payment_type_name() CASCADE;
DROP FUNCTION IF EXISTS set_payment_denormalized_fields() CASCADE;
DROP FUNCTION IF EXISTS set_payment_display_name() CASCADE;
DROP FUNCTION IF EXISTS sync_reservation_payment_status() CASCADE;
DROP FUNCTION IF EXISTS sync_reservation_payment_refund() CASCADE;
DROP FUNCTION IF EXISTS sync_reservation_color_from_status() CASCADE;
DROP FUNCTION IF EXISTS public.reservation_requests_display_name(reservation_requests) CASCADE;

-- Drop triggers and functions
DROP FUNCTION IF EXISTS sync_public_calendar_event() CASCADE;
DROP FUNCTION IF EXISTS notify_new_reservation_request() CASCADE;
DROP FUNCTION IF EXISTS notify_reservation_status_change() CASCADE;
DROP FUNCTION IF EXISTS add_reservation_status_change_note() CASCADE;
DROP FUNCTION IF EXISTS add_payment_status_change_note() CASCADE;
DROP FUNCTION IF EXISTS create_reservation_payments() CASCADE;
DROP FUNCTION IF EXISTS on_reservation_approved() CASCADE;
DROP FUNCTION IF EXISTS update_calendar_active_status() CASCADE;
DROP FUNCTION IF EXISTS get_event_start(time_slot) CASCADE;
DROP FUNCTION IF EXISTS calculate_holiday_fee_date(TSTZRANGE) CASCADE;
DROP FUNCTION IF EXISTS is_holiday_or_weekend(DATE) CASCADE;

-- Drop entity action RPC functions
DROP FUNCTION IF EXISTS approve_reservation_request(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS deny_reservation_request(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS cancel_reservation_request(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS mark_reservation_complete(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS close_reservation(BIGINT) CASCADE;

-- Drop tables (order: dependents first)
DROP TABLE IF EXISTS public_calendar_events CASCADE;
DROP TABLE IF EXISTS reservation_payments CASCADE;
DROP TABLE IF EXISTS reservation_requests CASCADE;
DROP TABLE IF EXISTS reservation_payment_types CASCADE;
DROP TABLE IF EXISTS holiday_rules CASCADE;

-- ============================================================================
-- SECTION 2: CLEAR METADATA - ENTITIES & PROPERTIES
-- ============================================================================

-- List of Mott Park table names for cleanup
DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'reservation_requests',
    'reservation_payments',
    'reservation_payment_types',
    'public_calendar_events',
    'holiday_rules'
  ];
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY v_tables
  LOOP
    -- Delete properties
    DELETE FROM metadata.properties WHERE table_name = v_table;

    -- Delete validations
    DELETE FROM metadata.validations WHERE table_name = v_table;

    -- Delete constraint messages
    DELETE FROM metadata.constraint_messages WHERE table_name = v_table;

    -- Delete static text blocks
    DELETE FROM metadata.static_text WHERE table_name = v_table;

    -- Delete entity action roles first (FK to entity_actions)
    DELETE FROM metadata.entity_action_roles
    WHERE entity_action_id IN (SELECT id FROM metadata.entity_actions WHERE table_name = v_table);

    -- Delete entity actions
    DELETE FROM metadata.entity_actions WHERE table_name = v_table;

    -- Delete permission roles (FK to permissions)
    DELETE FROM metadata.permission_roles
    WHERE permission_id IN (SELECT id FROM metadata.permissions WHERE table_name = v_table);

    -- Delete permissions
    DELETE FROM metadata.permissions WHERE table_name = v_table;

    -- Delete entity notes for this entity type
    DELETE FROM metadata.entity_notes WHERE entity_type = v_table;

    -- Delete entities last
    DELETE FROM metadata.entities WHERE table_name = v_table;

    RAISE NOTICE 'Cleared metadata for: %', v_table;
  END LOOP;
END;
$$;

-- ============================================================================
-- SECTION 3: CLEAR STATUSES
-- ============================================================================

DELETE FROM metadata.statuses WHERE entity_type IN (
  'reservation_request',
  'reservation_payment'
);

-- ============================================================================
-- SECTION 4: CLEAR NOTIFICATIONS AND TEMPLATES
-- ============================================================================

-- Delete notifications FIRST (FK references templates by name)
DELETE FROM metadata.notifications WHERE entity_type = 'reservation_requests';
DELETE FROM metadata.notifications WHERE template_name LIKE 'reservation_%';

-- Now safe to delete templates
DELETE FROM metadata.notification_templates WHERE entity_type = 'reservation_requests';
DELETE FROM metadata.notification_templates WHERE name LIKE 'reservation_%';

-- ============================================================================
-- SECTION 5: CLEAR DASHBOARDS
-- ============================================================================

-- Delete widgets first (FK to dashboards)
DELETE FROM metadata.dashboard_widgets
WHERE dashboard_id IN (
  SELECT id FROM metadata.dashboards
  WHERE display_name ILIKE '%mott park%'
     OR display_name ILIKE '%mpra%'
);

-- Delete dashboards
DELETE FROM metadata.dashboards
WHERE display_name ILIKE '%mott park%'
   OR display_name ILIKE '%mpra%';

-- Also clean up any widgets referencing our entities in config
DELETE FROM metadata.dashboard_widgets
WHERE config::TEXT LIKE '%reservation_requests%'
   OR config::TEXT LIKE '%public_calendar_events%'
   OR config::TEXT LIKE '%holiday_rules%';

-- ============================================================================
-- SECTION 6: CLEAR FILES (uploaded for reservations)
-- ============================================================================

-- If there are any files associated with reservations, clear them
-- (The file storage uses entity_type/entity_id pattern)
DELETE FROM metadata.files WHERE entity_type = 'reservation_requests';

-- ============================================================================
-- SECTION 7: VERIFICATION
-- ============================================================================

DO $$
DECLARE
  v_entities INT;
  v_properties INT;
  v_permissions INT;
  v_statuses INT;
  v_templates INT;
BEGIN
  SELECT COUNT(*) INTO v_entities FROM metadata.entities
    WHERE table_name IN ('reservation_requests', 'reservation_payments', 'reservation_payment_types', 'public_calendar_events', 'holiday_rules');
  SELECT COUNT(*) INTO v_properties FROM metadata.properties
    WHERE table_name IN ('reservation_requests', 'reservation_payments', 'reservation_payment_types', 'public_calendar_events', 'holiday_rules');
  SELECT COUNT(*) INTO v_permissions FROM metadata.permissions
    WHERE table_name IN ('reservation_requests', 'reservation_payments', 'reservation_payment_types', 'public_calendar_events', 'holiday_rules');
  SELECT COUNT(*) INTO v_statuses FROM metadata.statuses
    WHERE entity_type IN ('reservation_request', 'reservation_payment');
  SELECT COUNT(*) INTO v_templates FROM metadata.notification_templates
    WHERE entity_type = 'reservation_requests';

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE 'MOTT PARK SCHEMA RESET COMPLETE';
  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'Remaining references (should all be 0):';
  RAISE NOTICE '  - Entities:      %', v_entities;
  RAISE NOTICE '  - Properties:    %', v_properties;
  RAISE NOTICE '  - Permissions:   %', v_permissions;
  RAISE NOTICE '  - Statuses:      %', v_statuses;
  RAISE NOTICE '  - Templates:     %', v_templates;
  RAISE NOTICE '';

  IF v_entities + v_properties + v_permissions + v_statuses + v_templates > 0 THEN
    RAISE WARNING 'Some metadata still exists - check for naming mismatches';
  ELSE
    RAISE NOTICE '✓ All Mott Park metadata cleared successfully';
    RAISE NOTICE '';
    RAISE NOTICE 'Ready to run scripts 01-05:';
    RAISE NOTICE '  1. 01_mpra_reservations_schema.sql';
    RAISE NOTICE '  2. 02_mpra_holidays_dashboard.sql';
    RAISE NOTICE '  3. 03_mpra_manager_automation.sql';
    RAISE NOTICE '  4. 04_mpra_new_features.sql';
    RAISE NOTICE '  5. 05_mpra_public_calendar.sql';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════';
END;
$$;

COMMIT;

-- Notify PostgREST to refresh schema cache
NOTIFY pgrst, 'reload schema';
