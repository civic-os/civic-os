-- ============================================================================
-- MOTT PARK RECREATION AREA - INTROSPECTION REGISTRATION
-- ============================================================================
-- This script registers RPC functions, triggers, and their entity effects
-- for the System Introspection feature (v0.23.0).
--
-- The introspection system enables:
--   - Auto-generated documentation for end users
--   - Dependency visualization (what modifies what)
--   - Safe function exposure (descriptions without source code)
--
-- See: docs/notes/SYSTEM_INTROSPECTION_DESIGN.md
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. REGISTER WORKFLOW RPC FUNCTIONS
-- ============================================================================
-- Use auto_register_function for functions with complex table interactions.
-- The static analyzer will detect INSERT/UPDATE/DELETE/SELECT patterns.

-- Approve Reservation Request
SELECT metadata.auto_register_function(
    'approve_reservation_request',
    'Approve Request',
    'Approves a pending reservation request, creating the corresponding reservation and notifying the user.',
    'workflow'
);

-- Update with additional metadata
UPDATE metadata.rpc_functions
SET
    parameters = '[
        {"name": "p_request_id", "type": "BIGINT", "description": "The reservation request ID to approve"}
    ]'::jsonb,
    returns_type = 'JSONB',
    returns_description = 'Object with success status, message, and created reservation ID',
    is_idempotent = false,
    minimum_role = 'manager'
WHERE function_name = 'approve_reservation_request';


-- Deny Reservation Request
SELECT metadata.auto_register_function(
    'deny_reservation_request',
    'Deny Request',
    'Denies a pending reservation request with an optional reason, notifying the user.',
    'workflow'
);

UPDATE metadata.rpc_functions
SET
    parameters = '[
        {"name": "p_request_id", "type": "BIGINT", "description": "The reservation request ID to deny"},
        {"name": "p_reason", "type": "TEXT", "description": "Optional reason for denial"}
    ]'::jsonb,
    returns_type = 'JSONB',
    returns_description = 'Object with success status and message',
    is_idempotent = false,
    minimum_role = 'manager'
WHERE function_name = 'deny_reservation_request';


-- Cancel Reservation Request
SELECT metadata.auto_register_function(
    'cancel_reservation_request',
    'Cancel Request',
    'Cancels a reservation request. If already approved, initiates refund workflow.',
    'workflow'
);

UPDATE metadata.rpc_functions
SET
    parameters = '[
        {"name": "p_request_id", "type": "BIGINT", "description": "The reservation request ID to cancel"}
    ]'::jsonb,
    returns_type = 'JSONB',
    returns_description = 'Object with success status, message, and refund information if applicable',
    is_idempotent = false,
    minimum_role = 'user'
WHERE function_name = 'cancel_reservation_request';


-- ============================================================================
-- 2. REGISTER PAYMENT RPC FUNCTIONS
-- ============================================================================

SELECT metadata.auto_register_function(
    'initiate_reservation_payment',
    'Initiate Payment',
    'Creates a payment intent for a reservation request. Calculates fees based on deposit rules.',
    'payment'
);

UPDATE metadata.rpc_functions
SET
    parameters = '[
        {"name": "p_entity_id", "type": "BIGINT", "description": "The reservation request ID to pay for"}
    ]'::jsonb,
    returns_type = 'JSONB',
    returns_description = 'Object with transaction_id, client_secret for Stripe, and payment_amount',
    is_idempotent = false,
    minimum_role = 'user'
WHERE function_name = 'initiate_reservation_payment';


SELECT metadata.auto_register_function(
    'process_refund',
    'Process Refund',
    'Initiates a refund for a completed payment. Supports partial refunds.',
    'payment'
);

UPDATE metadata.rpc_functions
SET
    parameters = '[
        {"name": "p_transaction_id", "type": "UUID", "description": "The transaction to refund"},
        {"name": "p_amount", "type": "NUMERIC", "description": "Amount to refund (NULL for full refund)"},
        {"name": "p_reason", "type": "TEXT", "description": "Reason for refund"}
    ]'::jsonb,
    returns_type = 'JSONB',
    returns_description = 'Object with success status and refund details',
    is_idempotent = false,
    minimum_role = 'admin'
WHERE function_name = 'process_refund';


-- ============================================================================
-- 3. REGISTER SCHEDULED JOB FUNCTIONS
-- ============================================================================

SELECT metadata.auto_register_function(
    'run_daily_reservation_tasks',
    'Daily Reservation Tasks',
    'Automated daily job that sends reminders, auto-completes past events, and cleans up stale requests.',
    'utility'
);

UPDATE metadata.rpc_functions
SET
    returns_type = 'JSONB',
    returns_description = 'Object with counts: reminders_sent, events_completed, requests_cleaned',
    is_idempotent = true,
    minimum_role = 'admin'
WHERE function_name = 'run_daily_reservation_tasks';


SELECT metadata.auto_register_function(
    'auto_complete_past_events',
    'Auto-Complete Events',
    'Marks approved reservation requests as completed when their time slot has passed.',
    'utility'
);


SELECT metadata.auto_register_function(
    'send_event_reminders',
    'Send Reminders',
    'Sends email reminders to users with reservations starting tomorrow.',
    'notification'
);


-- ============================================================================
-- 4. REGISTER DATABASE TRIGGERS
-- ============================================================================
-- Triggers explain what happens automatically when data changes.

INSERT INTO metadata.database_triggers
    (trigger_name, table_name, schema_name, timing, events, function_name, display_name, description, purpose)
