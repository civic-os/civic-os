-- =====================================================
-- Community Center - Metadata Enhancements
-- =====================================================
-- Improves display names, descriptions, and creates custom dashboard
-- This script makes the UI more user-friendly and example-specific

-- =====================================================
-- ENTITY METADATA (Display Names, Descriptions, Sort Order)
-- =====================================================

-- Request Statuses entity (lookup table)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('request_statuses', 'Request Statuses', 'Status values for reservation requests (pending, approved, denied, cancelled)', 0)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Resources entity
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('resources', 'Resources', 'Community center facilities available for reservation (meeting rooms, event spaces, etc.)', 1)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Reservation Requests entity
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('reservation_requests', 'Reservation Requests', 'Member booking requests pending approval, denial, or already processed', 2)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Reservations entity (with calendar configuration)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, show_calendar, calendar_property_name, calendar_color_property)
VALUES ('reservations', 'Reservations', 'Approved facility bookings shown in calendar view', 3, TRUE, 'time_slot', NULL)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_calendar = EXCLUDED.show_calendar,
  calendar_property_name = EXCLUDED.calendar_property_name,
  calendar_color_property = EXCLUDED.calendar_color_property;

-- =====================================================
-- PROPERTY METADATA (Resources Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('resources', 'display_name', 'Facility Name', 'Name of the community center facility', 1, TRUE, TRUE, TRUE),
  ('resources', 'description', 'Description', 'Details about amenities, equipment, and special features', 2, FALSE, TRUE, TRUE),
  ('resources', 'color', 'Display Color', 'Color used for this resource in calendars and visual displays', 3, TRUE, TRUE, TRUE),
  ('resources', 'capacity', 'Capacity', 'Maximum number of attendees allowed', 4, TRUE, TRUE, TRUE),
  ('resources', 'hourly_rate', 'Hourly Rate', 'Rental cost per hour (USD)', 5, TRUE, TRUE, TRUE),
  ('resources', 'active', 'Active', 'Whether this facility is currently available for booking', 6, FALSE, TRUE, TRUE),
  ('resources', 'created_at', 'Created', 'When this facility was added to the system', 7, FALSE, FALSE, FALSE),
  ('resources', 'updated_at', 'Last Updated', 'When this facility information was last modified', 8, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;

-- =====================================================
-- PROPERTY METADATA (Reservation Requests Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_list, show_on_create, show_on_edit)
VALUES
  ('reservation_requests', 'display_name', 'Request', 'Auto-generated summary of the request', 1, 1, FALSE, FALSE, FALSE),
  ('reservation_requests', 'status_id', 'Status', 'Current state (pending → approved/denied/cancelled)', 2, 1, TRUE, FALSE, TRUE),
  ('reservation_requests', 'resource_id', 'Facility', 'Select the facility you want to reserve', 3, 1, TRUE, TRUE, TRUE),
  ('reservation_requests', 'time_slot', 'Requested Time', 'Select start and end times (displayed in your local timezone)', 4, 2, TRUE, TRUE, TRUE),
  ('reservation_requests', 'purpose', 'Purpose', 'What the facility will be used for (e.g., Birthday Party, Board Meeting)', 5, 2, TRUE, TRUE, TRUE),
  ('reservation_requests', 'attendee_count', 'Expected Attendees', 'Number of people expected to attend', 6, 1, TRUE, TRUE, TRUE),
  ('reservation_requests', 'notes', 'Special Requests', 'Equipment needs, setup preferences, catering, decoration access, etc.', 7, 2, FALSE, TRUE, TRUE),
  ('reservation_requests', 'requested_by', 'Requested By', 'Community member who submitted this request', 8, 1, FALSE, FALSE, FALSE),
  ('reservation_requests', 'reviewed_by', 'Reviewed By', 'Staff member who processed this request', 9, 1, FALSE, FALSE, TRUE),
  ('reservation_requests', 'reviewed_at', 'Review Date', 'When this request was approved or denied', 10, 1, FALSE, FALSE, TRUE),
  ('reservation_requests', 'denial_reason', 'Denial Reason', 'Required when changing status to Denied', 11, 2, FALSE, FALSE, TRUE),
  ('reservation_requests', 'reservation_id', 'Reservation', 'Link to approved reservation (auto-created by trigger)', 12, 1, FALSE, FALSE, FALSE),
  ('reservation_requests', 'created_at', 'Submitted', 'When this request was first submitted', 13, 1, FALSE, FALSE, FALSE),
  ('reservation_requests', 'updated_at', 'Last Modified', 'When this request was last updated', 14, 1, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;

-- =====================================================
-- PROPERTY METADATA (Reservations Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_list, show_on_create, show_on_edit)
VALUES
  ('reservations', 'display_name', 'Reservation', 'Auto-generated reservation summary', 1, 1, FALSE, FALSE, FALSE),
  ('reservations', 'resource_id', 'Facility', 'Which facility is reserved', 2, 1, TRUE, TRUE, TRUE),
  ('reservations', 'time_slot', 'Reserved Time', 'Start and end date/time for this approved booking', 3, 2, TRUE, TRUE, TRUE),
  ('reservations', 'purpose', 'Event Purpose', 'What the facility will be used for', 4, 2, TRUE, TRUE, TRUE),
  ('reservations', 'attendee_count', 'Expected Attendees', 'Number of people expected to attend', 5, 1, TRUE, TRUE, TRUE),
  ('reservations', 'notes', 'Setup Notes', 'Special setup or equipment requirements', 6, 2, FALSE, TRUE, TRUE),
  ('reservations', 'reserved_by', 'Reserved By', 'Community member who booked this facility', 7, 1, FALSE, FALSE, FALSE),
  ('reservations', 'created_at', 'Approved On', 'When this reservation was approved', 8, 1, FALSE, FALSE, FALSE),
  ('reservations', 'updated_at', 'Last Modified', 'When this reservation was last updated', 9, 1, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;

-- =====================================================
-- PROPERTY METADATA (Request Statuses Table)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit)
VALUES
  ('request_statuses', 'display_name', 'Status Name', 'Name of the status (Pending, Approved, Denied, Cancelled)', 1, TRUE, TRUE, TRUE),
  ('request_statuses', 'emoji', 'Emoji', 'Visual icon for this status', 2, TRUE, TRUE, TRUE),
  ('request_statuses', 'color', 'Color', 'Badge color for this status', 3, TRUE, TRUE, TRUE),
  ('request_statuses', 'description', 'Description', 'Explanation of what this status means', 4, FALSE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit;

-- =====================================================
-- CUSTOM DASHBOARD
-- =====================================================

DO $$
DECLARE
  v_dashboard_id INT;
  v_user_id UUID;
BEGIN
  -- Get first user (or could use a specific admin user)
  SELECT id INTO v_user_id FROM metadata.civic_os_users LIMIT 1;

  -- Only create dashboard if we have a user
  IF v_user_id IS NOT NULL THEN
    -- Check if dashboard already exists
    SELECT id INTO v_dashboard_id
    FROM metadata.dashboards
    WHERE display_name = 'Community Center Overview';

    IF v_dashboard_id IS NOT NULL THEN
      -- Update existing dashboard
      UPDATE metadata.dashboards
      SET description = 'Facility reservations, pending requests, and resource availability',
          sort_order = 1,
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
        'Community Center Overview',
        'Facility reservations, pending requests, and resource availability',
        TRUE,  -- Public dashboard (visible to all users)
        v_user_id,
        1
      )
      RETURNING id INTO v_dashboard_id;
    END IF;

    /* FUTURE (Phase 2): Dashboard widgets (filtered lists and calendar)

    -- Delete existing widgets for this dashboard (in case we're re-running)
    DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

    -- Panel 1: Pending Requests
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id, 'filtered_list', 'reservation_requests', 'Pending Approval',
      '{"filters": [{"column": "status_id", "operator": "eq", "value": "1"}]}'::JSONB,
      1, 2, 1
    );

    -- Panel 2: Upcoming Reservations (Calendar)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id, 'calendar', 'reservations', 'Upcoming Reservations',
      '{}'::JSONB, 2, 2, 2
    );

    -- Panel 3: Available Facilities
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id, 'filtered_list', 'resources', 'Available Facilities',
      '{"filters": [{"column": "active", "operator": "eq", "value": "true"}]}'::JSONB,
      3, 1, 1
    );

    -- Panel 4: Recent Requests
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title,
      config, sort_order, width, height
    ) VALUES (
      v_dashboard_id, 'filtered_list', 'reservation_requests', 'Recent Requests',
      '{}'::JSONB, 4, 1, 1
    );
    */

    RAISE NOTICE 'Dashboard "Community Center Overview" created successfully with ID %', v_dashboard_id;
  ELSE
    RAISE NOTICE 'No users found - skipping dashboard creation';
  END IF;
END $$;

-- =====================================================
-- UPDATE WELCOME DASHBOARD
-- =====================================================

-- Update the default Welcome dashboard with Community Center-specific content
UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
  'content', E'# Welcome to Community Center Reservations

This demo showcases Civic OS\'s **calendar integration** features with a facility reservation and approval workflow.

## Quick Start

1. **Browse Facilities** - Visit `/view/resources` to see available spaces (Club House, etc.)
2. **View Calendar** - Go to `/view/reservations` and click the **Calendar** tab to see approved bookings
3. **Request a Reservation** - Click "Create" on Reservation Requests to submit a booking request
4. **Approval Workflow** - Editors can review pending requests and approve/deny them

## Key Features Demonstrated

### 📅 Calendar Integration
- **List Page Calendar View**: Toggle between table and calendar views
- **TimeSlot Property Type**: Start/end time picker with timezone support
- **Detail Page Calendars**: See related bookings on resource detail pages
- **Click to Create**: Click/drag on calendar to pre-fill time slots

### ✅ Approval Workflow
- **Status Tracking**: Requests flow from Pending → Approved/Denied
- **Database Triggers**: Approved requests automatically create reservations
- **Row-Level Security**: Users see only their own requests
- **Conflict Prevention**: Exclusion constraints prevent double-booking

### 🎨 Metadata Polish
- **Custom Dashboard**: "Community Center Overview" shows pending requests and upcoming events
- **Smart Defaults**: Status and requested_by fields auto-filled on create
- **Field Visibility**: System fields hidden from create forms

## Try These Tasks

- **Submit a Request**: Create a reservation request for the Club House
- **Approve a Request** (requires editor role): Change status from "Pending" to "Approved" and watch the reservation appear in the calendar
- **Check for Conflicts**: Try creating overlapping reservations (database will reject them)
- **Explore the Schema**: Visit `/schema-editor` to see the ERD and trigger logic

## Technical Details

- **Database**: PostgreSQL 17 + PostGIS + btree_gist extension
- **Core Domain**: `time_slot` (tstzrange) for appointment scheduling
- **Constraint**: `EXCLUDE USING GIST (resource_id WITH =, time_slot WITH &&)` prevents overlaps
- **Triggers**: Auto-sync between reservation_requests ↔ reservations tables

---

📖 **Documentation**: See `examples/community-center/README.md` for complete setup guide and technical reference.',
  'enableHtml', false
)
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome' LIMIT 1)
  AND widget_type = 'markdown';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
