-- ============================================================================
-- STAFF PORTAL EXAMPLE
-- A staff management portal for a summer education program.
-- Demonstrates: Status types, file uploads, RLS with role-based visibility,
--   SECURITY DEFINER helpers, denormalized fields, auto-generated documents,
--   onboarding status aggregation, text search.
-- ============================================================================
-- NOTE: Requires Civic OS v0.15.0+ (Status Type System)
-- NOTE: Requires Civic OS v0.25.0+ (status_key for programmatic lookups)
-- ============================================================================

-- ============================================================================
-- STATUS TYPE SYSTEM CONFIGURATION
-- Uses centralized metadata.statuses instead of per-entity lookup tables
-- ============================================================================

-- Register status entity types
INSERT INTO metadata.status_types (entity_type, description) VALUES
  ('staff_onboarding', 'Onboarding progress for staff members'),
  ('staff_document', 'Document submission and review status'),
  ('time_off_request', 'Time off request approval status'),
  ('reimbursement', 'Reimbursement request approval status')
ON CONFLICT (entity_type) DO NOTHING;

-- staff_onboarding statuses
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal) VALUES
  ('staff_onboarding', 'Not Started', 'No documents submitted yet', '#6B7280', 1, TRUE, FALSE),
  ('staff_onboarding', 'Partial', 'Some documents approved, others pending', '#F59E0B', 2, FALSE, FALSE),
  ('staff_onboarding', 'All Approved', 'All required documents approved', '#22C55E', 3, FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- staff_document statuses
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal) VALUES
  ('staff_document', 'Pending', 'Awaiting document upload', '#6B7280', 1, TRUE, FALSE),
  ('staff_document', 'Submitted', 'Document uploaded, awaiting review', '#3B82F6', 2, FALSE, FALSE),
  ('staff_document', 'Approved', 'Document reviewed and approved', '#22C55E', 3, FALSE, TRUE),
  ('staff_document', 'Needs Revision', 'Document needs to be re-uploaded', '#EF4444', 4, FALSE, FALSE)
ON CONFLICT DO NOTHING;

