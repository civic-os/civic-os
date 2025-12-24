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
-- ============================================================================

BEGIN;

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
