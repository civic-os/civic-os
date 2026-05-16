-- Neighborhood Engagement Hub - Dashboards
-- Creates role-based dashboards for borrowers, staff, and admins.
-- Uses only registered widget types: markdown, filtered_list, calendar, nav_buttons.
BEGIN;

-- ============================================================================
-- DASHBOARDS
-- ============================================================================

-- Delete existing NEH dashboards to allow idempotent re-runs
DELETE FROM metadata.dashboard_widgets WHERE dashboard_id IN (
  SELECT id FROM metadata.dashboards WHERE display_name IN ('NEH Borrower', 'NEH Staff', 'NEH Admin')
);
DELETE FROM metadata.dashboard_role_defaults WHERE dashboard_id IN (
  SELECT id FROM metadata.dashboards WHERE display_name IN ('NEH Borrower', 'NEH Staff', 'NEH Admin')
);
DELETE FROM metadata.dashboards WHERE display_name IN ('NEH Borrower', 'NEH Staff', 'NEH Admin');

INSERT INTO metadata.dashboards (display_name, description, sort_order)
VALUES
  ('NEH Borrower', 'Dashboard for community members borrowing tools', 10),
  ('NEH Staff', 'Dashboard for staff managing tool lending and building use', 20),
  ('NEH Admin', 'Administrative dashboard with system metrics', 30);

-- ============================================================================
-- WIDGETS
-- ============================================================================

DO $$
DECLARE
  v_borrower_dashboard_id INT;
  v_staff_dashboard_id INT;
  v_admin_dashboard_id INT;
