-- =============================================================================
-- FFSC Updates: Bookkeeper, Incident Status, Task Priority, Staff Directory
-- =============================================================================
-- Requires: Civic OS v0.37.0 (dashboard_role_defaults), scripts 01-13 applied
--
-- Changes:
--   3A. Bookkeeper permissions + role delegation (completing script 13 TODOs)
--   3B. Bookkeeper RLS on reimbursements + time_entries
--   3C. Reimbursement notifications rerouted to bookkeeper
--   3D. Incident report improvements: default reporter, status workflow, dashboard
--   3E. Staff task priority (Category system)
--   3F. Staff task flexible assignment (site, role, or individual)
--   3G. Staff directory view
--   3H. Pilot story on Welcome dashboard
--   3I. Dashboard role defaults configuration
-- =============================================================================

BEGIN;

-- =============================================================================
-- 3A. BOOKKEEPER PERMISSIONS + ROLE DELEGATION
-- =============================================================================
-- Complete the TODOs from script 13. Bookkeeper gets read-only access to
-- financial and staff data, plus update on reimbursements for response notes.

-- Direct SQL inserts (init scripts run as superuser without JWT context,
-- so set_role_permission() which requires is_admin() cannot be used here)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reimbursements'
  AND p.permission IN ('read', 'update')
  AND r.role_key = 'bookkeeper'
ON CONFLICT DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('time_entries', 'staff_members', 'sites')
  AND p.permission = 'read'
  AND r.role_key = 'bookkeeper'
ON CONFLICT DO NOTHING;

-- Role delegation: admin and manager can assign/revoke bookkeeper
INSERT INTO metadata.role_can_manage (manager_role_id, managed_role_id)
VALUES
  (get_role_id('admin'), get_role_id('bookkeeper')),
  (get_role_id('manager'), get_role_id('bookkeeper'))
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 3B. BOOKKEEPER RLS — SEE ALL REIMBURSEMENTS AND TIME ENTRIES
-- =============================================================================
-- Add bookkeeper to the SELECT policies so they can view all records.
-- Uses role_key (immutable) in get_user_roles() checks.

DROP POLICY select_reimbursements ON reimbursements;
CREATE POLICY select_reimbursements ON reimbursements
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles())
    OR 'bookkeeper' = ANY(get_user_roles())
    OR is_admin()
  );

DROP POLICY select_time_entries ON time_entries;
CREATE POLICY select_time_entries ON time_entries
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles())
    OR 'bookkeeper' = ANY(get_user_roles())
    OR is_admin()
  );

-- =============================================================================
-- 3C. REIMBURSEMENT NOTIFICATIONS — ROUTE TO BOOKKEEPER
-- =============================================================================
-- Override notify_reimbursement_submitted() to send to bookkeepers instead of managers.
-- Override notify_reimbursement_status_change() to also notify bookkeepers.

CREATE OR REPLACE FUNCTION notify_reimbursement_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff_name TEXT;
  v_entity_data JSONB;
  v_recipient RECORD;
BEGIN
  -- Look up staff member name
  SELECT sm.display_name INTO v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.staff_member_id;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'ReimbursementId', NEW.id,
    'StaffName', v_staff_name,
    'Amount', NEW.amount::TEXT,
    'Description', NEW.description,
    'HasReceipt', (NEW.receipt IS NOT NULL)
  );

  -- Send to all bookkeepers (changed from managers)
  FOR v_recipient IN
    SELECT DISTINCT user_id FROM get_users_with_role('bookkeeper')
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data, channels
    ) VALUES (
      v_recipient.user_id,
      'reimbursement_submitted',
      'reimbursements',
      NEW.id,
      v_entity_data,
      ARRAY['email', 'sms']
    );
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_reimbursement_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_approved_id INT;
  v_denied_id INT;
  v_staff_user_id UUID;
  v_staff_name TEXT;
  v_entity_data JSONB;
  v_template TEXT;
  v_recipient RECORD;
