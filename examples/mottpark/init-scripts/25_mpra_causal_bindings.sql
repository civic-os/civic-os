-- ============================================================================
-- Mott Park Recreation Association: Causal Bindings (v0.33.0)
-- ============================================================================
-- Declares the event-to-function bindings for the MPRA reservation system.
-- This is the most complex example, with two status entity types and deep
-- trigger chains including payment automation, calendar sync, and notifications.
--
-- Note: Uses direct INSERTs (not add_status_transition/add_property_change_trigger
-- helper RPCs) because init scripts run as postgres superuser without JWT claims.
-- The helpers are for runtime use in authenticated PostgREST contexts.
--
-- Status transitions:
--   reservation_request: Pending → Approved/Denied/Cancelled → Completed → Closed
--   reservation_payment: Pending → Paid/Waived/Cancelled; Paid → Refunded
--
-- Property change triggers:
--   reservation_requests.status_id: pricing, payments, calendar, notifications, audit
--   reservation_payments.status_id: display name, overdue tracking, parent sync
--   payments.transactions.status: Stripe webhook → payment status sync
-- ============================================================================


-- ============================================================================
-- 1. STATUS TRANSITIONS: reservation_request
-- ============================================================================
-- State machine:
--                               ┌──→ Denied (terminal)
--                               │
--   Pending ──┬──→ Approved ──┬──→ Completed ──→ Closed (terminal)
--             │               │
--             │               └──→ Cancelled (terminal)
--             │
--             └──→ Cancelled (terminal)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'approved'),
     'approve_reservation_request', 'Approve', 'Approve reservation. Triggers pricing calculation and payment creation.'),
    ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'denied'),
     'deny_reservation_request', 'Deny', 'Deny reservation request. Requires denial_reason.'),
    ('reservation_request', get_status_id('reservation_request', 'pending'), get_status_id('reservation_request', 'cancelled'),
     'cancel_reservation_request', 'Cancel', 'Cancel pending request. Requires cancellation_reason.'),
    ('reservation_request', get_status_id('reservation_request', 'approved'), get_status_id('reservation_request', 'cancelled'),
     'cancel_reservation_request', 'Cancel', 'Cancel approved reservation. Auto-cancels all pending payments.'),
    ('reservation_request', get_status_id('reservation_request', 'approved'), get_status_id('reservation_request', 'completed'),
     'complete_reservation_request', 'Mark Completed', 'Mark reservation as completed after the event ends. Also triggered automatically by auto_complete_past_events() scheduled job.'),
    ('reservation_request', get_status_id('reservation_request', 'completed'), get_status_id('reservation_request', 'closed'),
     'close_reservation_request', 'Close', 'Close reservation after all processing is complete. Requires security deposit to be refunded or waived first.');


-- ============================================================================
-- 2. STATUS TRANSITIONS: reservation_payment
-- ============================================================================
-- State machine:
--   Pending ──→ Paid      (Stripe webhook or manual record_*_payment RPCs)
--   Pending ──→ Waived    (waive_all_reservation_payments RPC)
--   Pending ──→ Cancelled (auto-cancelled when parent request is cancelled)
--   Paid ──→ Refunded     (manual/Stripe refund process)

INSERT INTO metadata.status_transitions (entity_type, from_status_id, to_status_id, on_transition_rpc, display_name, description) VALUES
    ('reservation_payment', get_status_id('reservation_payment', 'pending'), get_status_id('reservation_payment', 'paid'),
     NULL, 'Pay', 'Payment received via Stripe webhook (sync_reservation_payment_status) or manual recording (record_cash/check/money_order/cashapp_payment RPCs).'),
    ('reservation_payment', get_status_id('reservation_payment', 'pending'), get_status_id('reservation_payment', 'waived'),
     'waive_all_reservation_payments', 'Waive', 'Waive all pending payments for a reservation. Requires manager/admin role and reservation must be Approved.'),
    ('reservation_payment', get_status_id('reservation_payment', 'pending'), get_status_id('reservation_payment', 'cancelled'),
     NULL, 'Cancel', 'Auto-cancelled as side effect of cancel_reservation_request. No direct user action.'),
    ('reservation_payment', get_status_id('reservation_payment', 'paid'), get_status_id('reservation_payment', 'refunded'),
     NULL, 'Refund', 'Payment refunded. Currently a manual process (Stripe refund webhook trigger was removed in v0.18).');


