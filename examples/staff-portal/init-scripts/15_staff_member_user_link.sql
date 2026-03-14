-- =============================================================================
-- Script 15: Staff Member Identity Refactor + Task Expansion
-- =============================================================================
-- Requires: Scripts 01-14 applied, all staff_members have user_id set
--
-- Changes:
--   A. Staff Member Identity
--      1. Grant civic_os_users_private:read to all roles
--      2. Drop email column, make user_id NOT NULL + UNIQUE
--      3. Auto-compute display_name as "Full Name - Site Name"
--      4. Cascade triggers for name/site changes
--      5. Update denormalization triggers (child tables use user's real name)
--      6. Update notification functions (same pattern)
--      7. Update staff_directory VIEW (pull identity from user record)
--      8. Update metadata configuration
--
--   B. Task Improvements
--      9. AFTER INSERT trigger expands site/role → individual rows
--     10. Make priority_id required (backfill + NOT NULL)
--     11. Make assignment columns create-only
--     12. Update "My Tasks" dashboard widget (priority instead of status)
--     13. Simplify RLS (all rows now have assigned_to_id)
--     14. Drop CHECK constraint (no longer needed)
--
--   C. Schema Decisions (ADRs)
-- =============================================================================

BEGIN;

-- =============================================================================
-- A1. GRANT civic_os_users_private:read TO ALL AUTHENTICATED ROLES
-- =============================================================================
-- The permission already exists (granted to admin by baseline). We're extending
-- it so all staff can see each other's names/emails. The existing RLS policy
-- "Permitted roles see all private data" already checks has_permission().

INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'civic_os_users_private'
  AND p.permission = 'read'
  AND r.role_key IN ('user', 'editor', 'manager', 'admin', 'bookkeeper')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- A2. SCHEMA CHANGES TO staff_members
-- =============================================================================
-- Drop email (redundant with civic_os_users_private). Make user_id required.

-- Safety check: fail loudly if any staff_member lacks a user_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM staff_members WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate: staff_members with NULL user_id exist. Link all staff to users first.';
  END IF;
END $$;

-- Drop staff_directory VIEW first (depends on email column)
DROP VIEW IF EXISTS staff_directory;

-- Drop civic_os_text_search generated column (depends on email column)
ALTER TABLE staff_members DROP COLUMN IF EXISTS civic_os_text_search;

-- Drop email column (must drop UNIQUE constraint first)
ALTER TABLE staff_members DROP CONSTRAINT staff_members_email_key;
ALTER TABLE staff_members DROP COLUMN email;

-- Recreate text search column without email (display_name is sufficient)
ALTER TABLE staff_members ADD COLUMN civic_os_text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', display_name)
  ) STORED;
CREATE INDEX idx_staff_members_search ON staff_members USING GIN(civic_os_text_search);

-- Make user_id NOT NULL + UNIQUE
ALTER TABLE staff_members ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE staff_members ADD CONSTRAINT staff_members_user_id_unique UNIQUE (user_id);

-- =============================================================================
-- A3. AUTO-SYNC TRIGGER: staff_members.display_name
-- =============================================================================
-- Computes "Full Name - Site Name" on INSERT or UPDATE of user_id/site_id.

CREATE OR REPLACE FUNCTION sync_staff_member_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_name TEXT;
  v_site_name TEXT;
BEGIN
  SELECT cup.display_name INTO v_user_name
    FROM metadata.civic_os_users_private cup WHERE cup.id = NEW.user_id;
  SELECT s.display_name INTO v_site_name
    FROM sites s WHERE s.id = NEW.site_id;

  NEW.display_name := COALESCE(v_user_name, 'Unknown') || ' - ' || COALESCE(v_site_name, 'Unknown');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_staff_member_display_name
  BEFORE INSERT OR UPDATE OF user_id, site_id ON staff_members
  FOR EACH ROW
  EXECUTE FUNCTION sync_staff_member_display_name();

