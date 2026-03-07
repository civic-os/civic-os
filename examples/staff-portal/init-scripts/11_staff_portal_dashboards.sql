-- ============================================================================
-- STAFF PORTAL - DASHBOARDS
-- ============================================================================
-- Creates two dashboards:
--   1. "Staff Portal" - Default landing page for all users
--   2. "Admin Overview" - Management dashboard with pending items
-- Also updates the Welcome dashboard markdown content.
-- ============================================================================

-- ============================================================================
-- DASHBOARD 1: Staff Portal (default landing page)
-- ============================================================================

DO $$
DECLARE
  v_dashboard_id INT;
  -- staff_task statuses
  v_st_open_id INT;
  v_st_in_progress_id INT;
  -- staff_document statuses
  v_sd_pending_id INT;
  v_sd_needs_revision_id INT;
  -- time_off_request statuses
  v_tor_pending_id INT;
  -- reimbursement statuses
  v_re_pending_id INT;
  -- time_entry types (for nav_buttons query params)
  v_te_clock_in_id INT;
  v_te_clock_out_id INT;
BEGIN
  -- Look up status IDs for filters
  SELECT id INTO v_st_open_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'Open';
  SELECT id INTO v_st_in_progress_id FROM metadata.statuses
    WHERE entity_type = 'staff_task' AND display_name = 'In Progress';
  SELECT id INTO v_sd_pending_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Pending';
  SELECT id INTO v_sd_needs_revision_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Needs Revision';
  SELECT id INTO v_tor_pending_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Pending';
  SELECT id INTO v_re_pending_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Pending';
  -- Look up type IDs for time_entry (uses Type system, not Status)
  SELECT id INTO v_te_clock_in_id FROM metadata.types
    WHERE entity_type = 'time_entry' AND type_key = 'clock_in';
  SELECT id INTO v_te_clock_out_id FROM metadata.types
    WHERE entity_type = 'time_entry' AND type_key = 'clock_out';

  -- Clear any existing system default so the unique index allows our new default
  UPDATE metadata.dashboards SET is_default = FALSE WHERE is_default = TRUE;

  -- Check if dashboard already exists
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE display_name = 'Staff Portal';

  IF v_dashboard_id IS NOT NULL THEN
    UPDATE metadata.dashboards
    SET description = 'Your staff portal home page',
        is_default = TRUE,
        sort_order = 1,
        updated_at = NOW()
    WHERE id = v_dashboard_id;
  ELSE
    INSERT INTO metadata.dashboards (
      display_name, description, is_public, is_default, sort_order
    ) VALUES (
      'Staff Portal',
      'Your staff portal home page',
      TRUE,
      TRUE,
      1
    )
    RETURNING id INTO v_dashboard_id;
  END IF;

    -- Delete existing widgets for this dashboard (idempotent re-run)
    DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

    -- Widget 1: Welcome markdown (full-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'markdown',
      'Welcome',
      jsonb_build_object(
        'content', E'# FFSC Staff Portal\n\nWelcome to the Flint Freedom Schools Collaborative staff management portal.',
        'enableHtml', false
      ),
      1, 2, 1
    );

    -- Widget 2: Quick Actions nav_buttons (full-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'nav_buttons',
      NULL,
      jsonb_build_object(
        'buttons', jsonb_build_array(
          jsonb_build_object('text', 'Clock In',          'url', '/create/time_entries?entry_type_id=' || v_te_clock_in_id,  'icon', 'login',       'variant', 'primary'),
          jsonb_build_object('text', 'Clock Out',         'url', '/create/time_entries?entry_type_id=' || v_te_clock_out_id, 'icon', 'logout',      'variant', 'secondary'),
          jsonb_build_object('text', 'Request Time Off',  'url', '/create/time_off_requests',                'icon', 'event_busy',  'variant', 'outline'),
          jsonb_build_object('text', 'Reimbursement',     'url', '/create/reimbursements',                   'icon', 'receipt_long', 'variant', 'outline'),
          jsonb_build_object('text', 'Incident Report',   'url', '/create/incident_reports',                 'icon', 'report',      'variant', 'outline')
        )
      ),
      2, 2, 1
    );

    -- Widget 3: My Tasks - Open/In Progress (full-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'staff_tasks',
      'My Tasks',
      jsonb_build_object(
        'filters', CASE WHEN v_st_open_id IS NOT NULL AND v_st_in_progress_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'in', 'value',
              jsonb_build_array(v_st_open_id, v_st_in_progress_id))
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'due_date',
        'orderDirection', 'asc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'assigned_to_id', 'due_date', 'status_id')
      ),
      3, 2, 1
    );

    -- Widget 4: Documents Needing Attention (half-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'staff_documents',
      'Documents Needing Attention',
      jsonb_build_object(
        'filters', CASE WHEN v_sd_pending_id IS NOT NULL AND v_sd_needs_revision_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'in', 'value',
              jsonb_build_array(v_sd_pending_id, v_sd_needs_revision_id))
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'status_id')
      ),
      4, 1, 1
    );

    -- Widget 5: Pending Time Off (half-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'time_off_requests',
      'Pending Time Off Requests',
      jsonb_build_object(
        'filters', CASE WHEN v_tor_pending_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_tor_pending_id)
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'start_date', 'end_date', 'status_id')
      ),
      5, 1, 1
    );

    -- Widget 6: Pending Reimbursements (half-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'reimbursements',
      'Pending Reimbursements',
      jsonb_build_object(
        'filters', CASE WHEN v_re_pending_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_re_pending_id)
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'amount', 'status_id')
      ),
      6, 1, 1
    );

    -- Widget 7: Recent Time Entries (half-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'time_entries',
      'Recent Time Entries',
      jsonb_build_object(
        'filters', jsonb_build_array(),
        'orderBy', 'entry_time',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'entry_type_id', 'entry_time')
      ),
      7, 1, 1
    );

    RAISE NOTICE 'Dashboard "Staff Portal" created with ID %', v_dashboard_id;