BEGIN
  SELECT id INTO v_borrower_dashboard_id FROM metadata.dashboards WHERE display_name = 'NEH Borrower';
  SELECT id INTO v_staff_dashboard_id FROM metadata.dashboards WHERE display_name = 'NEH Staff';
  SELECT id INTO v_admin_dashboard_id FROM metadata.dashboards WHERE display_name = 'NEH Admin';

  -- ========================================
  -- Borrower Dashboard Widgets
  -- ========================================
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, config, sort_order)
  VALUES
    -- Quick Actions (top of page for easy access)
    (v_borrower_dashboard_id, 'nav_buttons',
     '{"buttons": [{"text": "Request Tool", "url": "/create/tool_reservations", "variant": "primary"}, {"text": "Request Building Use", "url": "/create/building_use_requests", "variant": "primary"}, {"text": "Request Event Kit", "url": "/create/mek_requests", "variant": "primary"}]}', 5),

    -- Welcome markdown
    (v_borrower_dashboard_id, 'markdown',
     '{"content": "# Welcome to Neighborhood Engagement Hub\n\nManage your tool reservations, event kit bookings, and building use requests."}', 10),

    -- My Tool Reservations
    (v_borrower_dashboard_id, 'filtered_list',
     '{"entity": "tool_reservations", "filter": {"borrower_id": "{{current_user.borrower_id}}"}, "title": "My Tool Reservations", "columns": ["display_name", "tools_summary", "timeslot", "status.display_name"]}', 20),

    -- My Building Use Requests
    (v_borrower_dashboard_id, 'filtered_list',
     '{"entity": "building_use_requests", "filter": {"created_by": "{{current_user.id}}"}, "title": "My Building Use Requests", "columns": ["display_name", "group_name", "time_slot", "status.display_name"]}', 30),

    -- My Event Kit Requests
    (v_borrower_dashboard_id, 'filtered_list',
     '{"entity": "mek_requests", "filter": {"created_by": "{{current_user.id}}"}, "title": "My Event Kit Requests", "columns": ["display_name", "event_type", "pickup_date", "return_date", "status.display_name"]}', 35);

  -- ========================================
  -- Staff Dashboard Widgets
  -- ========================================
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, config, sort_order)
  VALUES
    -- Pending Tool Reservations
    (v_staff_dashboard_id, 'filtered_list',
     '{"entity": "tool_reservations", "filter": {"status.status_key": "pending"}, "title": "Pending Tool Reservations", "columns": ["display_name", "borrower.display_name", "tools_summary", "timeslot"]}', 10),

    -- Pending Building Use Requests
    (v_staff_dashboard_id, 'filtered_list',
     '{"entity": "building_use_requests", "filter": {"status.status_key": "pending"}, "title": "Pending Building Use Requests", "columns": ["display_name", "group_name", "contact_name", "time_slot"]}', 15),

    -- Pending Event Kit Requests
    (v_staff_dashboard_id, 'filtered_list',
     '{"entity": "mek_requests", "filter": {"status.status_key": "pending"}, "title": "Pending Event Kit Requests", "columns": ["display_name", "borrower.display_name", "event_type", "pickup_date", "return_date"]}', 17),

    -- Pending Borrower Approvals
    (v_staff_dashboard_id, 'filtered_list',
     '{"entity": "borrowers", "filter": {"status.status_key": "pending"}, "title": "Pending Borrower Approvals", "columns": ["display_name", "email", "phone", "status.display_name"]}', 18),

    -- Upcoming Checkouts (approved reservations)
    (v_staff_dashboard_id, 'filtered_list',
     '{"entity": "tool_reservations", "filter": {"status.status_key": "approved"}, "title": "Approved - Awaiting Checkout", "columns": ["display_name", "borrower.display_name", "tools_summary", "timeslot"]}', 20),

    -- Currently Checked Out
    (v_staff_dashboard_id, 'filtered_list',
     '{"entity": "tool_reservations", "filter": {"status.status_key": "checked_out"}, "title": "Currently Checked Out", "columns": ["display_name", "borrower.display_name", "tools_summary", "timeslot"]}', 30),

    -- Tool Reservation Calendar
    (v_staff_dashboard_id, 'calendar',
     '{"entityKey": "tool_reservations", "timeSlotPropertyName": "timeslot", "initialView": "timeGridWeek", "showCreateButton": true}', 40),

    -- Building Use Calendar
    (v_staff_dashboard_id, 'calendar',
     '{"entityKey": "building_use_requests", "timeSlotPropertyName": "time_slot", "initialView": "timeGridWeek"}', 45),

    -- Quick Actions (top of page for easy access)
    (v_staff_dashboard_id, 'nav_buttons',
     '{"buttons": [{"text": "Approve Requests", "url": "/view/tool_reservations", "variant": "primary"}, {"text": "Create Reservation", "url": "/create/tool_reservations"}, {"text": "Manage Inventory", "url": "/view/tool_instances"}, {"text": "Building Use", "url": "/view/building_use_requests"}, {"text": "Event Kit Requests", "url": "/view/mek_requests"}]}', 5);

  -- ========================================
  -- Admin Dashboard Widgets
  -- ========================================
  INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, config, sort_order)
  VALUES
    -- Pending Tool Reservations (same as staff)
    (v_admin_dashboard_id, 'filtered_list',
     '{"entity": "tool_reservations", "filter": {"status.status_key": "pending"}, "title": "Pending Tool Reservations", "columns": ["display_name", "borrower.display_name", "tools_summary", "timeslot"]}', 10),

    -- Pending Building Use Requests
    (v_admin_dashboard_id, 'filtered_list',
     '{"entity": "building_use_requests", "filter": {"status.status_key": "pending"}, "title": "Pending Building Use Requests", "columns": ["display_name", "group_name", "contact_name", "time_slot"]}', 15),

    -- Pending Event Kit Requests
    (v_admin_dashboard_id, 'filtered_list',
     '{"entity": "mek_requests", "filter": {"status.status_key": "pending"}, "title": "Pending Event Kit Requests", "columns": ["display_name", "borrower.display_name", "event_type", "pickup_date", "return_date"]}', 17),

    -- Currently Checked Out
    (v_admin_dashboard_id, 'filtered_list',
     '{"entity": "tool_reservations", "filter": {"status.status_key": "checked_out"}, "title": "Currently Checked Out", "columns": ["display_name", "borrower.display_name", "tools_summary", "timeslot"]}', 20),

    -- Tool Reservation Calendar
    (v_admin_dashboard_id, 'calendar',
     '{"entityKey": "tool_reservations", "timeSlotPropertyName": "timeslot", "initialView": "timeGridWeek", "showCreateButton": true}', 30),

    -- Building Use Calendar
    (v_admin_dashboard_id, 'calendar',
     '{"entityKey": "building_use_requests", "timeSlotPropertyName": "time_slot", "initialView": "timeGridWeek"}', 35),

    -- System Health
    (v_admin_dashboard_id, 'markdown',
     '{"content": "## System Health\n\nUse the admin pages to manage users, roles, and data imports."}', 40),

    -- Admin Navigation (top of page for easy access)
    (v_admin_dashboard_id, 'nav_buttons',
     '{"buttons": [{"text": "Manage Users", "url": "/admin/users", "variant": "primary"}, {"text": "Permissions", "url": "/permissions"}, {"text": "Manage Inventory", "url": "/view/tool_instances"}, {"text": "Building Use", "url": "/view/building_use_requests"}, {"text": "Event Kit", "url": "/view/mek_requests"}]}', 5);

  -- ========================================
  -- Map roles to dashboards
  -- ========================================
  -- UNIQUE (role_id) constraint means one default dashboard per role
  INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
  SELECT r.id,
    CASE r.role_key
      WHEN 'neh_borrower' THEN v_borrower_dashboard_id
      WHEN 'neh_staff' THEN v_staff_dashboard_id
      WHEN 'neh_admin' THEN v_admin_dashboard_id
    END,
    CASE r.role_key
      WHEN 'neh_admin' THEN 100
      WHEN 'neh_staff' THEN 90
      WHEN 'neh_borrower' THEN 80
    END
  FROM metadata.roles r
  WHERE r.role_key IN ('neh_admin', 'neh_staff', 'neh_borrower')
  ON CONFLICT (role_id) DO UPDATE
    SET dashboard_id = EXCLUDED.dashboard_id,
        priority = EXCLUDED.priority;
END $$;

COMMIT;