BEGIN
  -- Get status IDs
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Denied';

  -- Only fire on actual status change
  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  -- Determine template
  IF NEW.status_id = v_approved_id THEN
    v_template := 'reimbursement_approved';
  ELSIF NEW.status_id = v_denied_id THEN
    v_template := 'reimbursement_denied';
  ELSE
    RETURN NEW;
  END IF;

  -- Look up staff member
  SELECT sm.user_id, sm.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.staff_member_id;

  -- Build entity data
  v_entity_data := jsonb_build_object(
    'ReimbursementId', NEW.id,
    'StaffName', v_staff_name,
    'Amount', NEW.amount::TEXT,
    'Description', NEW.description,
    'ResponseNotes', NEW.response_notes
  );

  -- Notify the staff member
  IF v_staff_user_id IS NOT NULL THEN
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data, channels
    ) VALUES (
      v_staff_user_id,
      v_template,
      'reimbursements',
      NEW.id,
      v_entity_data,
      ARRAY['email', 'sms']
    );
  END IF;

  -- Also notify bookkeepers of the status change
  FOR v_recipient IN
    SELECT DISTINCT user_id FROM get_users_with_role('bookkeeper')
    WHERE user_id != current_user_id()  -- Don't notify the person making the change
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data, channels
    ) VALUES (
      v_recipient.user_id,
      v_template,
      'reimbursements',
      NEW.id,
      v_entity_data,
      ARRAY['email', 'sms']
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 3D. INCIDENT REPORT IMPROVEMENTS
-- =============================================================================

-- 3D.1: Default reported_by_id to current staff member
ALTER TABLE incident_reports ALTER COLUMN reported_by_id SET DEFAULT get_current_staff_member_id();

-- 3D.2: Hide reported_by_id on create form (auto-filled by default)
UPDATE metadata.properties SET show_on_create = FALSE
WHERE table_name = 'incident_reports' AND column_name = 'reported_by_id';

-- 3D.3: Add Status workflow (New → Reviewed → Closed)
INSERT INTO metadata.status_types (entity_type, display_name, description) VALUES
  ('incident_report', 'Incident Report', 'Incident report review lifecycle')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal, status_key) VALUES
  ('incident_report', 'New',      'Newly filed incident report',      '#3B82F6', 1, TRUE,  FALSE, 'new'),
  ('incident_report', 'Reviewed', 'Report has been reviewed by lead', '#F59E0B', 2, FALSE, FALSE, 'reviewed'),
  ('incident_report', 'Closed',   'Report resolved and closed',       '#22C55E', 3, FALSE, TRUE,  'closed')
ON CONFLICT DO NOTHING;

-- Add status_id column
ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS status_id INT
  REFERENCES metadata.statuses(id)
  DEFAULT get_initial_status('incident_report');

-- Backfill existing records to 'New'
UPDATE incident_reports SET status_id = get_initial_status('incident_report')
WHERE status_id IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE incident_reports ALTER COLUMN status_id SET NOT NULL;

-- FK index
CREATE INDEX IF NOT EXISTS idx_incident_reports_status_id ON incident_reports(status_id);

-- Register status_id in metadata
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order,
  show_on_list, show_on_create, show_on_edit, show_on_detail, filterable, sortable)
VALUES ('incident_reports', 'status_id', 'Status', 5, TRUE, FALSE, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  filterable = EXCLUDED.filterable,
  sortable = EXCLUDED.sortable;

-- Allowed transitions: New → Reviewed, Reviewed → Closed
INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, display_name, description)
VALUES
  ('incident_report', get_status_id('incident_report', 'new'), get_status_id('incident_report', 'reviewed'),
   'Mark Reviewed', 'Indicate the report has been reviewed by a site lead or manager'),
  ('incident_report', get_status_id('incident_report', 'reviewed'), get_status_id('incident_report', 'closed'),
   'Close', 'Close the incident report after resolution')
ON CONFLICT DO NOTHING;

-- 3D.4: Dashboard widget — recent incidents on Admin Overview
DO $$
DECLARE
  v_admin_dashboard_id INT;
  v_new_status_id INT;
BEGIN
  SELECT id INTO v_admin_dashboard_id FROM metadata.dashboards WHERE display_name = 'Admin Overview';
  SELECT id INTO v_new_status_id FROM metadata.statuses
    WHERE entity_type = 'incident_report' AND status_key = 'new';

  IF v_admin_dashboard_id IS NOT NULL THEN
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_admin_dashboard_id,
      'filtered_list',
      'incident_reports',
      'Recent Incident Reports',
      jsonb_build_object(
        'filters', CASE WHEN v_new_status_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_new_status_id)
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'site_id', 'incident_date', 'status_id')
      ),
      6, 2, 1  -- full-width, after existing widgets
    );
  END IF;
END $$;

-- =============================================================================
-- 3E. STAFF TASK PRIORITY (Category System)
-- =============================================================================
-- Adds color-coded priority using the Category system (rich enums).

INSERT INTO metadata.category_groups (entity_type, display_name, description) VALUES
  ('task_priority', 'Task Priority', 'Priority levels for task assignments')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.categories (entity_type, display_name, color, sort_order, category_key) VALUES
  ('task_priority', 'High',   '#EF4444', 1, 'high'),
  ('task_priority', 'Medium', '#F59E0B', 2, 'medium'),
  ('task_priority', 'Low',    '#6B7280', 3, 'low')
