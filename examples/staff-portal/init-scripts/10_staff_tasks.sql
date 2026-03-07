-- ============================================================================
-- STAFF TASKS
-- ============================================================================
-- A lightweight task assignment system for staff management.
-- Demonstrates: Status types, entity actions with params, three-tier RLS,
--   notification on assignment, full-text search.
-- Requires: 01_staff_portal_schema.sql (staff_members, sites, helper functions)
-- ============================================================================

-- ============================================================================
-- STATUS TYPE SYSTEM
-- ============================================================================

INSERT INTO metadata.status_types (entity_type, description) VALUES
  ('staff_task', 'Task assignment lifecycle')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal, status_key) VALUES
  ('staff_task', 'Open',        'Task created, not yet started',  '#6B7280', 1, TRUE,  FALSE, 'open'),
  ('staff_task', 'In Progress', 'Assignee is working on task',    '#F59E0B', 2, FALSE, FALSE, 'in_progress'),
  ('staff_task', 'Completed',   'Task finished',                  '#22C55E', 3, FALSE, TRUE,  'completed'),
  ('staff_task', 'Cancelled',   'Task cancelled',                 '#EF4444', 4, FALSE, TRUE,  'cancelled')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- TABLE
-- ============================================================================

CREATE TABLE staff_tasks (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  assigned_to_id BIGINT NOT NULL REFERENCES staff_members(id),
  assigned_by UUID DEFAULT current_user_id() REFERENCES metadata.civic_os_users(id),
  site_id BIGINT DEFAULT get_current_staff_member_site_id() REFERENCES sites(id),
  due_date DATE,
  status_id INT NOT NULL DEFAULT get_initial_status('staff_task') REFERENCES metadata.statuses(id),
  completion_notes TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- FK INDEXES
-- ============================================================================

CREATE INDEX idx_staff_tasks_assigned_to_id ON staff_tasks(assigned_to_id);
CREATE INDEX idx_staff_tasks_assigned_by ON staff_tasks(assigned_by);
CREATE INDEX idx_staff_tasks_site_id ON staff_tasks(site_id);
CREATE INDEX idx_staff_tasks_status_id ON staff_tasks(status_id);

-- ============================================================================
-- TIMESTAMP TRIGGERS
-- ============================================================================

CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON staff_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON staff_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (three-tier)
-- ============================================================================

ALTER TABLE staff_tasks ENABLE ROW LEVEL SECURITY;

-- SELECT: own tasks, site lead sees site tasks, manager/admin sees all
CREATE POLICY select_staff_tasks ON staff_tasks
  FOR SELECT TO authenticated
  USING (
    assigned_to_id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR is_lead_of_site(get_site_id_for_staff(assigned_to_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_staff_tasks ON staff_tasks
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_staff_tasks ON staff_tasks
  FOR UPDATE TO authenticated
  USING (
    assigned_to_id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR is_lead_of_site(get_site_id_for_staff(assigned_to_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_staff_tasks ON staff_tasks
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ============================================================================
-- POSTGRESQL PERMISSIONS
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_tasks TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE staff_tasks_id_seq TO authenticated;

-- ============================================================================
-- FULL-TEXT SEARCH
-- ============================================================================

ALTER TABLE staff_tasks ADD COLUMN civic_os_text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', display_name || ' ' || COALESCE(description, ''))
  ) STORED;
CREATE INDEX idx_staff_tasks_search ON staff_tasks USING GIN(civic_os_text_search);

-- ============================================================================
-- METADATA CONFIGURATION
-- ============================================================================

-- Entity metadata
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, search_fields)
VALUES ('staff_tasks', 'Staff Tasks', 'Task assignments for staff members', 11, ARRAY['display_name', 'description'])
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  search_fields = EXCLUDED.search_fields;

-- Property metadata: hide auto-set fields from create/edit, configure visibility
INSERT INTO metadata.properties (table_name, column_name, display_name, show_on_create, show_on_edit, show_on_list, show_on_detail, sortable, filterable, sort_order)
VALUES
  ('staff_tasks', 'assigned_by',      'Assigned By',      FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, 50),
  ('staff_tasks', 'status_id',        'Status',           FALSE, FALSE, TRUE,  TRUE,  TRUE,  TRUE,  60),
  ('staff_tasks', 'completion_notes',  'Completion Notes', FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, 70),
  ('staff_tasks', 'completed_at',      'Completed At',     FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, 80),
  ('staff_tasks', 'assigned_to_id',    'Assigned To',      TRUE,  TRUE,  TRUE,  TRUE,  FALSE, TRUE,  20),
  ('staff_tasks', 'site_id',           'Site',             TRUE,  TRUE,  TRUE,  TRUE,  FALSE, TRUE,  30),
  ('staff_tasks', 'due_date',          'Due Date',         TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  FALSE, 40),
  ('staff_tasks', 'display_name',      'Task',             TRUE,  TRUE,  TRUE,  TRUE,  TRUE,  FALSE, 10),
  ('staff_tasks', 'description',       'Description',      TRUE,  TRUE,  FALSE, TRUE,  FALSE, FALSE, 15)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_list = EXCLUDED.show_on_list,
  show_on_detail = EXCLUDED.show_on_detail,
  sortable = EXCLUDED.sortable,
  filterable = EXCLUDED.filterable,
  sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- VALIDATIONS
-- ============================================================================

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('staff_tasks', 'display_name', 'required', 'true', 'Task title is required', 1),
  ('staff_tasks', 'display_name', 'minLength', '2', 'Task title must be at least 2 characters', 2)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE SET
  validation_value = EXCLUDED.validation_value,
  error_message = EXCLUDED.error_message;

-- ============================================================================
-- RBAC PERMISSIONS
-- ============================================================================

-- Step 1: Register CRUD permissions for staff_tasks
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('staff_tasks', 'read'),
  ('staff_tasks', 'create'),
  ('staff_tasks', 'update'),
  ('staff_tasks', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- Step 2: Map permissions to roles
-- user: read only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_tasks'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- editor: create, update
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_tasks'
  AND p.permission IN ('create', 'update')
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- manager/admin: delete
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'staff_tasks'
  AND p.permission = 'delete'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- RPC FUNCTIONS FOR ENTITY ACTIONS
-- ============================================================================

-- START TASK: Open → In Progress (only assignee can start)
CREATE OR REPLACE FUNCTION public.start_staff_task(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_task RECORD;
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

  -- Only the assignee can start a task
  IF v_task.assigned_to_id <> get_current_staff_member_id() THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the assigned staff member can start this task');
  END IF;

  IF v_task.status_id != v_open_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open tasks can be started');
  END IF;

  UPDATE staff_tasks SET status_id = v_in_progress_id WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task started.', 'refresh', true);
END;
$$;

-- COMPLETE TASK: Open/In Progress → Completed
CREATE OR REPLACE FUNCTION public.complete_staff_task(
  p_entity_id BIGINT,
  p_completion_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_completed_id INT;
  v_task RECORD;
BEGIN
  IF NOT has_permission('staff_tasks', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'In Progress';
  SELECT id INTO v_completed_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Completed';

  SELECT * INTO v_task FROM staff_tasks WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task not found');
  END IF;

  IF v_task.status_id NOT IN (v_open_id, v_in_progress_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open or in-progress tasks can be completed');
  END IF;

  UPDATE staff_tasks SET
    status_id = v_completed_id,
    completion_notes = COALESCE(p_completion_notes, completion_notes),
    completed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task completed.', 'refresh', true);
END;
$$;

-- CANCEL TASK: Open/In Progress → Cancelled
CREATE OR REPLACE FUNCTION public.cancel_staff_task(
  p_entity_id BIGINT,
  p_cancel_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_cancelled_id INT;
  v_task RECORD;
BEGIN
  IF NOT has_permission('staff_tasks', 'update') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Permission denied');
  END IF;

  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'In Progress';
  SELECT id INTO v_cancelled_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Cancelled';

  SELECT * INTO v_task FROM staff_tasks WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task not found');
  END IF;

  IF v_task.status_id NOT IN (v_open_id, v_in_progress_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only open or in-progress tasks can be cancelled');
  END IF;

  UPDATE staff_tasks SET
    status_id = v_cancelled_id,
    completion_notes = COALESCE(p_cancel_reason, completion_notes)
  WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', true, 'message', 'Task cancelled.', 'refresh', true);
END;
$$;

-- ============================================================================
-- GRANT EXECUTE PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.start_staff_task(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_staff_task(BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_staff_task(BIGINT, TEXT) TO authenticated;

-- ============================================================================
-- ENTITY ACTIONS CONFIGURATION
-- ============================================================================

DO $$
DECLARE
  v_open_id INT;
  v_in_progress_id INT;
  v_completed_id INT;
  v_cancelled_id INT;
BEGIN
  SELECT id INTO v_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Open';
  SELECT id INTO v_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'In Progress';
  SELECT id INTO v_completed_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Completed';
  SELECT id INTO v_cancelled_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Cancelled';

  -- START action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_tasks', 'start', 'Start', 'Begin working on this task',
    'start_staff_task', 'play_arrow', 'primary', 10, FALSE,
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_open_id),
    jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', v_open_id),
    'Only open tasks can be started',
    'Task started.', TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- COMPLETE action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_tasks', 'complete', 'Mark Complete', 'Mark this task as completed',
    'complete_staff_task', 'check_circle', 'primary', 20, TRUE,
    'Mark this task as complete?',
    jsonb_build_object('field', 'status_id', 'operator', 'in', 'value', jsonb_build_array(v_open_id, v_in_progress_id)),
    jsonb_build_object('field', 'status_id', 'operator', 'in', 'value', jsonb_build_array(v_open_id, v_in_progress_id)),
    'Only open or in-progress tasks can be completed',
    'Task completed.', TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

  -- CANCEL action
  INSERT INTO metadata.entity_actions (
    table_name, action_name, display_name, description, rpc_function,
    icon, button_style, sort_order, requires_confirmation, confirmation_message,
    visibility_condition, enabled_condition, disabled_tooltip,
    default_success_message, refresh_after_action
  ) VALUES (
    'staff_tasks', 'cancel', 'Cancel', 'Cancel this task',
    'cancel_staff_task', 'cancel', 'error', 30, TRUE,
    'Are you sure you want to cancel this task?',
    jsonb_build_object('field', 'status_id', 'operator', 'in', 'value', jsonb_build_array(v_open_id, v_in_progress_id)),
    jsonb_build_object('field', 'status_id', 'operator', 'in', 'value', jsonb_build_array(v_open_id, v_in_progress_id)),
    'Only open or in-progress tasks can be cancelled',
    'Task cancelled.', TRUE
  ) ON CONFLICT (table_name, action_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    visibility_condition = EXCLUDED.visibility_condition,
    enabled_condition = EXCLUDED.enabled_condition;

END $$;

-- ============================================================================
-- ENTITY ACTION ROLE PERMISSIONS
-- ============================================================================

-- Start: user, editor, manager, admin (RPC enforces assignee-only)
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'staff_tasks'
  AND ea.action_name = 'start'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Complete: user, editor, manager, admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'staff_tasks'
  AND ea.action_name = 'complete'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Cancel: editor, manager, admin
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'staff_tasks'
  AND ea.action_name = 'cancel'
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- ENTITY ACTION PARAMETERS (v0.32.0)
-- ============================================================================

-- Complete: optional completion notes
INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name, param_type,
  required, sort_order, placeholder
)
SELECT ea.id, 'p_completion_notes', 'Completion Notes', 'text',
       FALSE, 10, 'Optional: describe what was done'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'staff_tasks' AND ea.action_name = 'complete'
ON CONFLICT (entity_action_id, param_name) DO NOTHING;

-- Cancel: optional cancel reason
INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name, param_type,
  required, sort_order, placeholder
)
SELECT ea.id, 'p_cancel_reason', 'Reason for Cancellation', 'text',
       FALSE, 10, 'Optional: explain why this task is being cancelled'
FROM metadata.entity_actions ea
WHERE ea.table_name = 'staff_tasks' AND ea.action_name = 'cancel'
ON CONFLICT (entity_action_id, param_name) DO NOTHING;

-- ============================================================================
-- NOTIFICATION: Task Assigned
-- ============================================================================

INSERT INTO metadata.notification_templates (
  name, description, subject_template, html_template, text_template, sms_template
) VALUES (
  'task_assigned',
  'Sent to staff member when a task is assigned to them',

  'New task assigned: {{.Entity.TaskTitle}}',

  '<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #3B82F6; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
    .info-box { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #3B82F6; }
    .label { font-weight: bold; color: #1f2937; }
    .button { display: inline-block; background: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
    .footer { margin-top: 20px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 0.9em; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">New Task Assigned</h1>
    </div>
    <div class="content">
      <p>Hi {{.Entity.StaffName}},</p>
      <p>You have been assigned a new task.</p>
      <div class="info-box">
        <p><span class="label">Task:</span> {{.Entity.TaskTitle}}</p>
        {{if .Entity.Description}}<p><span class="label">Description:</span> {{.Entity.Description}}</p>{{end}}
        {{if .Entity.DueDate}}<p><span class="label">Due Date:</span> {{.Entity.DueDate}}</p>{{end}}
        {{if .Entity.SiteName}}<p><span class="label">Site:</span> {{.Entity.SiteName}}</p>{{end}}
      </div>
      <a href="{{.Metadata.site_url}}/view/staff_tasks/{{.Entity.TaskId}}" class="button">View Task</a>
      <div class="footer">
        <p>Click "Start" on the task when you begin working on it.</p>
      </div>
    </div>
  </div>
</body>
</html>',

  'NEW TASK ASSIGNED
=================================

Hi {{.Entity.StaffName}},

You have been assigned a new task.

Task: {{.Entity.TaskTitle}}
{{if .Entity.Description}}Description: {{.Entity.Description}}{{end}}
{{if .Entity.DueDate}}Due Date: {{.Entity.DueDate}}{{end}}
{{if .Entity.SiteName}}Site: {{.Entity.SiteName}}{{end}}

View Task: {{.Metadata.site_url}}/view/staff_tasks/{{.Entity.TaskId}}
',

  'FFSC: New task: "{{.Entity.TaskTitle}}"{{if .Entity.DueDate}} Due: {{.Entity.DueDate}}{{end}} {{.Metadata.site_url}}/view/staff_tasks/{{.Entity.TaskId}}'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template,
  sms_template = EXCLUDED.sms_template;

-- Trigger function: notify assignee on task creation
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
BEGIN
  -- Look up assigned staff member
  SELECT sm.user_id, sm.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    WHERE sm.id = NEW.assigned_to_id;

  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Look up site name if set
  IF NEW.site_id IS NOT NULL THEN
    SELECT s.display_name INTO v_site_name FROM sites s WHERE s.id = NEW.site_id;
  END IF;

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

  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION notify_task_assigned TO authenticated;

CREATE TRIGGER trg_notify_task_assigned
  AFTER INSERT ON staff_tasks
  FOR EACH ROW
  EXECUTE FUNCTION notify_task_assigned();

-- ============================================================================
-- CAUSAL BINDINGS (v0.33.0)
-- ============================================================================
-- Status transitions declare the staff_task state machine so the system
-- introspection views can visualize the workflow.
--
-- Task lifecycle:
--   Open ──→ In Progress (via start_staff_task RPC, assignee only)
--   Open ──→ Completed   (terminal, via complete_staff_task RPC)
--   Open ──→ Cancelled   (terminal, via cancel_staff_task RPC)
--   In Progress ──→ Completed (terminal, via complete_staff_task RPC)
--   In Progress ──→ Cancelled (terminal, via cancel_staff_task RPC)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('staff_task', get_status_id('staff_task', 'open'), get_status_id('staff_task', 'in_progress'),
     'start_staff_task', 'Start', 'Start working on the task. Only the assigned staff member can start their own tasks.'),
    ('staff_task', get_status_id('staff_task', 'open'), get_status_id('staff_task', 'completed'),
     'complete_staff_task', 'Complete', 'Mark task as complete directly from Open. Optional completion_notes parameter.'),
    ('staff_task', get_status_id('staff_task', 'open'), get_status_id('staff_task', 'cancelled'),
     'cancel_staff_task', 'Cancel', 'Cancel the task. Optional cancel_reason parameter. Editors, managers, and admins only.'),
    ('staff_task', get_status_id('staff_task', 'in_progress'), get_status_id('staff_task', 'completed'),
     'complete_staff_task', 'Complete', 'Mark an in-progress task as complete. Optional completion_notes parameter.'),
    ('staff_task', get_status_id('staff_task', 'in_progress'), get_status_id('staff_task', 'cancelled'),
     'cancel_staff_task', 'Cancel', 'Cancel an in-progress task. Optional cancel_reason parameter. Editors, managers, and admins only.');

-- The notify_task_assigned trigger fires on INSERT (not on property change),
-- which is outside the property_change_trigger model. Documented here for
-- completeness as part of the staff_task event chain.
--
--   INSERT staff_tasks ──→ notify_task_assigned()
--     → sends task_assigned notification (email + SMS) to the assigned staff member

-- ============================================================================
-- NOTIFY POSTGREST
-- ============================================================================

NOTIFY pgrst, 'reload schema';