-- Backfill existing rows (no-op UPDATE triggers the BEFORE UPDATE)
UPDATE staff_members SET site_id = site_id;

-- =============================================================================
-- A4. CASCADE TRIGGERS (name/site changes propagate)
-- =============================================================================

-- When a user's name changes in Keycloak (civic_os_users_private.display_name)
CREATE OR REPLACE FUNCTION cascade_user_name_to_staff_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_site_name TEXT;
BEGIN
  IF OLD.display_name IS DISTINCT FROM NEW.display_name THEN
    UPDATE staff_members sm
    SET display_name = NEW.display_name || ' - ' || COALESCE(s.display_name, 'Unknown')
    FROM sites s
    WHERE s.id = sm.site_id AND sm.user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cascade_user_name_to_staff
  AFTER UPDATE OF display_name ON metadata.civic_os_users_private
  FOR EACH ROW
  EXECUTE FUNCTION cascade_user_name_to_staff_member();

-- When a site is renamed
CREATE OR REPLACE FUNCTION cascade_site_name_to_staff_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF OLD.display_name IS DISTINCT FROM NEW.display_name THEN
    UPDATE staff_members sm
    SET display_name = cup.display_name || ' - ' || NEW.display_name
    FROM metadata.civic_os_users_private cup
    WHERE cup.id = sm.user_id AND sm.site_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cascade_site_name_to_staff
  AFTER UPDATE OF display_name ON sites
  FOR EACH ROW
  EXECUTE FUNCTION cascade_site_name_to_staff_members();

