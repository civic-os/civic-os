-- Community Center Example: Enable Recurring Reservation Requests
-- This script enables the recurring time slot feature for the reservation_requests table
-- and creates sample recurring series for demonstration.
--
-- UX Model: Recurring series are a manager feature, not end-user. Managers create
-- series from /admin/recurring-schedules which generate reservation_requests that
-- flow through the normal approval workflow.
--
-- Added in v0.19.0

-- ============================================================================
-- 1. ENABLE RECURRING ON RESERVATION_REQUESTS
-- ============================================================================

-- Enable recurring schedules at the entity level (like calendar configuration)
-- This tells the UI which entity supports recurring and which time_slot column to use
INSERT INTO metadata.entities (table_name, supports_recurring, recurring_property_name)
VALUES ('reservation_requests', TRUE, 'time_slot')
ON CONFLICT (table_name) DO UPDATE SET
  supports_recurring = TRUE,
  recurring_property_name = 'time_slot';

-- For recurring series templates, requested_by must be settable in templates.
-- The RPC validates template fields against show_on_edit=true, so we enable it
-- for this field. The expansion worker uses the template to create instances.
UPDATE metadata.properties
SET show_on_edit = TRUE
WHERE table_name = 'reservation_requests'
  AND column_name = 'requested_by';

-- ============================================================================
-- 2. GRANT PERMISSIONS FOR SERIES MANAGEMENT
-- ============================================================================

-- Grant series permissions to editor role (using role_id lookup)
DO $$
DECLARE
  v_editor_id SMALLINT;
BEGIN
  SELECT id INTO v_editor_id FROM metadata.roles WHERE display_name = 'editor';

  IF v_editor_id IS NOT NULL THEN
    -- Series groups
    PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'read', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'create', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'update', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_series_groups', 'delete', TRUE);

    -- Series
    PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'read', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'create', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'update', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_series', 'delete', TRUE);

    -- Instances
    PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'read', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'create', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'update', TRUE);
    PERFORM set_role_permission(v_editor_id, 'time_slot_instances', 'delete', TRUE);

    RAISE NOTICE 'Granted series permissions to editor role (id: %)', v_editor_id;
  ELSE
    RAISE NOTICE 'Editor role not found, skipping permission grants';
  END IF;
END $$;

-- Admin gets all permissions automatically via is_admin check

-- ============================================================================
-- 3. CREATE SAMPLE RECURRING SERIES
-- ============================================================================

-- Create a weekly yoga class series (Tuesdays and Thursdays, 6pm-7pm)
-- This generates reservation_requests that managers can approve/deny
DO $$
DECLARE
  v_result JSONB;
  v_resource_id BIGINT;
  v_user_id UUID;
BEGIN
  -- Get the first resource (main hall or similar)
  SELECT id INTO v_resource_id FROM resources ORDER BY id LIMIT 1;
  -- Get a user for requested_by (use first available user)
  SELECT id INTO v_user_id FROM metadata.civic_os_users ORDER BY id LIMIT 1;
  -- Note: status_id defaults via get_initial_status() column default on reservation_requests

  IF v_resource_id IS NOT NULL AND v_user_id IS NOT NULL THEN
    -- Create weekly yoga class requests
    SELECT create_recurring_series(
      p_group_name := 'Weekly Yoga Class',
      p_group_description := 'Community yoga sessions every Tuesday and Thursday evening. Requests auto-generated for manager approval.',
      p_group_color := '#10B981',
      p_entity_table := 'reservation_requests',
      p_entity_template := jsonb_build_object(
        'resource_id', v_resource_id,
        'purpose', 'Weekly Yoga Class - Community wellness program',
        'requested_by', v_user_id,
        'attendee_count', 15,
        'notes', 'Auto-generated from recurring series. Please approve to create reservation.'
      ),
      p_rrule := 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=12',
      p_dtstart := (NOW() + INTERVAL '1 day')::timestamptz,
      p_duration := 'PT1H',
      p_timezone := 'America/New_York',
      p_time_slot_property := 'time_slot',
      p_expand_now := TRUE,
      p_skip_conflicts := TRUE
    ) INTO v_result;

    RAISE NOTICE 'Created Weekly Yoga Class series: %', v_result;
  ELSE
    RAISE NOTICE 'Skipping yoga class: resource_id=%, user_id=%', v_resource_id, v_user_id;
  END IF;