-- ============================================================================
-- 3. PROPERTY CHANGE TRIGGERS: reservation_requests.status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    -- Pricing calculation on approval
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'approved')::TEXT,
     'on_reservation_approved', 'Calculate pricing on approval',
     'BEFORE trigger: calculates is_holiday_or_weekend, facility_fee_amount, and sets reviewed_at.'),
    -- Auto-create payment records on approval
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'approved')::TEXT,
     'create_reservation_payments', 'Create payment records on approval',
     'AFTER trigger: creates Security Deposit ($150 due immediately), Facility Fee (due 30 days before), and Cleaning Fee ($75 due 7 days before).'),
    -- Track cancellation metadata
    ('reservation_requests', 'status_id', 'changed_to', get_status_id('reservation_request', 'cancelled')::TEXT,
     'on_reservation_cancelled', 'Track cancellation details',
     'BEFORE trigger: sets cancelled_at = NOW() and cancelled_by = current_user_id().'),
    -- Validate required reason fields
    ('reservation_requests', 'status_id', 'any', NULL,
     'validate_status_reasons', 'Validate denial/cancellation reasons',
     'BEFORE trigger: requires denial_reason when status = Denied, cancellation_reason when status = Cancelled.'),
    -- Sync calendar color from status
    ('reservation_requests', 'status_id', 'any', NULL,
     'sync_reservation_color_from_status', 'Sync calendar color from status',
     'BEFORE trigger: copies color hex from metadata.statuses row to reservation color column for calendar display.'),
    -- Sync to public calendar
    ('reservation_requests', 'status_id', 'any', NULL,
     'sync_public_calendar_event', 'Sync to public calendar',
     'AFTER trigger: upserts to public_calendar_events if Approved/Completed, removes otherwise.'),
    -- Update can_waive_fees flag
    ('reservation_requests', 'status_id', 'any', NULL,
     'update_can_waive_fees', 'Update waive fees eligibility',
     'BEFORE trigger: sets can_waive_fees = TRUE when status is Approved and has pending payments.'),
    -- Audit note on status change
    ('reservation_requests', 'status_id', 'any', NULL,
     'add_reservation_status_change_note', 'Create audit note on status change',
     'AFTER trigger: creates system Entity Note with status-specific content (e.g., approval fee info, denial reason).'),
    -- Notification on status change
    ('reservation_requests', 'status_id', 'any', NULL,
     'notify_reservation_status_change', 'Notify requester on status change',
     'AFTER trigger: sends email notification to requester for Approved, Denied, and Cancelled transitions.');


-- ============================================================================
-- 4. PROPERTY CHANGE TRIGGERS: reservation_payments.status_id
-- ============================================================================

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    -- Update display name on status change
    ('reservation_payments', 'status_id', 'any', NULL,
     'set_payment_display_name', 'Update payment display name',
     'BEFORE trigger: rebuilds display_name like "Security Deposit - $150.00 (Paid - Cash)".'),
    -- Update overdue tracking
    ('reservation_payments', 'status_id', 'any', NULL,
     'update_payment_overdue_status', 'Update overdue tracking',
     'BEFORE trigger: computes days_until_due and is_overdue based on status and due_date.'),
    -- Audit note on parent reservation
    ('reservation_payments', 'status_id', 'any', NULL,
     'add_payment_status_change_note', 'Create audit note on parent reservation',
     'AFTER trigger: creates Entity Note on the parent reservation_request (e.g., "Security Deposit payment received ($150.00)").'),
    -- Update parent can_waive_fees flag
    ('reservation_payments', 'status_id', 'any', NULL,
     'update_can_waive_fees', 'Update parent waive fees eligibility',
     'AFTER trigger: recalculates reservation_requests.can_waive_fees based on remaining pending payments.'),
    -- Update can_record_payment flag
    ('reservation_payments', 'status_id', 'any', NULL,
     'update_can_record_payment', 'Update manual payment eligibility',
     'BEFORE trigger: sets can_record_payment = TRUE when status is Pending.');


-- ============================================================================
-- 5. PROPERTY CHANGE TRIGGERS: Stripe integration
-- ============================================================================
-- Note: payments.transactions is in the payments schema, not public.
-- The table_name stores the unqualified name.

INSERT INTO metadata.property_change_triggers (table_name, property_name, change_type, change_value, function_name, display_name, description) VALUES
    ('transactions', 'status', 'any', NULL,
     'sync_reservation_payment_status', 'Sync Stripe payment status to reservation',
     'AFTER trigger on payments.transactions: when status changes to succeeded, updates matching reservation_payment to Paid. On failed/canceled, clears transaction link to allow retry.');