-- =============================================================================
-- A5. UPDATE DENORMALIZATION TRIGGERS (child tables use user's real name)
-- =============================================================================
-- All 4 triggers that previously read sm.display_name now JOIN through
-- civic_os_users_private so child record labels use the person's real name.

-- 1. set_staff_document_display_name() — "StaffName - DocumentName"
CREATE OR REPLACE FUNCTION set_staff_document_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
  v_doc_name TEXT;
BEGIN
  SELECT cup.display_name INTO v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.staff_member_id;
  SELECT display_name INTO v_doc_name FROM document_requirements WHERE id = NEW.requirement_id;
  NEW.display_name := COALESCE(v_staff_name, 'Unknown') || ' - ' || COALESCE(v_doc_name, 'Unknown');
  RETURN NEW;
END;
$$;

-- 2. denormalize_time_entry() — copies staff_name and site_name
CREATE OR REPLACE FUNCTION denormalize_time_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
  v_site_name TEXT;
BEGIN
  SELECT cup.display_name, s.display_name
    INTO v_staff_name, v_site_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    JOIN sites s ON s.id = sm.site_id
    WHERE sm.id = NEW.staff_member_id;

  NEW.staff_name := COALESCE(v_staff_name, 'Unknown');
  NEW.site_name := COALESCE(v_site_name, 'Unknown');
  RETURN NEW;
END;
$$;

-- 3. set_reimbursement_display_name() — "StaffName - Description"
CREATE OR REPLACE FUNCTION set_reimbursement_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
BEGIN
  SELECT cup.display_name INTO v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.staff_member_id;
  NEW.display_name := COALESCE(v_staff_name, 'Unknown') || ' - ' || COALESCE(NEW.description, 'Reimbursement');
  RETURN NEW;
END;
$$;

-- 4. set_offboarding_display_name() — "StaffName - Feedback"
CREATE OR REPLACE FUNCTION set_offboarding_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
BEGIN
  SELECT cup.display_name INTO v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.staff_member_id;
  NEW.display_name := COALESCE(v_staff_name, 'Unknown') || ' - Feedback';
  RETURN NEW;
END;
$$;

-- =============================================================================
-- A6. UPDATE NOTIFICATION FUNCTIONS
-- =============================================================================
-- Each function that looked up sm.display_name now JOINs through
-- civic_os_users_private for the user's real name.

-- From script 05 (not overridden):

-- 1. notify_document_status_change()
CREATE OR REPLACE FUNCTION notify_document_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_submitted_id INT;
  v_needs_revision_id INT;
  v_approved_id INT;
  v_staff_user_id UUID;
  v_staff_name TEXT;
  v_site_name TEXT;
  v_requirement_name TEXT;
  v_entity_data JSONB;
  v_template TEXT;
  v_mgr RECORD;
BEGIN
  SELECT id INTO v_submitted_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Submitted';
  SELECT id INTO v_needs_revision_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Needs Revision';
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Approved';

  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  -- Look up staff member info via user record (needed for all templates)
  SELECT sm.user_id, cup.display_name, s.display_name
    INTO v_staff_user_id, v_staff_name, v_site_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    JOIN sites s ON s.id = sm.site_id
    WHERE sm.id = NEW.staff_member_id;

  SELECT dr.display_name INTO v_requirement_name
    FROM document_requirements dr
    WHERE dr.id = NEW.requirement_id;

  -- Handle Submitted → notify managers
  IF NEW.status_id = v_submitted_id THEN
    v_entity_data := jsonb_build_object(
      'DocumentId', NEW.id,
      'DocumentName', NEW.display_name,
      'StaffName', v_staff_name,
      'RequirementName', v_requirement_name,
      'SiteName', v_site_name
    );

    FOR v_mgr IN
      SELECT DISTINCT user_id FROM get_users_with_role('manager')
    LOOP
      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data, channels
      ) VALUES (
        v_mgr.user_id,
        'document_submitted',
        'staff_documents',
        NEW.id,
        v_entity_data,
        ARRAY['email', 'sms']
      );
    END LOOP;

    RETURN NEW;
  END IF;

  -- Handle Needs Revision or Approved → notify staff member
  IF NEW.status_id = v_needs_revision_id THEN
    v_template := 'document_needs_revision';
  ELSIF NEW.status_id = v_approved_id THEN
    v_template := 'document_approved';
  ELSE
    RETURN NEW;
  END IF;

  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_entity_data := jsonb_build_object(
    'DocumentId', NEW.id,
    'DocumentName', NEW.display_name,
    'StaffName', v_staff_name,
    'RequirementName', v_requirement_name,
    'ReviewerNotes', NEW.reviewer_notes
  );

  INSERT INTO metadata.notifications (
    user_id, template_name, entity_type, entity_id, entity_data, channels
  ) VALUES (
    v_staff_user_id,
    v_template,
    'staff_documents',
    NEW.id,
    v_entity_data,
    ARRAY['email', 'sms']
  );

  RETURN NEW;
END;
$$;

-- 2. notify_time_off_submitted()
CREATE OR REPLACE FUNCTION notify_time_off_submitted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff_name TEXT;
  v_site_id BIGINT;
  v_site_name TEXT;
  v_entity_data JSONB;
  v_lead RECORD;