ON CONFLICT DO NOTHING;

-- Add priority column
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS priority_id INT
  REFERENCES metadata.categories(id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_priority_id ON staff_tasks(priority_id);

-- Register in metadata (category_entity_type enables auto-dropdown + color badges)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width,
  show_on_list, show_on_create, show_on_edit, show_on_detail, filterable, category_entity_type)
VALUES ('staff_tasks', 'priority_id', 'Priority', 15, 1, TRUE, TRUE, TRUE, TRUE, TRUE, 'task_priority')
ON CONFLICT (table_name, column_name) DO UPDATE SET
  category_entity_type = EXCLUDED.category_entity_type,
  filterable = EXCLUDED.filterable,
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order;

-- =============================================================================
-- 3F. STAFF TASK FLEXIBLE ASSIGNMENT (site, role, or individual)
-- =============================================================================
-- Make assigned_to_id nullable and add site/role assignment options.
-- A CHECK constraint ensures exactly one assignment target is set.

ALTER TABLE staff_tasks ALTER COLUMN assigned_to_id DROP NOT NULL;

ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS assigned_to_site_id BIGINT
  REFERENCES sites(id);
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS assigned_to_role_id INT
  REFERENCES metadata.categories(id);

CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_to_site_id ON staff_tasks(assigned_to_site_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_to_role_id ON staff_tasks(assigned_to_role_id);

-- Exactly one assignment target must be set
-- (existing rows have assigned_to_id NOT NULL, so they pass)
ALTER TABLE staff_tasks ADD CONSTRAINT chk_exactly_one_assignment CHECK (
  (assigned_to_id IS NOT NULL)::int +
  (assigned_to_site_id IS NOT NULL)::int +
  (assigned_to_role_id IS NOT NULL)::int = 1
);

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'chk_exactly_one_assignment',
  'staff_tasks',
  NULL,
  'A task must be assigned to exactly one of: a staff member, a site, or a role.'
)
ON CONFLICT (constraint_name) DO UPDATE SET
    error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