END $$;

-- Create a monthly board meeting series (First Monday of each month, 7pm-9pm)
DO $$
DECLARE
  v_result JSONB;
  v_resource_id BIGINT;
  v_user_id UUID;
BEGIN
  -- Get a meeting room resource
  SELECT id INTO v_resource_id FROM resources WHERE display_name ILIKE '%meeting%' OR display_name ILIKE '%room%' ORDER BY id LIMIT 1;
  -- Get a user for requested_by
  SELECT id INTO v_user_id FROM metadata.civic_os_users ORDER BY id LIMIT 1;
  -- Note: status_id defaults via get_initial_status() column default on reservation_requests

  -- Fallback to first resource if no meeting room
  IF v_resource_id IS NULL THEN
    SELECT id INTO v_resource_id FROM resources ORDER BY id LIMIT 1;
  END IF;

  IF v_resource_id IS NOT NULL AND v_user_id IS NOT NULL THEN
    -- Create monthly board meeting requests
    SELECT create_recurring_series(
      p_group_name := 'Monthly Board Meeting',
      p_group_description := 'Community center board meets first Monday of each month. Auto-generates requests for manager approval.',
      p_group_color := '#3B82F6',
      p_entity_table := 'reservation_requests',
      p_entity_template := jsonb_build_object(
        'resource_id', v_resource_id,
        'purpose', 'Monthly Board Meeting - Community Center governance',
        'requested_by', v_user_id,
        'attendee_count', 8,
        'notes', 'Auto-generated from recurring series. High priority - board members attending.'
      ),
      p_rrule := 'FREQ=MONTHLY;BYDAY=1MO;COUNT=6',
      p_dtstart := (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' + INTERVAL '19 hours')::timestamptz,
      p_duration := 'PT2H',
      p_timezone := 'America/New_York',
      p_time_slot_property := 'time_slot',
      p_expand_now := TRUE,
      p_skip_conflicts := TRUE
    ) INTO v_result;

    RAISE NOTICE 'Created Monthly Board Meeting series: %', v_result;
  END IF;
END $$;

-- ============================================================================
-- 4. VERIFY SETUP
-- ============================================================================

-- Show created series groups
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM metadata.time_slot_series_groups;
  RAISE NOTICE 'Total series groups created: %', v_count;

  SELECT COUNT(*) INTO v_count FROM metadata.time_slot_series;
  RAISE NOTICE 'Total series created: %', v_count;

  SELECT COUNT(*) INTO v_count FROM metadata.time_slot_instances;
  RAISE NOTICE 'Total instances created: %', v_count;

  SELECT COUNT(*) INTO v_count FROM reservation_requests
  WHERE id IN (SELECT entity_id FROM metadata.time_slot_instances);
  RAISE NOTICE 'Reservation requests in series: %', v_count;
END $$;

-- ============================================================================
-- USAGE NOTES
-- ============================================================================
-- After running this script:
--
-- 1. Navigate to /admin/recurring-schedules to see the series management page
--    (requires editor or admin role)
--
-- 2. The management page shows:
--    - All series groups with their schedules
--    - Version history for each series
--    - List of upcoming instances (reservation requests)
--
-- 3. View any reservation request created by a series to see the "Recurring"
--    badge linking back to series management
--
-- 4. Workflow Integration:
--    - Series generates reservation_requests with 'Pending' status
--    - Managers approve/deny requests using normal workflow
--    - Approved requests create actual reservations
--
-- 5. When editing a recurring request occurrence, special logic applies:
--    - "This only" - Edit just this occurrence (marks as exception)
--    - "This and future" - Splits series at this point
--    - "All" - Updates template for all non-exception occurrences
--
-- 6. To create new recurring series, use the "Create Series" wizard from
--    /admin/recurring-schedules (manager feature, not end-user CreatePage)
--