BEGIN
  SELECT cup.display_name, sm.site_id, s.display_name
    INTO v_staff_name, v_site_id, v_site_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    JOIN sites s ON s.id = sm.site_id
    WHERE sm.id = NEW.staff_member_id;

  v_entity_data := jsonb_build_object(
    'RequestId', NEW.id,
    'StaffName', v_staff_name,
    'SiteName', v_site_name,
    'StartDate', NEW.start_date,
    'EndDate', NEW.end_date,
    'Reason', NEW.reason
  );

  FOR v_lead IN
    SELECT user_id FROM get_site_lead_email(v_site_id)
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data, channels
    ) VALUES (
      v_lead.user_id,
      'time_off_submitted',
      'time_off_requests',
      NEW.id,
      v_entity_data,
      ARRAY['email', 'sms']
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- 3. notify_time_off_status_change()
CREATE OR REPLACE FUNCTION notify_time_off_status_change()
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
BEGIN
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses
    WHERE entity_type = 'time_off_request' AND display_name = 'Denied';

  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  IF NEW.status_id = v_approved_id THEN
    v_template := 'time_off_approved';
  ELSIF NEW.status_id = v_denied_id THEN
    v_template := 'time_off_denied';
  ELSE
    RETURN NEW;
  END IF;

  SELECT sm.user_id, cup.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.staff_member_id;

  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_entity_data := jsonb_build_object(
    'RequestId', NEW.id,
    'StaffName', v_staff_name,
    'StartDate', NEW.start_date,
    'EndDate', NEW.end_date,
    'ResponseNotes', NEW.response_notes
  );

  INSERT INTO metadata.notifications (
    user_id, template_name, entity_type, entity_id, entity_data, channels
  ) VALUES (
    v_staff_user_id,
    v_template,
    'time_off_requests',
    NEW.id,
    v_entity_data,
    ARRAY['email', 'sms']
  );

  RETURN NEW;
END;
$$;

-- 4. notify_incident_report_filed()
CREATE OR REPLACE FUNCTION notify_incident_report_filed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reporter_name TEXT;
  v_site_name TEXT;
  v_entity_data JSONB;
  v_recipient RECORD;
  v_notified_users UUID[] := '{}';
BEGIN
  SELECT cup.display_name INTO v_reporter_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.reported_by_id;

  SELECT s.display_name INTO v_site_name
    FROM sites s
    WHERE s.id = NEW.site_id;

  v_entity_data := jsonb_build_object(
    'ReportId', NEW.id,
    'SiteName', v_site_name,
    'ReporterName', v_reporter_name,
    'IncidentDate', NEW.incident_date,
    'Description', NEW.description,
    'PeopleInvolved', NEW.people_involved,
    'ActionTaken', NEW.action_taken,
    'FollowUpNeeded', NEW.follow_up_needed
  );

  FOR v_recipient IN
    SELECT user_id FROM get_site_lead_email(NEW.site_id)
  LOOP
    INSERT INTO metadata.notifications (
      user_id, template_name, entity_type, entity_id, entity_data, channels
    ) VALUES (
      v_recipient.user_id,
      'incident_report_filed',
      'incident_reports',
      NEW.id,
      v_entity_data,
      ARRAY['email', 'sms']
    );
    v_notified_users := array_append(v_notified_users, v_recipient.user_id);
  END LOOP;

  FOR v_recipient IN
    SELECT DISTINCT user_id FROM get_users_with_role('manager')
  LOOP
    IF NOT v_recipient.user_id = ANY(v_notified_users) THEN
      INSERT INTO metadata.notifications (
        user_id, template_name, entity_type, entity_id, entity_data, channels
      ) VALUES (
        v_recipient.user_id,
        'incident_report_filed',
        'incident_reports',
        NEW.id,
        v_entity_data,
        ARRAY['email', 'sms']
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- From script 14 (bookkeeper overrides):

-- 5. notify_reimbursement_submitted() — sends to bookkeepers
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
  SELECT cup.display_name INTO v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.staff_member_id;

  v_entity_data := jsonb_build_object(
    'ReimbursementId', NEW.id,
    'StaffName', v_staff_name,
    'Amount', NEW.amount::TEXT,
    'Description', NEW.description,
    'HasReceipt', (NEW.receipt IS NOT NULL)
  );

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

-- 6. notify_reimbursement_status_change() — notifies staff member + bookkeepers
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
  SELECT id INTO v_approved_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Approved';
  SELECT id INTO v_denied_id FROM metadata.statuses
    WHERE entity_type = 'reimbursement' AND display_name = 'Denied';

  IF OLD.status_id = NEW.status_id THEN
    RETURN NEW;
  END IF;

  IF NEW.status_id = v_approved_id THEN
    v_template := 'reimbursement_approved';
  ELSIF NEW.status_id = v_denied_id THEN
    v_template := 'reimbursement_denied';
  ELSE
    RETURN NEW;
  END IF;

  SELECT sm.user_id, cup.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.staff_member_id;

  v_entity_data := jsonb_build_object(
    'ReimbursementId', NEW.id,
    'StaffName', v_staff_name,
    'Amount', NEW.amount::TEXT,
    'Description', NEW.description,
    'ResponseNotes', NEW.response_notes
  );

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

  FOR v_recipient IN
    SELECT DISTINCT user_id FROM get_users_with_role('bookkeeper')
    WHERE user_id != current_user_id()
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

-- 7. notify_task_assigned() — simplified for expansion (only direct assignment)
-- After expansion, all persisted rows have assigned_to_id. The site/role branches
-- from script 14 are no longer needed since the expansion trigger handles them.
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
  -- Only notify for direct assignments (expanded rows always have assigned_to_id)
  IF NEW.assigned_to_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT sm.user_id, cup.display_name
    INTO v_staff_user_id, v_staff_name
    FROM staff_members sm
    JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
    WHERE sm.id = NEW.assigned_to_id;

  IF v_staff_user_id IS NULL THEN
    RETURN NEW;
  END IF;

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

-- =============================================================================
-- A7. UPDATE staff_directory VIEW
-- =============================================================================
-- Pull identity (name, email) from civic_os_users_private instead of staff_members.

CREATE OR REPLACE VIEW staff_directory AS
SELECT
  sm.id,
  cup.display_name,
  cup.email,
  sm.role_id,
  c.display_name AS staff_role,
  sm.site_id,
  s.display_name AS site_name
FROM staff_members sm
JOIN metadata.civic_os_users_private cup ON cup.id = sm.user_id
LEFT JOIN metadata.categories c ON c.id = sm.role_id
LEFT JOIN sites s ON s.id = sm.site_id;

-- Re-grant after DROP + CREATE (the DROP in A2 removed the original grant)
GRANT SELECT ON staff_directory TO authenticated;

-- Add FK columns for dropdown filtering (role_id → Category, site_id → FK)
INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit, filterable, category_entity_type)
VALUES ('staff_directory', 'role_id', 'Role Filter', 5, FALSE, FALSE, FALSE, FALSE, TRUE, 'staff_role')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET filterable = TRUE, category_entity_type = 'staff_role', show_on_list = FALSE;

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, show_on_list, show_on_detail, show_on_create, show_on_edit, filterable, join_table, join_column)
VALUES ('staff_directory', 'site_id', 'Site Filter', 6, FALSE, FALSE, FALSE, FALSE, TRUE, 'sites', 'display_name')
ON CONFLICT (table_name, column_name) DO UPDATE
  SET filterable = TRUE, join_table = 'sites', join_column = 'id', show_on_list = FALSE;