END $$;

-- ============================================================================
-- DASHBOARD 2: Admin Overview
-- ============================================================================

DO $$
DECLARE
  v_dashboard_id INT;
  v_pending_time_off_id INT;
  v_pending_reimbursement_id INT;
  v_sd_submitted_id INT;
BEGIN
  -- Get status IDs for filters
  SELECT id INTO v_pending_time_off_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Pending';
  SELECT id INTO v_pending_reimbursement_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Pending';
  SELECT id INTO v_sd_submitted_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Submitted';

  -- Check if dashboard already exists
  SELECT id INTO v_dashboard_id
  FROM metadata.dashboards
  WHERE display_name = 'Admin Overview';

  IF v_dashboard_id IS NOT NULL THEN
    UPDATE metadata.dashboards
    SET description = 'Management view of staff, pending requests, and documents',
        sort_order = 2,
        updated_at = NOW()
    WHERE id = v_dashboard_id;
  ELSE
    INSERT INTO metadata.dashboards (
      display_name, description, is_public, sort_order
    ) VALUES (
      'Admin Overview',
      'Management view of staff, pending requests, and documents',
      TRUE,
      2
    )
    RETURNING id INTO v_dashboard_id;
  END IF;

    -- Delete existing widgets
    DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

    -- Widget 1: Admin Quick Actions nav_buttons (full-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'nav_buttons',
      NULL,
      jsonb_build_object(
        'buttons', jsonb_build_array(
          jsonb_build_object('text', 'Add Staff Member', 'url', '/create/staff_members', 'icon', 'person_add', 'variant', 'primary'),
          jsonb_build_object('text', 'Staff Roster',     'url', '/view/staff_members',   'icon', 'group',      'variant', 'outline'),
          jsonb_build_object('text', 'All Documents',    'url', '/view/staff_documents',  'icon', 'folder_open', 'variant', 'outline'),
          jsonb_build_object('text', 'Time Entries',     'url', '/view/time_entries',     'icon', 'schedule',   'variant', 'outline'),
          jsonb_build_object('text', 'Incidents',        'url', '/view/incident_reports', 'icon', 'report',     'variant', 'outline')
        )
      ),
      1, 2, 1
    );

    -- Widget 2: Onboarding Progress (full-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'staff_members',
      'Onboarding Progress',
      jsonb_build_object(
        'filters', jsonb_build_array(),
        'orderBy', 'display_name',
        'orderDirection', 'asc',
        'limit', 20,
        'showColumns', jsonb_build_array('display_name', 'site_id', 'role_id', 'onboarding_status_id')
      ),
      2, 2, 1
    );

    -- Widget 3: Pending Time Off (half-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'time_off_requests',
      'Pending Time Off',
      jsonb_build_object(
        'filters', CASE WHEN v_pending_time_off_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_pending_time_off_id)
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'staff_member_id', 'start_date', 'end_date')
      ),
      3, 1, 1
    );

    -- Widget 4: Pending Reimbursements (half-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'reimbursements',
      'Pending Reimbursements',
      jsonb_build_object(
        'filters', CASE WHEN v_pending_reimbursement_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_pending_reimbursement_id)
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'staff_member_id', 'amount', 'description')
      ),
      4, 1, 1
    );

    -- Widget 5: Documents Needing Review (full-width)
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'staff_documents',
      'Documents Needing Review',
      jsonb_build_object(
        'filters', CASE WHEN v_sd_submitted_id IS NOT NULL THEN
          jsonb_build_array(
            jsonb_build_object('column', 'status_id', 'operator', 'eq', 'value', v_sd_submitted_id)
          )
        ELSE
          jsonb_build_array()
        END,
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'staff_member_id', 'status_id')
      ),
      5, 2, 1
    );

    RAISE NOTICE 'Dashboard "Admin Overview" created with ID %', v_dashboard_id;
