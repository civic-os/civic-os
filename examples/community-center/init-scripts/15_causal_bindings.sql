-- ============================================================================
-- Community Center: Causal Bindings (v0.33.0)
-- ============================================================================
-- Declares the event-to-function bindings that exist in this example's
-- triggers and RPCs. This makes the automation queryable from metadata
-- rather than buried in PL/pgSQL function bodies.
--
-- Note: Uses direct INSERTs (not add_status_transition/add_property_change_trigger
-- helper RPCs) because init scripts run as postgres superuser without JWT claims.
-- The helpers are for runtime use in authenticated PostgREST contexts.
--
-- Status transitions: reservation_request workflow (Pending → Approved/Denied/Cancelled)
-- Property change triggers: status_id changes that fire notifications, create/delete
--   reservations, stamp review timestamps, and create audit notes.
-- ============================================================================


-- ============================================================================
-- 1. STATUS TRANSITIONS: reservation_request
-- ============================================================================
-- State machine:
--   Pending ──→ Approved   (approve_reservation_request)
--   Pending ──→ Denied     (deny_reservation_request)
--   Pending ──→ Cancelled  (cancel_reservation_request)
--   Approved ──→ Cancelled (cancel_reservation_request)
--   Denied ──→ (terminal)
--   Cancelled ──→ (terminal)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'approved'),
     'approve_reservation_request', 'Approve', 'Approve the reservation request. Creates a linked reservation record.'),
    ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'denied'),
     'deny_reservation_request', 'Deny', 'Deny the reservation request.'),
    ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'cancelled'),
     'cancel_reservation_request', 'Cancel', 'Cancel a pending reservation request.'),
    ('reservation_request', get_status_id('reservation_request', 'approved'), get_status_id('reservation_request', 'cancelled'),
     'cancel_reservation_request', 'Cancel', 'Cancel an already-approved reservation. Deletes the linked reservation record.');


-- ============================================================================
-- 2. PROPERTY CHANGE TRIGGERS: reservation_requests.status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    -- Approval creates a linked reservation
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'approved')::TEXT,
     'sync_reservation_request_to_reservation', 'Create linked reservation on approval',
     'BEFORE trigger: creates a row in reservations table with the request details.'),
    -- Cancellation deletes the linked reservation
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'cancelled')::TEXT,
     'handle_reservation_request_cancellation', 'Delete linked reservation on cancellation',
     'AFTER trigger: deletes the linked reservation and NULLs reservation_id.'),
    -- Review timestamp auto-set on approval or denial
    ('reservation_requests', 'status_id', 'any', NULL,
     'set_reviewed_at_timestamp', 'Stamp reviewed_at on status review',
     'BEFORE trigger: sets reviewed_at = NOW() when status changes from Pending to Approved or Denied.'),
    -- Status change audit note
    ('reservation_requests', 'status_id', 'any', NULL,
     'add_status_change_note', 'Create audit note on status change',
     'AFTER trigger: creates a system Entity Note recording the status transition.'),
    -- Notification: approved
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'approved')::TEXT,
     'notify_reservation_request_approved', 'Notify requester on approval',
     'AFTER trigger: sends reservation_request_approved email to the requester.'),
    -- Notification: denied
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'denied')::TEXT,
     'notify_reservation_request_denied', 'Notify requester on denial',
     'AFTER trigger: sends reservation_request_denied email to the requester.'),
    -- Notification: cancelled
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'cancelled')::TEXT,
     'notify_reservation_request_cancelled', 'Notify staff on cancellation',
     'AFTER trigger: sends reservation_request_cancelled email to all editor/admin users.');