-- time_off_request statuses
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal) VALUES
  ('time_off_request', 'Pending', 'Awaiting review', '#F59E0B', 1, TRUE, FALSE),
  ('time_off_request', 'Approved', 'Time off approved', '#22C55E', 2, FALSE, TRUE),
  ('time_off_request', 'Denied', 'Time off denied', '#EF4444', 3, FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- reimbursement statuses
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal) VALUES
  ('reimbursement', 'Pending', 'Awaiting review', '#F59E0B', 1, TRUE, FALSE),
  ('reimbursement', 'Approved', 'Reimbursement approved', '#22C55E', 2, FALSE, TRUE),
  ('reimbursement', 'Denied', 'Reimbursement denied', '#EF4444', 3, FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- TABLES
-- ============================================================================

-- 1. staff_roles: Reference table for position types
CREATE TABLE staff_roles (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. sites: Program locations (lead_id FK added after staff_members exists)
CREATE TABLE sites (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  address TEXT,
  lead_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. staff_members: Core entity
CREATE TABLE staff_members (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  email email_address NOT NULL UNIQUE,
  user_id UUID NULL REFERENCES metadata.civic_os_users(id),
  site_id BIGINT NOT NULL REFERENCES sites(id),
  role_id INT NOT NULL REFERENCES staff_roles(id),
  pay_rate MONEY,
  start_date DATE,
  onboarding_status_id INT NOT NULL DEFAULT get_initial_status('staff_onboarding') REFERENCES metadata.statuses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Add deferred FK for circular reference: sites.lead_id -> staff_members
ALTER TABLE sites ADD CONSTRAINT fk_sites_lead
  FOREIGN KEY (lead_id) REFERENCES staff_members(id);

-- 5. document_requirements: Templates for required docs
CREATE TABLE document_requirements (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  applies_to_roles TEXT[],
  requires_approval BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. staff_documents: Staff document submissions
CREATE TABLE staff_documents (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT,
  staff_member_id BIGINT NOT NULL REFERENCES staff_members(id),
  requirement_id BIGINT NOT NULL REFERENCES document_requirements(id),
  status_id INT NOT NULL DEFAULT get_initial_status('staff_document') REFERENCES metadata.statuses(id),
  file UUID NULL REFERENCES metadata.files(id),
  reviewer_notes TEXT,
  reviewed_by UUID NULL REFERENCES metadata.civic_os_users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(staff_member_id, requirement_id)
);

-- 7. time_entries: Clock in/out records
CREATE TABLE time_entries (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT,
  staff_member_id BIGINT NOT NULL REFERENCES staff_members(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('clock_in', 'clock_out')),
  entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  staff_name TEXT NOT NULL,
  site_name TEXT NOT NULL,
  edited_by UUID NULL REFERENCES metadata.civic_os_users(id),
  edit_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. time_off_requests
CREATE TABLE time_off_requests (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT GENERATED ALWAYS AS ('Time Off Request #' || id) STORED,
  staff_member_id BIGINT NOT NULL REFERENCES staff_members(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  status_id INT NOT NULL DEFAULT get_initial_status('time_off_request') REFERENCES metadata.statuses(id),
  response_notes TEXT,
  responded_by UUID NULL REFERENCES metadata.civic_os_users(id),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

-- 9. incident_reports
CREATE TABLE incident_reports (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT GENERATED ALWAYS AS ('Incident Report #' || id) STORED,
  reported_by_id BIGINT NOT NULL REFERENCES staff_members(id),
  site_id BIGINT NOT NULL REFERENCES sites(id),
  incident_date DATE NOT NULL,
  incident_time TIME,
  description TEXT NOT NULL,
  people_involved TEXT,
  action_taken TEXT,
  follow_up_needed BOOLEAN DEFAULT FALSE,
  follow_up_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. reimbursements
CREATE TABLE reimbursements (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT,
  staff_member_id BIGINT NOT NULL REFERENCES staff_members(id),
  amount MONEY NOT NULL,
  description TEXT NOT NULL,
  receipt UUID NULL REFERENCES metadata.files(id),
  status_id INT NOT NULL DEFAULT get_initial_status('reimbursement') REFERENCES metadata.statuses(id),
  response_notes TEXT,
  responded_by UUID NULL REFERENCES metadata.civic_os_users(id),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. offboarding_feedback
CREATE TABLE offboarding_feedback (
  id BIGSERIAL PRIMARY KEY,
  display_name TEXT,
  staff_member_id BIGINT NOT NULL UNIQUE REFERENCES staff_members(id),
  overall_rating INT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  what_went_well TEXT,
  what_could_improve TEXT,
  would_return BOOLEAN,
  additional_comments TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- FK INDEXES (CRITICAL - one per FK column)
-- PostgreSQL does NOT auto-index foreign keys. These are required for
-- inverse relationship queries and overall query performance.
-- ============================================================================

-- staff_members
CREATE INDEX idx_staff_members_site_id ON staff_members(site_id);
CREATE INDEX idx_staff_members_role_id ON staff_members(role_id);
CREATE INDEX idx_staff_members_user_id ON staff_members(user_id);
CREATE INDEX idx_staff_members_onboarding_status_id ON staff_members(onboarding_status_id);

-- sites
CREATE INDEX idx_sites_lead_id ON sites(lead_id);

-- staff_documents
CREATE INDEX idx_staff_documents_staff_member_id ON staff_documents(staff_member_id);
CREATE INDEX idx_staff_documents_requirement_id ON staff_documents(requirement_id);
CREATE INDEX idx_staff_documents_status_id ON staff_documents(status_id);
CREATE INDEX idx_staff_documents_file ON staff_documents(file);
CREATE INDEX idx_staff_documents_reviewed_by ON staff_documents(reviewed_by);

-- time_entries
CREATE INDEX idx_time_entries_staff_member_id ON time_entries(staff_member_id);
CREATE INDEX idx_time_entries_edited_by ON time_entries(edited_by);

-- time_off_requests
CREATE INDEX idx_time_off_requests_staff_member_id ON time_off_requests(staff_member_id);
CREATE INDEX idx_time_off_requests_status_id ON time_off_requests(status_id);
CREATE INDEX idx_time_off_requests_responded_by ON time_off_requests(responded_by);

-- incident_reports
CREATE INDEX idx_incident_reports_reported_by_id ON incident_reports(reported_by_id);
CREATE INDEX idx_incident_reports_site_id ON incident_reports(site_id);

-- reimbursements
CREATE INDEX idx_reimbursements_staff_member_id ON reimbursements(staff_member_id);
CREATE INDEX idx_reimbursements_status_id ON reimbursements(status_id);
CREATE INDEX idx_reimbursements_receipt ON reimbursements(receipt);
CREATE INDEX idx_reimbursements_responded_by ON reimbursements(responded_by);

-- offboarding_feedback
CREATE INDEX idx_offboarding_feedback_staff_member_id ON offboarding_feedback(staff_member_id);

-- ============================================================================
-- TIMESTAMP TRIGGERS
-- Standard Civic OS pattern: set_created_at() and set_updated_at() on all tables
-- ============================================================================

-- staff_roles
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON staff_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON staff_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- sites
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON sites
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON sites
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- staff_members
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON staff_members
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON staff_members
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- document_requirements
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON document_requirements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON document_requirements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- staff_documents
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON staff_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON staff_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- time_entries
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- time_off_requests
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON time_off_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON time_off_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- incident_reports
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON incident_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON incident_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- reimbursements
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON reimbursements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON reimbursements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- offboarding_feedback
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON offboarding_feedback
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON offboarding_feedback
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- HELPER FUNCTIONS (SECURITY DEFINER - bypass RLS)
-- ============================================================================

-- Get current user's staff_member ID from JWT
CREATE OR REPLACE FUNCTION get_current_staff_member_id()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  SELECT id INTO v_id FROM staff_members WHERE user_id = current_user_id();
  RETURN v_id;
END;
$$;

-- Get current user's site_id
CREATE OR REPLACE FUNCTION get_current_staff_member_site_id()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_site_id BIGINT;
BEGIN
  SELECT site_id INTO v_site_id FROM staff_members WHERE user_id = current_user_id();
  RETURN v_site_id;
END;
$$;

-- Check if current user is a site lead (of any site)
CREATE OR REPLACE FUNCTION current_user_is_site_lead()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM sites WHERE lead_id = get_current_staff_member_id()
  );
END;
$$;

-- Check if current user is lead of a specific site
CREATE OR REPLACE FUNCTION is_lead_of_site(p_site_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM sites WHERE id = p_site_id AND lead_id = get_current_staff_member_id()
  );
END;
$$;

-- Helper: get the site_id for a given staff_member_id
CREATE OR REPLACE FUNCTION get_site_id_for_staff(p_staff_member_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_site_id BIGINT;
BEGIN
  SELECT site_id INTO v_site_id FROM staff_members WHERE id = p_staff_member_id;
  RETURN v_site_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_current_staff_member_id() TO authenticated;
GRANT EXECUTE ON FUNCTION get_current_staff_member_site_id() TO authenticated;
GRANT EXECUTE ON FUNCTION current_user_is_site_lead() TO authenticated;
GRANT EXECUTE ON FUNCTION is_lead_of_site(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_site_id_for_staff(BIGINT) TO authenticated;

-- ============================================================================
-- BUSINESS LOGIC TRIGGERS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. trg_staff_documents_display_name
--    Sets display_name to "StaffName - DocumentName"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_staff_document_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
  v_doc_name TEXT;
BEGIN
  SELECT display_name INTO v_staff_name FROM staff_members WHERE id = NEW.staff_member_id;
  SELECT display_name INTO v_doc_name FROM document_requirements WHERE id = NEW.requirement_id;
  NEW.display_name := COALESCE(v_staff_name, 'Unknown') || ' - ' || COALESCE(v_doc_name, 'Unknown');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_staff_documents_display_name
  BEFORE INSERT OR UPDATE ON staff_documents
  FOR EACH ROW
  EXECUTE FUNCTION set_staff_document_display_name();

-- ---------------------------------------------------------------------------
-- 2. trg_time_entries_denormalize
--    Copies staff_name and site_name from related tables on INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION denormalize_time_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
  v_site_name TEXT;
BEGIN
  SELECT sm.display_name, s.display_name
    INTO v_staff_name, v_site_name
    FROM staff_members sm
    JOIN sites s ON s.id = sm.site_id
    WHERE sm.id = NEW.staff_member_id;

  NEW.staff_name := COALESCE(v_staff_name, 'Unknown');
  NEW.site_name := COALESCE(v_site_name, 'Unknown');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_time_entries_denormalize
  BEFORE INSERT ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION denormalize_time_entry();

-- ---------------------------------------------------------------------------
-- 3. trg_time_entries_display_name
--    Sets display_name to "StaffName - Clock In - Jan 15"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_time_entry_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.display_name := NEW.staff_name
    || ' - '
    || CASE NEW.entry_type
         WHEN 'clock_in' THEN 'Clock In'
         WHEN 'clock_out' THEN 'Clock Out'
         ELSE NEW.entry_type
       END
    || ' - '
    || TO_CHAR(NEW.entry_time, 'Mon DD');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_time_entries_display_name
  BEFORE INSERT OR UPDATE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION set_time_entry_display_name();

-- ---------------------------------------------------------------------------
-- 4. trg_reimbursements_display_name
--    Sets display_name to "StaffName - Description"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_reimbursement_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
BEGIN
  SELECT display_name INTO v_staff_name FROM staff_members WHERE id = NEW.staff_member_id;
  NEW.display_name := COALESCE(v_staff_name, 'Unknown') || ' - ' || COALESCE(NEW.description, 'Reimbursement');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reimbursements_display_name
  BEFORE INSERT OR UPDATE ON reimbursements
  FOR EACH ROW
  EXECUTE FUNCTION set_reimbursement_display_name();

-- ---------------------------------------------------------------------------
-- 5. trg_offboarding_display_name
--    Sets display_name to "StaffName - Feedback"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_offboarding_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_staff_name TEXT;
BEGIN
  SELECT display_name INTO v_staff_name FROM staff_members WHERE id = NEW.staff_member_id;
  NEW.display_name := COALESCE(v_staff_name, 'Unknown') || ' - Feedback';
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_offboarding_display_name
  BEFORE INSERT OR UPDATE ON offboarding_feedback
  FOR EACH ROW
  EXECUTE FUNCTION set_offboarding_display_name();

-- ---------------------------------------------------------------------------
-- 6. trg_auto_create_staff_documents
--    After a new staff member is inserted, create staff_document records for
--    each applicable document_requirement (based on applies_to_roles).
--    SECURITY DEFINER: reads document_requirements, writes staff_documents.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_create_staff_documents()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role_name TEXT;
BEGIN
  -- Look up the staff member's role display_name
  SELECT display_name INTO v_role_name FROM staff_roles WHERE id = NEW.role_id;

  -- For each requirement where applies_to_roles is empty/null (all roles)
  -- or the staff member's role is in the array, create a document record
  INSERT INTO staff_documents (staff_member_id, requirement_id)
  SELECT NEW.id, dr.id
  FROM document_requirements dr
  WHERE dr.applies_to_roles IS NULL
     OR array_length(dr.applies_to_roles, 1) IS NULL
     OR v_role_name = ANY(dr.applies_to_roles);

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_create_staff_documents
  AFTER INSERT ON staff_members
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_staff_documents();

-- ---------------------------------------------------------------------------
-- 7. trg_staff_document_status_guard
--    Combined trigger that:
--    (a) Prevents staff from changing status_id via direct API PATCH.
--        Direct PostgREST calls run as 'authenticated' — status_id is silently
--        reset to its old value so the rest of the UPDATE (file upload) proceeds.
--        SECURITY DEFINER RPCs run as 'postgres' and are allowed to change status.
--    (b) When a file is uploaded and current status is 'Pending' or
--        'Needs Revision', auto-sets status to 'Submitted'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION staff_document_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_pending_id INT;
  v_needs_revision_id INT;
  v_submitted_id INT;
BEGIN
  -- (a) Guard: if called from direct API, reset any user-supplied status change
  IF current_user = 'authenticated'
     AND NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    NEW.status_id := OLD.status_id;
  END IF;

  -- (b) Auto-submit: when file is uploaded, advance status to Submitted
  IF NEW.file IS NOT NULL AND (OLD.file IS NULL OR OLD.file IS DISTINCT FROM NEW.file) THEN
    SELECT id INTO v_pending_id FROM metadata.statuses
      WHERE entity_type = 'staff_document' AND display_name = 'Pending';
    SELECT id INTO v_needs_revision_id FROM metadata.statuses
      WHERE entity_type = 'staff_document' AND display_name = 'Needs Revision';
    SELECT id INTO v_submitted_id FROM metadata.statuses
      WHERE entity_type = 'staff_document' AND display_name = 'Submitted';

    IF NEW.status_id IN (v_pending_id, v_needs_revision_id) THEN
      NEW.status_id := v_submitted_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_staff_document_status_guard
  BEFORE UPDATE ON staff_documents
  FOR EACH ROW
  EXECUTE FUNCTION staff_document_status_guard();

-- ---------------------------------------------------------------------------
-- 8. trg_update_onboarding_status
--    Recalculates staff_members.onboarding_status_id based on document
--    approval progress. Fires AFTER INSERT/UPDATE/DELETE on staff_documents.
--    SECURITY DEFINER: updates staff_members bypassing RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_onboarding_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_staff_member_id BIGINT;
  v_total INT;
  v_approved INT;
  v_approved_status_id INT;
  v_new_onboarding_id INT;
BEGIN
  -- Determine which staff member to recalculate
  IF TG_OP = 'DELETE' THEN
    v_staff_member_id := OLD.staff_member_id;
  ELSE
    v_staff_member_id := NEW.staff_member_id;
  END IF;

  -- Get the 'Approved' status ID for staff_document
  SELECT id INTO v_approved_status_id FROM metadata.statuses
    WHERE entity_type = 'staff_document' AND display_name = 'Approved';

  -- Count total documents that require approval for this staff member
  SELECT COUNT(*) INTO v_total
  FROM staff_documents sd
  JOIN document_requirements dr ON dr.id = sd.requirement_id
  WHERE sd.staff_member_id = v_staff_member_id
    AND dr.requires_approval = TRUE;

  -- Count how many of those are approved
  SELECT COUNT(*) INTO v_approved
  FROM staff_documents sd
  JOIN document_requirements dr ON dr.id = sd.requirement_id
  WHERE sd.staff_member_id = v_staff_member_id
    AND dr.requires_approval = TRUE
    AND sd.status_id = v_approved_status_id;

  -- Determine onboarding status
  IF v_total = 0 OR v_approved = 0 THEN
    -- No documents or none approved -> 'Not Started'
    SELECT id INTO v_new_onboarding_id FROM metadata.statuses
      WHERE entity_type = 'staff_onboarding' AND display_name = 'Not Started';
  ELSIF v_approved < v_total THEN
    -- Some but not all approved -> 'Partial'
    SELECT id INTO v_new_onboarding_id FROM metadata.statuses
      WHERE entity_type = 'staff_onboarding' AND display_name = 'Partial';
  ELSE
    -- All approved -> 'All Approved'
    SELECT id INTO v_new_onboarding_id FROM metadata.statuses
      WHERE entity_type = 'staff_onboarding' AND display_name = 'All Approved';
  END IF;

  -- Update the staff member's onboarding status
  UPDATE staff_members
  SET onboarding_status_id = v_new_onboarding_id
  WHERE id = v_staff_member_id;

  -- Return appropriate row for trigger
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER trg_update_onboarding_status
  AFTER INSERT OR UPDATE OR DELETE ON staff_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_onboarding_status();

-- Grant execute on trigger functions that authenticated users may invoke indirectly
GRANT EXECUTE ON FUNCTION set_staff_document_display_name() TO authenticated;
GRANT EXECUTE ON FUNCTION denormalize_time_entry() TO authenticated;
GRANT EXECUTE ON FUNCTION set_time_entry_display_name() TO authenticated;
GRANT EXECUTE ON FUNCTION set_reimbursement_display_name() TO authenticated;
GRANT EXECUTE ON FUNCTION set_offboarding_display_name() TO authenticated;
GRANT EXECUTE ON FUNCTION auto_create_staff_documents() TO authenticated;
GRANT EXECUTE ON FUNCTION staff_document_status_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION update_onboarding_status() TO authenticated;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- RLS is NOT enabled on reference tables (staff_roles, sites, document_requirements)
-- since all authenticated users can read these freely.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- staff_members
-- Own record, site lead sees site members, manager/admin sees all
-- ---------------------------------------------------------------------------
ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_staff_members ON staff_members
  FOR SELECT TO authenticated
  USING (
    id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_staff_members ON staff_members
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_staff_members ON staff_members
  FOR UPDATE TO authenticated
  USING (
    id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_staff_members ON staff_members
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ---------------------------------------------------------------------------
-- staff_documents
-- Own records (via staff_member_id), site lead sees site, manager/admin sees all
-- ---------------------------------------------------------------------------
ALTER TABLE staff_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_staff_documents ON staff_documents
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_staff_documents ON staff_documents
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_staff_documents ON staff_documents
  FOR UPDATE TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_staff_documents ON staff_documents
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ---------------------------------------------------------------------------
-- time_entries
-- Own records, site lead sees site, manager/admin sees all
-- ---------------------------------------------------------------------------
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_time_entries ON time_entries
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_time_entries ON time_entries
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_time_entries ON time_entries
  FOR UPDATE TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_time_entries ON time_entries
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ---------------------------------------------------------------------------
-- time_off_requests
-- Own records, site lead sees site, manager/admin sees all
-- ---------------------------------------------------------------------------
ALTER TABLE time_off_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_time_off_requests ON time_off_requests
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_time_off_requests ON time_off_requests
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_time_off_requests ON time_off_requests
  FOR UPDATE TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_time_off_requests ON time_off_requests
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ---------------------------------------------------------------------------
-- incident_reports
-- Uses reported_by_id instead of staff_member_id; also checks site lead via site_id
-- ---------------------------------------------------------------------------
ALTER TABLE incident_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_incident_reports ON incident_reports
  FOR SELECT TO authenticated
  USING (
    reported_by_id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_incident_reports ON incident_reports
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_incident_reports ON incident_reports
  FOR UPDATE TO authenticated
  USING (
    reported_by_id = get_current_staff_member_id()
    OR is_lead_of_site(site_id)
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_incident_reports ON incident_reports
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ---------------------------------------------------------------------------
-- reimbursements
-- Own records, site lead sees site, manager/admin sees all
-- ---------------------------------------------------------------------------
ALTER TABLE reimbursements ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_reimbursements ON reimbursements
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_reimbursements ON reimbursements
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_reimbursements ON reimbursements
  FOR UPDATE TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR is_lead_of_site(get_site_id_for_staff(staff_member_id))
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_reimbursements ON reimbursements
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ---------------------------------------------------------------------------
-- offboarding_feedback
-- Staff sees own only. Managers/admins see all. Site leads do NOT see others.
-- ---------------------------------------------------------------------------
ALTER TABLE offboarding_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_offboarding_feedback ON offboarding_feedback
  FOR SELECT TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY insert_offboarding_feedback ON offboarding_feedback
  FOR INSERT TO authenticated
  WITH CHECK (TRUE);

CREATE POLICY update_offboarding_feedback ON offboarding_feedback
  FOR UPDATE TO authenticated
  USING (
    staff_member_id = get_current_staff_member_id()
    OR 'manager' = ANY(get_user_roles()) OR is_admin()
  );

CREATE POLICY delete_offboarding_feedback ON offboarding_feedback
  FOR DELETE TO authenticated
  USING ('manager' = ANY(get_user_roles()) OR is_admin());

-- ============================================================================
-- POSTGRESQL PERMISSIONS
-- ============================================================================
-- NOTE: Fine-grained RBAC (admin, editor, user roles) is handled by the
-- metadata.permissions system in a separate permissions SQL file.
-- ============================================================================

-- Reference tables: all authenticated (and anonymous) can read
GRANT SELECT ON staff_roles TO web_anon, authenticated;
GRANT SELECT ON sites TO web_anon, authenticated;
GRANT SELECT ON document_requirements TO web_anon, authenticated;

-- CRUD tables: authenticated only (RLS controls row-level access)
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON time_off_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON incident_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON offboarding_feedback TO authenticated;

-- Manager/admin can also modify reference tables
GRANT INSERT, UPDATE, DELETE ON staff_roles TO authenticated;
GRANT INSERT, UPDATE, DELETE ON sites TO authenticated;
GRANT INSERT, UPDATE, DELETE ON document_requirements TO authenticated;

-- Sequences: authenticated users need these for INSERTs
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ============================================================================
-- FULL-TEXT SEARCH
-- ============================================================================

ALTER TABLE staff_members ADD COLUMN civic_os_text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', display_name || ' ' || email::text)
  ) STORED;
CREATE INDEX idx_staff_members_search ON staff_members USING GIN(civic_os_text_search);

ALTER TABLE incident_reports ADD COLUMN civic_os_text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', description || ' ' || COALESCE(people_involved, '') || ' ' || COALESCE(action_taken, ''))
  ) STORED;
CREATE INDEX idx_incident_reports_search ON incident_reports USING GIN(civic_os_text_search);

-- ============================================================================
-- METADATA CONFIGURATION
-- ============================================================================

-- Entity descriptions
UPDATE metadata.entities SET description = 'Position types for staff members' WHERE table_name = 'staff_roles';
UPDATE metadata.entities SET description = 'Summer program locations' WHERE table_name = 'sites';
UPDATE metadata.entities SET description = 'Staff members in the summer education program' WHERE table_name = 'staff_members';
UPDATE metadata.entities SET description = 'Required documents that staff must submit' WHERE table_name = 'document_requirements';
UPDATE metadata.entities SET description = 'Document submissions from staff members' WHERE table_name = 'staff_documents';
UPDATE metadata.entities SET description = 'Clock in/out time tracking records' WHERE table_name = 'time_entries';
UPDATE metadata.entities SET description = 'Staff requests for time off' WHERE table_name = 'time_off_requests';
UPDATE metadata.entities SET description = 'Safety and behavioral incident reports' WHERE table_name = 'incident_reports';
UPDATE metadata.entities SET description = 'Staff expense reimbursement requests' WHERE table_name = 'reimbursements';
UPDATE metadata.entities SET description = 'End-of-program feedback from departing staff' WHERE table_name = 'offboarding_feedback';

-- Search fields configuration
UPDATE metadata.entities SET search_fields = ARRAY['display_name', 'email'] WHERE table_name = 'staff_members';
UPDATE metadata.entities SET search_fields = ARRAY['description', 'people_involved', 'action_taken'] WHERE table_name = 'incident_reports';

-- ============================================================================
-- CONSTRAINT ERROR MESSAGES
-- ============================================================================

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'staff_documents_staff_member_id_requirement_id_key',
  'staff_documents',
  'requirement_id',
  'This document requirement has already been assigned to this staff member.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'offboarding_feedback_staff_member_id_key',
  'offboarding_feedback',
  'staff_member_id',
  'Offboarding feedback has already been submitted for this staff member.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'staff_members_email_key',
  'staff_members',
  'email',
  'A staff member with this email address already exists.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'time_off_requests_check',
  'time_off_requests',
  'end_date',
  'End date must be on or after the start date.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'offboarding_feedback_overall_rating_check',
  'offboarding_feedback',
  'overall_rating',
  'Overall rating must be between 1 and 5.'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES (
  'time_entries_entry_type_check',
  'time_entries',
  'entry_type',
  'Entry type must be either "clock_in" or "clock_out".'
)
ON CONFLICT (constraint_name) DO UPDATE
SET error_message = EXCLUDED.error_message,
    table_name = EXCLUDED.table_name,
    column_name = EXCLUDED.column_name;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
