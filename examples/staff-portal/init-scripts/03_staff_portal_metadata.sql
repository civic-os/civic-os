-- =====================================================
-- Staff Portal - Metadata Enhancements
-- =====================================================
-- Configures display names, descriptions, property visibility,
-- sorting/filtering, status types, and validations for the staff portal UI

-- =====================================================
-- ENTITY METADATA (Display Names, Descriptions, Sort Order)
-- =====================================================

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('staff_roles', 'Staff Roles', 'Position types for program staff', 1)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('sites', 'Sites', 'Program locations', 2)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('staff_members', 'Staff Members', 'Program staff and their onboarding status', 3)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('document_requirements', 'Document Requirements', 'Required documents by role', 4)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('staff_documents', 'Staff Documents', 'Document submissions and review status', 5)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('time_entries', 'Time Entries', 'Clock-in and clock-out records', 6)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('time_off_requests', 'Time Off Requests', 'Staff time-off submissions', 7)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('incident_reports', 'Incident Reports', 'Documented incidents', 8)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('reimbursements', 'Reimbursements', 'Expense reimbursement requests', 9)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO metadata.entities (table_name, display_name, description, sort_order)
VALUES ('offboarding_feedback', 'Offboarding Feedback', 'End-of-program staff feedback', 10)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

-- =====================================================
-- PROPERTY METADATA (staff_roles)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('staff_roles', 'display_name', 'Role Name', 1, 1, TRUE, TRUE, TRUE, TRUE),
  ('staff_roles', 'sort_order', 'Display Order', 2, 1, TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (sites)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('sites', 'display_name', 'Site Name', 1, 1, TRUE, TRUE, TRUE, TRUE),
  ('sites', 'lead_id', 'Site Lead', 2, 1, TRUE, FALSE, TRUE, TRUE),
  ('sites', 'address', 'Address', 3, 2, TRUE, TRUE, TRUE, TRUE),
  ('sites', 'created_at', 'Created', 10, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (staff_members)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('staff_members', 'display_name', 'Full Name', NULL, 1, 1, TRUE, TRUE, TRUE, TRUE),
  ('staff_members', 'email', 'Email', NULL, 2, 1, TRUE, TRUE, TRUE, TRUE),
  ('staff_members', 'site_id', 'Site', NULL, 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('staff_members', 'role_id', 'Staff Role', NULL, 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('staff_members', 'onboarding_status_id', 'Onboarding', NULL, 5, 1, TRUE, FALSE, FALSE, TRUE),
  ('staff_members', 'pay_rate', 'Pay Rate', NULL, 6, 1, FALSE, TRUE, TRUE, TRUE),
  ('staff_members', 'start_date', 'Start Date', NULL, 7, 1, FALSE, TRUE, TRUE, TRUE),
  ('staff_members', 'user_id', 'User Account', NULL, 8, 1, FALSE, TRUE, TRUE, TRUE),
  ('staff_members', 'created_at', 'Created', NULL, 20, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (document_requirements)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('document_requirements', 'display_name', 'Document Name', NULL, 1, 1, TRUE, TRUE, TRUE, TRUE),
  ('document_requirements', 'description', 'Instructions', NULL, 2, 2, FALSE, TRUE, TRUE, TRUE),
  ('document_requirements', 'applies_to_roles', 'Applies To', NULL, 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('document_requirements', 'requires_approval', 'Requires Approval', NULL, 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('document_requirements', 'sort_order', 'Display Order', NULL, 5, 1, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (staff_documents)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('staff_documents', 'display_name', 'Document', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('staff_documents', 'staff_member_id', 'Staff Member', 2, 1, TRUE, FALSE, FALSE, TRUE),
  ('staff_documents', 'requirement_id', 'Requirement', 3, 1, TRUE, FALSE, FALSE, TRUE),
  ('staff_documents', 'status_id', 'Status', 4, 1, TRUE, FALSE, FALSE, TRUE),
  ('staff_documents', 'file', 'Document File', 5, 2, FALSE, FALSE, TRUE, TRUE),
  ('staff_documents', 'reviewer_notes', 'Reviewer Notes', 6, 2, FALSE, FALSE, TRUE, TRUE),
  ('staff_documents', 'reviewed_by', 'Reviewed By', 7, 1, FALSE, FALSE, FALSE, TRUE),
  ('staff_documents', 'reviewed_at', 'Reviewed At', 8, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (time_entries)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('time_entries', 'display_name', 'Entry', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('time_entries', 'staff_member_id', 'Staff Member', 2, 1, TRUE, TRUE, TRUE, TRUE),
  ('time_entries', 'entry_type', 'Type', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('time_entries', 'entry_time', 'Time', 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('time_entries', 'staff_name', 'Staff Name', 5, 1, FALSE, FALSE, FALSE, TRUE),
  ('time_entries', 'site_name', 'Site Name', 6, 1, FALSE, FALSE, FALSE, TRUE),
  ('time_entries', 'edited_by', 'Edited By', 7, 1, FALSE, FALSE, FALSE, TRUE),
  ('time_entries', 'edit_reason', 'Edit Reason', 8, 2, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (time_off_requests)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('time_off_requests', 'display_name', 'Request', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('time_off_requests', 'staff_member_id', 'Staff Member', 2, 1, TRUE, TRUE, FALSE, TRUE),
  ('time_off_requests', 'start_date', 'Start Date', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('time_off_requests', 'end_date', 'End Date', 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('time_off_requests', 'reason', 'Reason', 5, 2, FALSE, TRUE, TRUE, TRUE),
  ('time_off_requests', 'status_id', 'Status', 6, 1, TRUE, FALSE, FALSE, TRUE),
  ('time_off_requests', 'response_notes', 'Response Notes', 7, 2, FALSE, FALSE, TRUE, TRUE),
  ('time_off_requests', 'responded_by', 'Responded By', 8, 1, FALSE, FALSE, FALSE, TRUE),
  ('time_off_requests', 'responded_at', 'Responded At', 9, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (incident_reports)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('incident_reports', 'display_name', 'Report', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('incident_reports', 'reported_by_id', 'Reported By', 2, 1, TRUE, TRUE, FALSE, TRUE),
  ('incident_reports', 'site_id', 'Site', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('incident_reports', 'incident_date', 'Date', 4, 1, TRUE, TRUE, TRUE, TRUE),
  ('incident_reports', 'incident_time', 'Time of Day', 5, 1, FALSE, TRUE, TRUE, TRUE),
  ('incident_reports', 'description', 'Description', 6, 2, FALSE, TRUE, TRUE, TRUE),
  ('incident_reports', 'people_involved', 'People Involved', 7, 2, FALSE, TRUE, TRUE, TRUE),
  ('incident_reports', 'action_taken', 'Action Taken', 8, 2, FALSE, TRUE, TRUE, TRUE),
  ('incident_reports', 'follow_up_needed', 'Follow-Up Needed', 9, 1, TRUE, TRUE, TRUE, TRUE),
  ('incident_reports', 'follow_up_notes', 'Follow-Up Notes', 10, 2, FALSE, FALSE, TRUE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (reimbursements)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('reimbursements', 'display_name', 'Reimbursement', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('reimbursements', 'staff_member_id', 'Staff Member', 2, 1, TRUE, TRUE, FALSE, TRUE),
  ('reimbursements', 'amount', 'Amount', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('reimbursements', 'description', 'Description', 4, 2, TRUE, TRUE, TRUE, TRUE),
  ('reimbursements', 'receipt', 'Receipt', 5, 1, FALSE, TRUE, TRUE, TRUE),
  ('reimbursements', 'status_id', 'Status', 6, 1, TRUE, FALSE, FALSE, TRUE),
  ('reimbursements', 'response_notes', 'Response Notes', 7, 2, FALSE, FALSE, TRUE, TRUE),
  ('reimbursements', 'responded_by', 'Responded By', 8, 1, FALSE, FALSE, FALSE, TRUE),
  ('reimbursements', 'responded_at', 'Responded At', 9, 1, FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- PROPERTY METADATA (offboarding_feedback)
-- =====================================================

INSERT INTO metadata.properties (table_name, column_name, display_name, sort_order, column_width, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('offboarding_feedback', 'display_name', 'Feedback', 1, 1, TRUE, FALSE, FALSE, TRUE),
  ('offboarding_feedback', 'staff_member_id', 'Staff Member', 2, 1, TRUE, TRUE, FALSE, TRUE),
  ('offboarding_feedback', 'overall_rating', 'Overall Rating', 3, 1, TRUE, TRUE, TRUE, TRUE),
  ('offboarding_feedback', 'what_went_well', 'What Went Well', 4, 2, FALSE, TRUE, TRUE, TRUE),
  ('offboarding_feedback', 'what_could_improve', 'What Could Improve', 5, 2, FALSE, TRUE, TRUE, TRUE),
  ('offboarding_feedback', 'would_return', 'Would Return', 6, 1, TRUE, TRUE, TRUE, TRUE),
  ('offboarding_feedback', 'additional_comments', 'Additional Comments', 7, 2, FALSE, TRUE, TRUE, TRUE),
  ('offboarding_feedback', 'submitted_at', 'Submitted', 8, 1, TRUE, FALSE, FALSE, TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order,
  column_width = EXCLUDED.column_width,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- =====================================================
-- STATUS ENTITY TYPE CONFIGURATION
-- =====================================================
-- Configure status_id columns to use the Status Type System
-- This tells the frontend to render status dropdowns via get_statuses_for_entity RPC

UPDATE metadata.properties SET status_entity_type = 'staff_onboarding'
WHERE table_name = 'staff_members' AND column_name = 'onboarding_status_id';

UPDATE metadata.properties SET status_entity_type = 'staff_document'
WHERE table_name = 'staff_documents' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'time_off_request'
WHERE table_name = 'time_off_requests' AND column_name = 'status_id';

UPDATE metadata.properties SET status_entity_type = 'reimbursement'
WHERE table_name = 'reimbursements' AND column_name = 'status_id';

-- =====================================================
-- FILTERABLE & SORTABLE PROPERTIES
-- =====================================================

-- staff_members: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'staff_members' AND column_name IN ('site_id', 'role_id', 'onboarding_status_id');

-- staff_members: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'staff_members' AND column_name IN ('display_name', 'start_date', 'created_at');

-- staff_documents: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'staff_documents' AND column_name IN ('staff_member_id', 'requirement_id', 'status_id');

-- staff_documents: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'staff_documents' AND column_name IN ('display_name', 'created_at');

-- time_entries: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'time_entries' AND column_name IN ('staff_member_id', 'entry_type');

-- time_entries: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'time_entries' AND column_name IN ('entry_time', 'staff_name');

-- time_off_requests: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'time_off_requests' AND column_name IN ('staff_member_id', 'status_id');

-- time_off_requests: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'time_off_requests' AND column_name IN ('start_date', 'created_at');

-- incident_reports: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'incident_reports' AND column_name IN ('site_id', 'reported_by_id', 'follow_up_needed');

-- incident_reports: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'incident_reports' AND column_name IN ('incident_date', 'created_at');

-- reimbursements: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'reimbursements' AND column_name IN ('staff_member_id', 'status_id');

-- reimbursements: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'reimbursements' AND column_name IN ('amount', 'created_at');

-- offboarding_feedback: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'offboarding_feedback' AND column_name IN ('staff_member_id', 'overall_rating', 'would_return');

-- offboarding_feedback: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'offboarding_feedback' AND column_name IN ('overall_rating', 'submitted_at');

-- document_requirements: filterable columns
UPDATE metadata.properties SET filterable = TRUE
WHERE table_name = 'document_requirements' AND column_name = 'requires_approval';

-- document_requirements: sortable columns
UPDATE metadata.properties SET sortable = TRUE
WHERE table_name = 'document_requirements' AND column_name = 'sort_order';

-- NOTE: Default sort is handled by the frontend's List page using the first
-- sortable column. The metadata.entities table does not have default_sort columns.

-- =====================================================
-- VALIDATIONS
-- =====================================================

INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message) VALUES
  ('staff_members', 'display_name', 'required', 'true', 'Full name is required'),
  ('staff_members', 'display_name', 'minLength', '2', 'Name must be at least 2 characters'),
  ('staff_members', 'email', 'required', 'true', 'Email address is required'),
  ('reimbursements', 'amount', 'min', '0.01', 'Amount must be positive'),
  ('reimbursements', 'amount', 'max', '5000', 'Amount cannot exceed $5,000'),
  ('reimbursements', 'description', 'required', 'true', 'Description is required'),
  ('reimbursements', 'description', 'minLength', '5', 'Description must be at least 5 characters'),
  ('offboarding_feedback', 'overall_rating', 'min', '1', 'Rating must be between 1 and 5'),
  ('offboarding_feedback', 'overall_rating', 'max', '5', 'Rating must be between 1 and 5'),
  ('incident_reports', 'description', 'required', 'true', 'Description is required'),
  ('incident_reports', 'description', 'minLength', '10', 'Please provide a detailed description (at least 10 characters)')
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE SET
  validation_value = EXCLUDED.validation_value,
  error_message = EXCLUDED.error_message;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