-- Remove text-column filterable flags (FK columns handle filtering now)
UPDATE metadata.properties SET filterable = FALSE
WHERE table_name = 'staff_directory' AND column_name IN ('staff_role', 'site_name');

-- =============================================================================
-- A8. UPDATE METADATA CONFIGURATION
-- =============================================================================

-- display_name: keep on list/detail but hide from create/edit (auto-managed)
UPDATE metadata.properties
SET show_on_create = FALSE, show_on_edit = FALSE
WHERE table_name = 'staff_members' AND column_name = 'display_name';

-- email: remove registration (column dropped)
DELETE FROM metadata.properties
WHERE table_name = 'staff_members' AND column_name = 'email';

-- user_id: promote to primary identity field, show on list
UPDATE metadata.properties
SET show_on_list = TRUE, sort_order = 2, display_name = 'User'
WHERE table_name = 'staff_members' AND column_name = 'user_id';

-- Update search_fields (email column gone)
UPDATE metadata.entities
SET search_fields = ARRAY['display_name']
WHERE table_name = 'staff_members';

-- Remove constraint_message for dropped email unique constraint
DELETE FROM metadata.constraint_messages
WHERE constraint_name = 'staff_members_email_key';

-- Add constraint_message for user_id unique
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES ('staff_members_user_id_unique', 'staff_members', 'user_id',
        'This user is already linked to a staff member.')