-- Update SELECT RLS to resolve polymorphic assignment
DROP POLICY select_staff_tasks ON staff_tasks;
CREATE POLICY select_staff_tasks ON staff_tasks
  FOR SELECT TO authenticated
  USING (
    -- Direct assignment
    assigned_to_id = get_current_staff_member_id()
    -- Site assignment: user is at that site
    OR assigned_to_site_id = get_current_staff_member_site_id()
    -- Role assignment: user has that staff role (category)
    OR assigned_to_role_id = (SELECT role_id FROM staff_members WHERE id = get_current_staff_member_id())
    -- Creator can see their tasks
    OR assigned_by = current_user_id()
    -- Site leads, managers, admins see all
    OR is_lead_of_site(site_id)
    OR is_lead_of_site(get_site_id_for_staff(assigned_to_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

-- Update UPDATE RLS to match
DROP POLICY update_staff_tasks ON staff_tasks;
CREATE POLICY update_staff_tasks ON staff_tasks
  FOR UPDATE TO authenticated
  USING (
    assigned_to_id = get_current_staff_member_id()
    OR assigned_to_site_id = get_current_staff_member_site_id()
    OR assigned_to_role_id = (SELECT role_id FROM staff_members WHERE id = get_current_staff_member_id())
    OR is_lead_of_site(site_id)
    OR is_lead_of_site(get_site_id_for_staff(assigned_to_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

-- Register new columns in metadata
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width,
  show_on_list, show_on_create, show_on_edit, show_on_detail, filterable)
VALUES
  ('staff_tasks', 'assigned_to_site_id', 'Assigned to Site', 22, 1, TRUE, TRUE, TRUE, TRUE, TRUE),
  ('staff_tasks', 'assigned_to_role_id', 'Assigned to Role', 23, 1, TRUE, TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- Update start_staff_task() to also allow staff assigned via site or role
CREATE OR REPLACE FUNCTION public.start_staff_task(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_task RECORD;
  v_current_staff_id BIGINT;
  v_current_site_id BIGINT;
  v_current_role_id INT;
  v_is_assigned BOOLEAN := FALSE;
BEGIN
  IF NOT has_permission('staff_tasks', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'In Progress';

  SELECT * INTO v_task FROM staff_tasks WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task not found');
  END IF;

  -- Check if current user is assigned (direct, site, or role)
  v_current_staff_id := get_current_staff_member_id();

  IF v_task.assigned_to_id IS NOT NULL AND v_task.assigned_to_id = v_current_staff_id THEN
    v_is_assigned := TRUE;
  END IF;

  IF v_task.assigned_to_site_id IS NOT NULL THEN
    v_current_site_id := get_current_staff_member_site_id();
    IF v_task.assigned_to_site_id = v_current_site_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  IF v_task.assigned_to_role_id IS NOT NULL THEN
    SELECT role_id INTO v_current_role_id FROM staff_members WHERE id = v_current_staff_id;
    IF v_task.assigned_to_role_id = v_current_role_id THEN
      v_is_assigned := TRUE;
    END IF;
  END IF;

  IF NOT v_is_assigned THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only assigned staff can start this task');
  END IF;

  IF v_task.status_id != v_open_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open tasks can be started');
  END IF;

  UPDATE staff_tasks SET status_id = v_in_progress_id WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task started.', 'refresh', true);
END;
$$;

-- Update notify_task_assigned() to handle site/role assignment
CREATE OR REPLACE FUNCTION notify_task_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff_user_id UUID;
  v_staff_name TEXT;
  v_site_name TEXT;
  v_entity_data JSONB;
  v_recipient RECORD;
BEGIN
  -- Look up site name if set
  IF NEW.site_id IS NOT NULL THEN
    SELECT s.display_name INTO v_site_name FROM sites s WHERE s.id = NEW.site_id;
  END IF;

  -- Direct assignment: notify the individual
  IF NEW.assigned_to_id IS NOT NULL THEN
    SELECT sm.user_id, sm.display_name
      INTO v_staff_user_id, v_staff_name
      FROM staff_members sm
      WHERE sm.id = NEW.assigned_to_id;

    IF v_staff_user_id IS NOT NULL THEN
      v_entity_data := jsonb_build_object(
        'TaskId', NEW.id,
        'TaskTitle', NEW.display_name,
        'Description', NEW.description,
        'DueDate', NEW.due_date,
        'SiteName', v_site_name,
        'StaffName', v_staff_name
      );

      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data, channels
      ) VALUES (
        v_staff_user_id,
        'task_assigned',
        'staff_tasks',
        NEW.id,
        v_entity_data,
        ARRAY['email', 'sms']
      );
    END IF;

  -- Site assignment: notify all staff at that site
  ELSIF NEW.assigned_to_site_id IS NOT NULL THEN
    FOR v_recipient IN
      SELECT sm.user_id, sm.display_name
      FROM staff_members sm
      WHERE sm.site_id = NEW.assigned_to_site_id
        AND sm.user_id IS NOT NULL
    LOOP
      v_entity_data := jsonb_build_object(
        'TaskId', NEW.id,
        'TaskTitle', NEW.display_name,
        'Description', NEW.description,
        'DueDate', NEW.due_date,
        'SiteName', v_site_name,
        'StaffName', v_recipient.display_name
      );

      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data, channels
      ) VALUES (
        v_recipient.user_id,
        'task_assigned',
        'staff_tasks',
        NEW.id,
        v_entity_data,
        ARRAY['email', 'sms']
      );
    END LOOP;

  -- Role assignment: notify all staff with that role (category)
  ELSIF NEW.assigned_to_role_id IS NOT NULL THEN
    FOR v_recipient IN
      SELECT sm.user_id, sm.display_name
      FROM staff_members sm
      WHERE sm.role_id = NEW.assigned_to_role_id
        AND sm.user_id IS NOT NULL
    LOOP
      v_entity_data := jsonb_build_object(
        'TaskId', NEW.id,
        'TaskTitle', NEW.display_name,
        'Description', NEW.description,
        'DueDate', NEW.due_date,
        'SiteName', v_site_name,
        'StaffName', v_recipient.display_name
      );

      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data, channels
      ) VALUES (
        v_recipient.user_id,
        'task_assigned',
        'staff_tasks',
        NEW.id,
        v_entity_data,
        ARRAY['email', 'sms']
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 3G. STAFF DIRECTORY VIEW (read-only)
-- =============================================================================

CREATE OR REPLACE VIEW staff_directory AS
SELECT
  sm.id,
  sm.display_name,
  sm.email,
  c.display_name AS staff_role,
  s.display_name AS site_name
FROM staff_members sm
LEFT JOIN metadata.categories c ON c.id = sm.role_id
LEFT JOIN sites s ON s.id = sm.site_id;

GRANT SELECT ON staff_directory TO authenticated;

-- Register as entity (read-only — no create/edit/delete)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('staff_directory', 'Staff Directory', 'Contact information for all staff members', 15)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- Property metadata
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order,
  show_on_list, show_on_detail, filterable, sortable)
VALUES
  ('staff_directory', 'display_name',  'Name',       1, TRUE, TRUE, FALSE, TRUE),
  ('staff_directory', 'email',         'Email',      2, TRUE, TRUE, FALSE, TRUE),
  ('staff_directory', 'staff_role',    'Staff Role', 3, TRUE, TRUE, TRUE,  TRUE),
  ('staff_directory', 'site_name',     'Site',       4, TRUE, TRUE, TRUE,  TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order;

-- Permissions: all authenticated users can read
-- Ensure the permission exists, then grant to all roles
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('staff_directory', 'read')
ON CONFLICT (table_name, permission) DO NOTHING;

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_directory'
  AND p.permission = 'read'
  AND r.role_key IN ('user', 'editor', 'manager', 'admin', 'bookkeeper')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 3H. PILOT STORY ON WELCOME DASHBOARD
-- =============================================================================
-- Update the Welcome dashboard markdown widget with FFSC pilot story placeholder.

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
  'content', E'# Welcome to the FFSC Staff Portal\n\nThe Flint Freedom Schools Collaborative (FFSC) connects young people with culturally relevant education through a network of Freedom Schools sites across Flint, Michigan.\n\nThis portal helps our team manage day-to-day operations during the summer program. It is a pilot project built in partnership with **Civic OS, L3C**, a Flint-based social enterprise that builds open-source tools for community organizations.\n\n## What You Can Do Here\n\n- **Track Onboarding** — complete required documents and clearances\n- **Log Time** — clock in/out and submit time-off requests\n- **Submit Reimbursements** — file expense requests with receipt uploads\n- **View Tasks** — see assignments by role, site, or individual\n- **Report Incidents** — document and track incident reports\n- **Staff Directory** — find contact info for any team member\n\n## Getting Started\n\nSign in to access the **Staff Portal** dashboard, where you can view your tasks, track your onboarding progress, and manage your time entries.\n\n---\n\n*Powered by [Civic OS](https://civic-os.org) — open-source software for community organizations*',
  'enableHtml', false
)
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome' LIMIT 1)
  AND widget_type = 'markdown';

-- =============================================================================
-- 3I. DASHBOARD ROLE DEFAULTS CONFIGURATION
-- =============================================================================
-- Admin/Manager → Admin Overview, Bookkeeper → Staff Portal

INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
SELECT r.id, d.id, CASE r.role_key WHEN 'admin' THEN 100 WHEN 'manager' THEN 90 END
FROM metadata.roles r, metadata.dashboards d
WHERE r.role_key IN ('admin', 'manager') AND d.display_name = 'Admin Overview'
ON CONFLICT (role_id) DO UPDATE SET
  dashboard_id = EXCLUDED.dashboard_id,
  priority = EXCLUDED.priority;

INSERT INTO metadata.dashboard_role_defaults (role_id, dashboard_id, priority)
SELECT r.id, d.id, 50
FROM metadata.roles r, metadata.dashboards d
WHERE r.role_key = 'bookkeeper' AND d.display_name = 'Staff Portal'
ON CONFLICT (role_id) DO UPDATE SET
  dashboard_id = EXCLUDED.dashboard_id,
  priority = EXCLUDED.priority;

-- =============================================================================
-- 3J. FFSC BANNER ON ALL DASHBOARDS
-- =============================================================================
-- Add ffsc-banner image widget at the top of every dashboard and hide titles.
-- The static asset with slug 'ffsc-banner' must be uploaded via the admin UI
-- before this widget will render.

-- Bump existing widgets down to make room for banner at sort_order = 1
UPDATE metadata.dashboard_widgets
SET sort_order = sort_order + 1
WHERE dashboard_id IN (
  SELECT id FROM metadata.dashboards
  WHERE display_name IN ('Welcome', 'Staff Portal', 'Admin Overview')
);

-- Insert banner widget at sort_order 1 on each dashboard
INSERT INTO metadata.dashboard_widgets (dashboard_id, widget_type, title, config, sort_order, width, height)
SELECT d.id, 'image', NULL,
  jsonb_build_object('static_asset', 'ffsc-banner', 'altText', 'Flint Freedom Schools Collaborative'),
  1, 2, 2
FROM metadata.dashboards d
WHERE d.display_name IN ('Welcome', 'Staff Portal', 'Admin Overview');

-- Hide titles on all dashboards for a cleaner look
UPDATE metadata.dashboards
SET show_title = FALSE
WHERE display_name IN ('Welcome', 'Staff Portal', 'Admin Overview');

-- =============================================================================
-- NOTIFY POSTGREST
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