END $$;

-- ============================================================================
-- UPDATE WELCOME DASHBOARD
-- ============================================================================

UPDATE metadata.dashboard_widgets
SET config = jsonb_build_object(
  'content', E'# Welcome to the FFSC Staff Portal\n\nThis demo showcases Civic OS''s capabilities for building a staff management portal for the Flint Freedom Schools Collaborative (FFSC) summer program.\n\n## Quick Start\n\n1. **Staff Members** - Visit `/view/staff_members` to see the staff roster\n2. **Documents** - Go to `/view/staff_documents` to manage onboarding paperwork\n3. **Time Tracking** - Clock in/out from the staff member detail page\n4. **Requests** - Submit time-off and reimbursement requests\n\n## Key Features Demonstrated\n\n### Onboarding Workflow\n- Auto-generated document checklists when staff are added\n- Document upload with file storage (S3/MinIO)\n- Review and approval workflow with status tracking\n- Aggregated onboarding status (Not Started / Partial / All Approved)\n\n### Time & Attendance\n- Clock In/Out via Entity Action Buttons on staff detail page\n- Denormalized time entries with staff name and site for reporting\n\n### Approval Workflows\n- Time-off requests with site lead approval\n- Expense reimbursements with manager approval\n- Email notifications at each workflow step\n\n### Three-Tier RLS\n- **Staff**: See own records only\n- **Site Lead**: See records for staff at their site\n- **Manager/Admin**: See all records\n\n## Try These Tasks\n\n- **Add a Staff Member**: Create a new staff member and watch documents auto-generate\n- **Upload a Document**: Upload a file to a pending document and see status change to Submitted\n- **Approve Documents** (editor/manager role): Review and approve submitted documents\n- **Clock In/Out**: Use action buttons on a staff member''s detail page\n- **Submit Time Off**: Create a time-off request and approve it as a site lead\n\n---\n\nSee `examples/staff-portal/README.md` for complete setup guide and technical reference.',
  'enableHtml', false
)
WHERE dashboard_id = (SELECT id FROM metadata.dashboards WHERE display_name = 'Welcome' LIMIT 1)
  AND widget_type = 'markdown';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
