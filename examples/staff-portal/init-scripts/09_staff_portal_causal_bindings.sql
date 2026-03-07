-- ============================================================================
-- Staff Portal: Causal Bindings (v0.33.0)
-- ============================================================================
-- Declares the event-to-function bindings for the staff portal.
-- Four status entity types with distinct workflows:
--   staff_document: Pending → Submitted → Approved/Needs Revision (review loop)
--   staff_onboarding: Computed from child document approval progress
--   time_off_request: Pending → Approved/Denied
--   reimbursement: Pending → Approved/Denied
--
-- Note: staff_task transitions are in 10_staff_tasks.sql (runs after statuses are created)
--
-- Note: Uses direct INSERTs (not add_status_transition/add_property_change_trigger
-- helper RPCs) because init scripts run as postgres superuser without JWT claims.
-- The helpers are for runtime use in authenticated PostgREST contexts.
--
-- Notable patterns:
--   - staff_onboarding is a COMPUTED status (no direct transitions)
--   - staff_document has a trigger-driven auto-submit on file upload
--   - staff_document has a status guard preventing direct status edits via API
-- ============================================================================


-- ============================================================================
-- 1. STATUS TRANSITIONS: staff_document
-- ============================================================================
-- State machine with review loop:
--   Pending ──→ Submitted (via file upload trigger or submit_staff_document RPC)
--   Submitted ──→ Approved (terminal, via approve_staff_document RPC)
--   Submitted ──→ Needs Revision (via request_document_revision RPC)
--   Needs Revision ──→ Submitted (via file re-upload trigger or submit_staff_document RPC)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('staff_document', get_status_id('staff_document', 'pending'), get_status_id('staff_document', 'submitted'),
     'submit_staff_document', 'Submit', 'Submit document for review. Also triggered automatically when a file is uploaded.'),
    ('staff_document', get_status_id('staff_document', 'submitted'), get_status_id('staff_document', 'approved'),
     'approve_staff_document', 'Approve', 'Approve the submitted document. Triggers onboarding status recalculation.'),
    ('staff_document', get_status_id('staff_document', 'submitted'), get_status_id('staff_document', 'needs_revision'),
     'request_document_revision', 'Request Revision', 'Send document back for revision with reviewer notes.'),
    ('staff_document', get_status_id('staff_document', 'needs_revision'), get_status_id('staff_document', 'submitted'),
     'submit_staff_document', 'Resubmit', 'Resubmit document after revision. Also triggered automatically when file is re-uploaded.');


-- ============================================================================
-- 2. STATUS TRANSITIONS: staff_onboarding (COMPUTED - no direct transitions)
-- ============================================================================
-- The staff_onboarding status is NOT directly transitioned by any RPC.
-- Instead, it is recomputed by update_onboarding_status() trigger whenever
-- staff_documents change. We document the possible states but there are
-- no status_transition entries because the transitions are computed.
--
-- Not Started ──→ Partial    (when first document is approved)
-- Partial ──→ All Approved   (when all required documents are approved)
-- All Approved ──→ Partial   (if an approved document is un-approved)
-- Partial ──→ Not Started    (if all approved documents are removed)


-- ============================================================================
-- 3. STATUS TRANSITIONS: time_off_request
-- ============================================================================
-- Simple approve/deny workflow:
--   Pending ──→ Approved (terminal, via approve_time_off RPC)
--   Pending ──→ Denied   (terminal, via deny_time_off RPC)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('time_off_request', get_status_id('time_off_request', 'pending'), get_status_id('time_off_request', 'approved'),
     'approve_time_off', 'Approve', 'Approve time off request. Prevents self-approval.'),
    ('time_off_request', get_status_id('time_off_request', 'pending'), get_status_id('time_off_request', 'denied'),
     'deny_time_off', 'Deny', 'Deny time off request. Optional response_notes parameter. Prevents self-denial.');