VALUES
    ('validate_time_slot', 'reservation_requests', 'public', 'BEFORE', ARRAY['INSERT', 'UPDATE'],
     'validate_time_slot', 'Validate Time Slot',
     'Ensures time slots are valid (end > start, during business hours, no conflicts with existing reservations).',
     'validation'),

    ('set_initial_status', 'reservation_requests', 'public', 'BEFORE', ARRAY['INSERT'],
     'set_initial_status', 'Set Initial Status',
     'Automatically sets new requests to "Pending" status when created.',
     'workflow'),

    ('create_audit_note', 'reservation_requests', 'public', 'AFTER', ARRAY['UPDATE'],
     'create_status_change_note', 'Create Audit Note',
     'Creates an audit note when reservation status changes, recording who made the change and when.',
     'audit'),

    ('sync_payment_status', 'transactions', 'payments', 'AFTER', ARRAY['UPDATE'],
     'sync_payment_to_reservation', 'Sync Payment Status',
     'When a payment completes or fails, updates the corresponding reservation payment record.',
     'cascade')
ON CONFLICT (trigger_name, table_name, schema_name) DO UPDATE SET
    description = EXCLUDED.description,
    display_name = EXCLUDED.display_name,
    updated_at = NOW();


-- ============================================================================
-- 5. REGISTER TRIGGER ENTITY EFFECTS
-- ============================================================================
-- Document which entities triggers affect beyond their source table.

INSERT INTO metadata.trigger_entity_effects
    (trigger_name, trigger_table, trigger_schema, affected_table, effect_type, description)
VALUES
    ('create_audit_note', 'reservation_requests', 'public', 'entity_notes', 'create',
     'Creates an entity_note record for status change audit trail'),

    ('sync_payment_status', 'transactions', 'payments', 'reservation_payments', 'update',
     'Updates reservation_payments.status to match transaction status')
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 6. REGISTER NOTIFICATION TRIGGERS
-- ============================================================================
-- Document when notifications are sent.

INSERT INTO metadata.notification_triggers
    (trigger_type, source_function, source_table, template_id, trigger_condition, recipient_description, description)
SELECT
    'rpc',
    'approve_reservation_request',
    'reservation_requests',
    t.id,
    'When a reservation request is approved',
    'The user who submitted the request',
    'Sends approval confirmation email with reservation details and calendar attachment.'
FROM metadata.notification_templates t
WHERE t.name = 'reservation_request_approved'
ON CONFLICT DO NOTHING;

INSERT INTO metadata.notification_triggers
    (trigger_type, source_function, source_table, template_id, trigger_condition, recipient_description, description)
SELECT
    'rpc',
    'deny_reservation_request',
    'reservation_requests',
    t.id,
    'When a reservation request is denied',
    'The user who submitted the request',
    'Sends denial notification with reason (if provided).'
FROM metadata.notification_templates t
WHERE t.name = 'reservation_request_denied'
ON CONFLICT DO NOTHING;

INSERT INTO metadata.notification_triggers
    (trigger_type, source_function, source_table, template_id, trigger_condition, recipient_description, description)
SELECT
    'rpc',
    'cancel_reservation_request',
    'reservation_requests',
    t.id,
    'When a user cancels their reservation request',
    'The user who submitted the request',
    'Sends cancellation confirmation email.'
FROM metadata.notification_templates t
WHERE t.name = 'reservation_request_cancelled'
ON CONFLICT DO NOTHING;

-- 'manual' trigger_type for scheduled jobs (not RPC-triggered, not database trigger)
INSERT INTO metadata.notification_triggers
    (trigger_type, source_function, source_table, template_id, trigger_condition, recipient_description, description)
SELECT
    'manual',
    'run_daily_reservation_tasks',
    'reservation_requests',
    t.id,
    'Daily at 8 AM for reservations starting tomorrow',
    'Managers responsible for upcoming events',
    'Pre-event reminder sent to managers the day before.'
FROM metadata.notification_templates t
WHERE t.name = 'manager_pre_event_reminder'
ON CONFLICT DO NOTHING;


-- ============================================================================
-- 7. MANUAL ENTITY EFFECTS (for complex cases static analysis misses)
-- ============================================================================
-- Add effects that the static analyzer can't detect (dynamic SQL, CTEs, etc.)

-- approve_reservation_request also sends notifications
INSERT INTO metadata.rpc_entity_effects
    (function_name, entity_table, effect_type, description, is_auto_detected)
VALUES
    ('approve_reservation_request', 'notifications', 'create',
     'Creates notification record for approval email', false)
ON CONFLICT (function_name, entity_table, effect_type) DO NOTHING;

-- cancel_reservation_request may create refund transactions
INSERT INTO metadata.rpc_entity_effects
    (function_name, entity_table, effect_type, description, is_auto_detected)
VALUES
    ('cancel_reservation_request', 'transactions', 'create',
     'Creates refund transaction if cancelling paid reservation', false)
ON CONFLICT (function_name, entity_table, effect_type) DO NOTHING;


DO $$
DECLARE
    v_rpc_count INT;
    v_trigger_count INT;
    v_effect_count INT;
BEGIN
    SELECT COUNT(*) INTO v_rpc_count FROM metadata.rpc_functions;
    SELECT COUNT(*) INTO v_trigger_count FROM metadata.database_triggers;
    SELECT COUNT(*) INTO v_effect_count FROM metadata.rpc_entity_effects;

    RAISE NOTICE '✓ System introspection registration complete';
    RAISE NOTICE '  - Registered % RPC functions', v_rpc_count;
    RAISE NOTICE '  - Registered % triggers', v_trigger_count;
    RAISE NOTICE '  - Detected % entity effects', v_effect_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Query the views to explore:';
    RAISE NOTICE '  SELECT * FROM schema_functions;';
    RAISE NOTICE '  SELECT * FROM schema_triggers;';
    RAISE NOTICE '  SELECT * FROM schema_entity_dependencies;';
END;
$$;

COMMIT;