ON CONFLICT (constraint_name) DO UPDATE SET error_message = EXCLUDED.error_message;

-- =============================================================================
-- B9. TASK MASS ASSIGNMENT EXPANSION TRIGGER
-- =============================================================================
-- AFTER INSERT trigger: if assigned_to_site_id or assigned_to_role_id is set,
-- expand into individual rows (one per matching staff member) and delete the
-- original. The notify_task_assigned trigger fires for each expanded row.

CREATE OR REPLACE FUNCTION expand_staff_task_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff RECORD;
  v_count INT := 0;
BEGIN
  -- Individual assignment: no expansion needed
  IF NEW.assigned_to_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Site assignment: create one task per staff member at that site
  IF NEW.assigned_to_site_id IS NOT NULL THEN
    FOR v_staff IN
      SELECT id FROM staff_members WHERE site_id = NEW.assigned_to_site_id
    LOOP
      INSERT INTO staff_tasks (
        display_name, description, assigned_to_id, assigned_by,
        site_id, due_date, status_id, priority_id
      ) VALUES (
        NEW.display_name, NEW.description, v_staff.id, NEW.assigned_by,
        NEW.site_id, NEW.due_date, NEW.status_id, NEW.priority_id
      );
      v_count := v_count + 1;
    END LOOP;

  -- Role assignment: create one task per staff member with that role
  ELSIF NEW.assigned_to_role_id IS NOT NULL THEN
    FOR v_staff IN
      SELECT id FROM staff_members WHERE role_id = NEW.assigned_to_role_id
    LOOP
      INSERT INTO staff_tasks (
        display_name, description, assigned_to_id, assigned_by,
        site_id, due_date, status_id, priority_id
      ) VALUES (
        NEW.display_name, NEW.description, v_staff.id, NEW.assigned_by,
        NEW.site_id, NEW.due_date, NEW.status_id, NEW.priority_id
      );
      v_count := v_count + 1;
    END LOOP;
  END IF;

  -- Delete the original polymorphic row (expanded rows replace it)
  IF v_count > 0 THEN
    DELETE FROM staff_tasks WHERE id = NEW.id;
  END IF;

  RETURN NULL; -- AFTER trigger, return value ignored
END;
$$;

CREATE TRIGGER trg_expand_staff_task_assignment
  AFTER INSERT ON staff_tasks
  FOR EACH ROW
  EXECUTE FUNCTION expand_staff_task_assignment();

-- =============================================================================
-- B10. MAKE priority_id REQUIRED
-- =============================================================================
-- Every task should have a priority. Backfill existing NULLs to Medium.

UPDATE staff_tasks SET priority_id = (
  SELECT id FROM metadata.categories WHERE entity_type = 'task_priority' AND display_name = 'Medium'
) WHERE priority_id IS NULL;

ALTER TABLE staff_tasks ALTER COLUMN priority_id SET NOT NULL;

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message)
VALUES ('staff_tasks', 'priority_id', 'required', 'true', 'Priority is required')
ON CONFLICT (table_name, column_name, validation_type) DO NOTHING;

-- =============================================================================
-- B11. MAKE ASSIGNMENT COLUMNS CREATE-ONLY
-- =============================================================================

UPDATE metadata.properties SET show_on_edit = FALSE
WHERE table_name = 'staff_tasks'
  AND column_name IN ('assigned_to_id', 'assigned_to_site_id', 'assigned_to_role_id');

-- =============================================================================
-- B12. UPDATE "MY TASKS" DASHBOARD WIDGET — priority instead of status
-- =============================================================================

UPDATE metadata.dashboard_widgets
SET config = jsonb_set(
  config,
  '{showColumns}',
  '["display_name", "assigned_to_id", "due_date", "priority_id"]'::jsonb
)
WHERE title = 'My Tasks' AND entity_key = 'staff_tasks';