-- ============================================================================
-- 4. STATUS TRANSITIONS: reimbursement
-- ============================================================================
-- Simple approve/deny workflow:
--   Pending ──→ Approved (terminal, via approve_reimbursement RPC)
--   Pending ──→ Denied   (terminal, via deny_reimbursement RPC)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('reimbursement', get_status_id('reimbursement', 'pending'), get_status_id('reimbursement', 'approved'),
     'approve_reimbursement', 'Approve', 'Approve reimbursement. Prevents self-approval.'),
    ('reimbursement', get_status_id('reimbursement', 'pending'), get_status_id('reimbursement', 'denied'),
     'deny_reimbursement', 'Deny', 'Deny reimbursement. Optional response_notes parameter. Prevents self-denial.');


-- ============================================================================
-- 5. PROPERTY CHANGE TRIGGERS: staff_documents.status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    -- Status guard: prevents direct status edits via PostgREST API
    ('staff_documents', 'status_id', 'any', NULL,
     'staff_document_status_guard', 'Guard against direct status edits',
     'BEFORE trigger: silently resets status_id to old value if caller is authenticated role (not SECURITY DEFINER RPC). Prevents end-run around workflow RPCs.'),
    -- Auto-submit on file upload
    ('staff_documents', 'file', 'set', NULL,
     'staff_document_status_guard', 'Auto-submit on file upload',
     'BEFORE trigger (same function): when file is uploaded and status is Pending or Needs Revision, automatically transitions to Submitted.'),
    -- Recalculate parent onboarding status
    ('staff_documents', 'status_id', 'any', NULL,
     'update_onboarding_status', 'Recalculate onboarding progress',
     'AFTER trigger: recalculates staff_members.onboarding_status_id based on document approval progress (Not Started / Partial / All Approved).'),
    -- Notification: document needs revision
    ('staff_documents', 'status_id', 'changed_to', get_status_id('staff_document', 'needs_revision')::TEXT,
     'notify_document_status_change', 'Notify staff on revision needed',
     'AFTER trigger: sends document_needs_revision notification to the staff member.'),
    -- Notification: document approved
    ('staff_documents', 'status_id', 'changed_to', get_status_id('staff_document', 'approved')::TEXT,
     'notify_document_status_change', 'Notify staff on approval',
     'AFTER trigger: sends document_approved notification to the staff member.');


-- ============================================================================
-- 6. PROPERTY CHANGE TRIGGERS: time_off_requests.status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    ('time_off_requests', 'status_id', 'changed_to', get_status_id('time_off_request', 'approved')::TEXT,
     'notify_time_off_status_change', 'Notify staff on time off approved',
     'AFTER trigger: sends time_off_approved notification to the staff member.'),
    ('time_off_requests', 'status_id', 'changed_to', get_status_id('time_off_request', 'denied')::TEXT,
     'notify_time_off_status_change', 'Notify staff on time off denied',
     'AFTER trigger: sends time_off_denied notification to the staff member.');


-- ============================================================================
-- 7. PROPERTY CHANGE TRIGGERS: reimbursements.status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    ('reimbursements', 'status_id', 'changed_to', get_status_id('reimbursement', 'approved')::TEXT,
     'notify_reimbursement_status_change', 'Notify staff on reimbursement approved',
     'AFTER trigger: sends reimbursement_approved notification to the staff member.'),
    ('reimbursements', 'status_id', 'changed_to', get_status_id('reimbursement', 'denied')::TEXT,
     'notify_reimbursement_status_change', 'Notify staff on reimbursement denied',
     'AFTER trigger: sends reimbursement_denied notification to the staff member.');


-- ============================================================================
-- 8. PROPERTY CHANGE TRIGGERS: staff_members.onboarding_status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    ('staff_members', 'onboarding_status_id', 'changed_to', get_status_id('staff_onboarding', 'all_approved')::TEXT,
     'notify_onboarding_complete', 'Notify managers on onboarding complete',
     'AFTER trigger: sends onboarding_complete notification to all managers and admins when all documents are approved.');
