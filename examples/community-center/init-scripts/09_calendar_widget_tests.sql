-- ============================================================================
-- CALENDAR WIDGET CONFIGURATION TESTS
-- Creates test dashboard with multiple calendar widgets demonstrating
-- different configuration options
-- ============================================================================

-- Add color column to reservations table for colorProperty testing
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS event_color hex_color;

-- Update existing reservations with colors based on resource
UPDATE reservations r
SET event_color = res.color
FROM resources res
WHERE r.resource_id = res.id AND r.event_color IS NULL;

-- Create test dashboard
DO $$
DECLARE
  v_dashboard_id INT;
  v_user_id UUID;
BEGIN
  -- Get first user
  SELECT id INTO v_user_id FROM metadata.civic_os_users LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    -- Check if dashboard already exists
    SELECT id INTO v_dashboard_id
    FROM metadata.dashboards
    WHERE display_name = 'Calendar Widget Tests';

    IF v_dashboard_id IS NOT NULL THEN
      -- Update existing dashboard
      UPDATE metadata.dashboards
      SET description = 'Testing calendar widget configuration options: filters, colors, initial date',
          updated_at = NOW()
      WHERE id = v_dashboard_id;
    ELSE
      -- Create new dashboard
      INSERT INTO metadata.dashboards (
        display_name,
        description,
        is_public,
        created_by,
        sort_order
      ) VALUES (
        'Calendar Widget Tests',
        'Testing calendar widget configuration options: filters, colors, initial date',
        TRUE,
        v_user_id,
        2  -- After Community Center Overview
      )
      RETURNING id INTO v_dashboard_id;
    END IF;

    -- Delete existing widgets for this dashboard (in case we're re-running)
    DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

    -- ========================================================================
    -- Widget 1: FILTER TEST - Only show Main Hall (resource_id = 3)
    -- ========================================================================
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'calendar',
      'reservations',
      '🔍 Filters: Main Hall Only',
      jsonb_build_object(
        'entityKey', 'reservations',
        'timeSlotPropertyName', 'time_slot',
        'defaultColor', '#3B82F6',
        'initialView', 'timeGridWeek',
        'showCreateButton', false,
        'maxEvents', 500,
        'filters', jsonb_build_array(
          jsonb_build_object('column', 'resource_id', 'operator', 'eq', 'value', 3)
        ),
        'showColumns', jsonb_build_array('resource_id', 'purpose', 'attendee_count')
      ),
      1, 2, 2  -- Full width, double height
    );

    -- ========================================================================
    -- Widget 2: COLOR PROPERTY TEST - Use event_color column
    -- ========================================================================
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'calendar',
      'reservations',
      '🎨 Color Property: Resource Colors',
      jsonb_build_object(
        'entityKey', 'reservations',
        'timeSlotPropertyName', 'time_slot',
        'colorProperty', 'event_color',  -- Use the color column
        'defaultColor', '#999999',  -- Fallback if color is NULL
        'initialView', 'timeGridWeek',
        'showCreateButton', false,
        'maxEvents', 500,
        'filters', jsonb_build_array(),
        'showColumns', jsonb_build_array('resource_id', 'purpose', 'reserved_by')
      ),
      2, 2, 2  -- Full width, double height
    );

    -- ========================================================================
    -- Widget 3: INITIAL DATE TEST - Show December 2025
    -- ========================================================================
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'calendar',
      'reservations',
      '📅 Initial Date: December 2025',
      jsonb_build_object(
        'entityKey', 'reservations',
        'timeSlotPropertyName', 'time_slot',
        'defaultColor', '#8B5CF6',  -- Purple
        'initialView', 'dayGridMonth',  -- Month view
        'initialDate', '2025-12-15',  -- Mid-December
        'showCreateButton', false,
        'maxEvents', 500,
        'filters', jsonb_build_array(),
        'showColumns', jsonb_build_array('resource_id', 'purpose')
      ),
      3, 1, 2  -- Half width, double height
    );

    -- ========================================================================
    -- Widget 4: COMBINED TEST - Filters + Colors + Day View
    -- ========================================================================
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'calendar',
      'reservations',
      '⚡ Combined: Filter + Colors + Day',
      jsonb_build_object(
        'entityKey', 'reservations',
        'timeSlotPropertyName', 'time_slot',
        'colorProperty', 'event_color',
        'defaultColor', '#10B981',  -- Green fallback
        'initialView', 'timeGridDay',  -- Day view
        'showCreateButton', true,  -- Enable create button
        'maxEvents', 100,
        'filters', jsonb_build_array(
          -- Show reservations with 20+ attendees
          jsonb_build_object('column', 'attendee_count', 'operator', 'gte', 'value', 20)
        ),
        'showColumns', jsonb_build_array('resource_id', 'purpose', 'attendee_count', 'reserved_by')
      ),
      4, 1, 2  -- Half width, double height
    );

    RAISE NOTICE 'Dashboard "Calendar Widget Tests" created successfully with ID %', v_dashboard_id;
  ELSE
    RAISE NOTICE 'No users found - skipping dashboard creation';
  END IF;
END $$;