-- =============================================================================
-- B13. SIMPLIFY RLS (all persisted rows now have assigned_to_id)
-- =============================================================================
-- The site/role branches in RLS are no longer needed since expansion ensures
-- every persisted row has assigned_to_id set.

DROP POLICY select_staff_tasks ON staff_tasks;
CREATE POLICY select_staff_tasks ON staff_tasks
  FOR SELECT TO authenticated
  USING (
    assigned_to_id = get_current_staff_member_id()
    OR assigned_by = current_user_id()
    OR is_lead_of_site(site_id)
    OR is_lead_of_site(get_site_id_for_staff(assigned_to_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

DROP POLICY update_staff_tasks ON staff_tasks;
CREATE POLICY update_staff_tasks ON staff_tasks
  FOR UPDATE TO authenticated
  USING (
    assigned_to_id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR is_lead_of_site(get_site_id_for_staff(assigned_to_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

-- =============================================================================
-- B14. DROP CHECK CONSTRAINT
-- =============================================================================
-- No longer correct after expansion — expanded rows have assigned_to_id only.

ALTER TABLE staff_tasks DROP CONSTRAINT IF EXISTS chk_exactly_one_assignment;
DELETE FROM metadata.constraint_messages WHERE constraint_name = 'chk_exactly_one_assignment';

-- =============================================================================
-- D. CLEAN UP UNSUPPORTED PROPERTY TYPES
-- =============================================================================

-- Drop incident_time: PostgreSQL `time` type is not yet supported in EntityPropertyType.
ALTER TABLE incident_reports DROP COLUMN IF EXISTS incident_time;
DELETE FROM metadata.properties
WHERE table_name = 'incident_reports' AND column_name = 'incident_time';

-- Hide applies_to_roles: text[] arrays are not supported in EntityPropertyType.
-- Column is used by the staff_documents trigger but isn't user-editable.
UPDATE metadata.properties
SET show_on_list = FALSE, show_on_create = FALSE, show_on_edit = FALSE, show_on_detail = FALSE
WHERE table_name = 'document_requirements' AND column_name = 'applies_to_roles';

-- =============================================================================
-- E. SCHEMA DECISIONS (ADRs)
-- =============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
  ARRAY['staff_members']::NAME[], ARRAY['user_id', 'display_name', 'email']::NAME[], 'staff-portal-15-user-link',
  'Require user_id and auto-manage display_name',
  'accepted',
  'Staff members duplicated name and email from civic_os_users_private. Since all staff are provisioned users, this is redundant.',
  'Make user_id NOT NULL + UNIQUE. Drop email column. Auto-compute display_name as "FullName - SiteName" via BEFORE trigger. All downstream consumers (denorm triggers, notifications, staff_directory) now JOIN through civic_os_users_private for the real name.',
  'Alternative: keep email as optional override. Rejected because FFSC uses single email per person and identity should have one source of truth.',
  'email column removed. display_name is read-only (auto-managed). Cascade triggers propagate name/site changes.',
  CURRENT_DATE
);

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
  ARRAY['staff_tasks']::NAME[], ARRAY['assigned_to_id', 'assigned_to_site_id', 'assigned_to_role_id']::NAME[], 'staff-portal-15-task-expansion',
  'Expand site/role assignments into individual task rows',
  'accepted',
  'Polymorphic assignment columns from script 14 create a single task row for multiple people, but the dashboard cannot show an assignee name and there is no individual completion tracking.',
  'AFTER INSERT trigger detects assigned_to_site_id or assigned_to_role_id, creates individual rows for each matching staff member, then deletes the original. Assignment columns become create-only (trigger input).',
  'Alternative: keep polymorphic single-row design. Rejected because no individual completion tracking and dashboard cannot show assignee name.',
  'Each person gets their own trackable task. RLS simplified (all rows have assigned_to_id). CHECK constraint dropped.',
  CURRENT_DATE
);

COMMIT;
