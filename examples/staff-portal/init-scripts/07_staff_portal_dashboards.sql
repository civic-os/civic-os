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
  v_user_id UUID;
BEGIN
  -- Get first user (dashboard ownership requirement)
  SELECT id INTO v_user_id FROM metadata.civic_os_users LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    -- Check if dashboard already exists
    SELECT id INTO v_dashboard_id
    FROM metadata.dashboards
    WHERE display_name = 'Staff Portal';

    IF v_dashboard_id IS NOT NULL THEN
      UPDATE metadata.dashboards
      SET description = 'Your staff portal home page with documents, time entries, and quick links',
          sort_order = 1,
          updated_at = NOW()
      WHERE id = v_dashboard_id;
    ELSE
      INSERT INTO metadata.dashboards (
        display_name, description, is_public, created_by, sort_order
      ) VALUES (
        'Staff Portal',
        'Your staff portal home page with documents, time entries, and quick links',
        TRUE,
        v_user_id,
        1
      )
      RETURNING id INTO v_dashboard_id;
    END IF;

    -- Delete existing widgets for this dashboard (idempotent re-run)
    DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

    -- Widget 1: Welcome markdown
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'markdown',
      'Welcome',
      jsonb_build_object(
        'content', E'# FFSC Staff Portal\n\nWelcome to the Flint Freedom Schools Collaborative staff management portal. Use this portal to manage your onboarding documents, track your time, and submit requests.\n\n## Quick Links\n\n- **[My Documents](/view/staff_documents)** - Upload and track onboarding paperwork\n- **[Time Entries](/view/time_entries)** - View your clock in/out history\n- **[Request Time Off](/create/time_off_requests)** - Submit a time-off request\n- **[Submit Reimbursement](/create/reimbursements)** - Request expense reimbursement\n- **[Report Incident](/create/incident_reports)** - File an incident report',
        'enableHtml', false
      ),
      1, 2, 1
    );

    -- Widget 2: My Documents
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'staff_documents',
      'My Documents',
      jsonb_build_object(
        'filters', jsonb_build_array(),
        'orderBy', 'created_at',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'status_id')
      ),
      2, 1, 1
    );

    -- Widget 3: My Time Entries
    INSERT INTO metadata.dashboard_widgets (
      dashboard_id, widget_type, entity_key, title, config, sort_order, width, height
    ) VALUES (
      v_dashboard_id,
      'filtered_list',
      'time_entries',
      'My Time Entries',
      jsonb_build_object(
        'filters', jsonb_build_array(),
        'orderBy', 'entry_time',
        'orderDirection', 'desc',
        'limit', 10,
        'showColumns', jsonb_build_array('display_name', 'entry_type', 'entry_time')
      ),
      3, 1, 1
    );

    RAISE NOTICE 'Dashboard "Staff Portal" created with ID %', v_dashboard_id;
  ELSE
    RAISE NOTICE 'No users found - skipping Staff Portal dashboard creation';
  END IF;
END $$;

-- ============================================================================
-- DASHBOARD 2: Admin Overview
-- ============================================================================

DO $$
DECLARE
  v_dashboard_id INT;
  v_user_id UUID;
  v_pending_time_off_id INT;
  v_pending_reimbursement_id INT;
BEGIN
  -- Get first user
  SELECT id INTO v_user_id FROM metadata.civic_os_users LIMIT 1;

  -- Get Pending status IDs
  SELECT id INTO v_pending_time_off_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Pending';
  SELECT id INTO v_pending_reimbursement_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Pending';

  IF v_user_id IS NOT NULL THEN
    -- Check if dashboard already exists
    SELECT id INTO v_dashboard_id
    FROM metadata.dashboards
    WHERE display_name = 'Admin Overview';

    IF v_dashboard_id IS NOT NULL THEN
      UPDATE metadata.dashboards
      SET description = 'Management view of onboarding progress, pending requests, and reimbursements',
          sort_order = 2,
          updated_at = NOW()
      WHERE id = v_dashboard_id;
    ELSE
      INSERT INTO metadata.dashboards (
        display_name, description, is_public, created_by, sort_order
      ) VALUES (
        'Admin Overview',
        'Management view of onboarding progress, pending requests, and reimbursements',
        TRUE,
        v_user_id,
        2
      )
      RETURNING id INTO v_dashboard_id;
    END IF;

    -- Delete existing widgets
    DELETE FROM metadata.dashboard_widgets WHERE dashboard_id = v_dashboard_id;

    -- Widget 1: Onboarding Progress (full width)
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
      1, 2, 1
    );

    -- Widget 2: Pending Time Off
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
      2, 1, 1
    );

    -- Widget 3: Pending Reimbursements
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
      3, 1, 1
    );

    RAISE NOTICE 'Dashboard "Admin Overview" created with ID %', v_dashboard_id;
  ELSE
    RAISE NOTICE 'No users found - skipping Admin Overview dashboard creation';
  END IF;
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
