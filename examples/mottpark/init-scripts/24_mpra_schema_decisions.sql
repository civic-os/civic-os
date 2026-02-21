-- ============================================================================
-- MOTT PARK - RETROACTIVE SCHEMA DECISIONS (ADRs)
-- ============================================================================
-- Documents the key architectural decisions made during the Mott Park
-- clubhouse reservation system development. These decisions explain WHY
-- the schema is designed the way it is, preventing future developers from
-- re-litigating settled tradeoffs.
--
-- Note: Uses direct INSERT (not create_schema_decision RPC) because init
-- scripts run without JWT context. The RPC is for runtime use by authenticated
-- admin users.
--
-- Ordered by decided_date so auto-increment IDs are chronological.
--
-- Requires: Civic OS v0.30.0+ (Schema Decisions system)
-- ============================================================================

BEGIN;

-- ============================================================================
-- ADR 1: Multi-payment table with per-payment status (2025-10-15)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_payments']::NAME[], NULL, 'mottpark-01-reservations-schema',
    'Multi-payment table with per-payment status',
    'accepted',
    'Mott Park charges three separate fees: facility fee ($150 weekday / $300 weekend-holiday, non-refundable, due 30 days before event), security deposit ($150, refundable, due immediately upon approval), and cleaning fee ($75, non-refundable, due 7 days before event). Each fee has a different lifecycle — the deposit may be refunded while others are paid, or individual fees can be waived.',
    'Each reservation has multiple payment records (facility fee, security deposit, cleaning fee) in a separate reservation_payments table, each with independent status tracking.',
    'A single payment_status on the reservation would not capture the reality of partial payments. The multi-row approach allows each fee to transition independently (pending → paid, pending → waived, paid → refunded). It also enables clear reporting on outstanding balances per fee type. Different due dates per fee type (immediate, 30-day, 7-day) require independent tracking.',
    'Three payment records are created per approved reservation (via AFTER trigger). Staff can waive individual fees. The reservation detail page shows a payment breakdown section. Reporting can aggregate by fee type across all reservations.',
    '2025-10-15'
);

-- ============================================================================
-- ADR 2: Trigger-based conditional validation (2025-10-15)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_requests']::NAME[], ARRAY['denial_reason', 'cancellation_reason']::NAME[], 'mottpark-01-reservations-schema',
    'Trigger-based conditional validation for status-dependent required fields',
    'accepted',
    'Some fields are conditionally required based on status transitions. For example, denial_reason is required when status changes to Denied, and cancellation_reason is required when status changes to Cancelled. PostgreSQL CHECK constraints cannot contain subqueries (needed to look up status values from the metadata.statuses table), making them unsuitable for status-dependent validation.',
    'Status-dependent required field rules (denial_reason required when transitioning to Denied, cancellation_reason required when transitioning to Cancelled) use a validate_status_reasons() BEFORE UPDATE trigger instead of CHECK constraints.',
    'CHECK constraints fundamentally cannot reference other tables — they only see the current row. Since status_id is a foreign key to metadata.statuses, determining the status name requires a subquery (SELECT status_key FROM metadata.statuses WHERE id = NEW.status_id). The trigger approach also integrates with metadata.constraint_messages, providing field-specific friendly error messages (e.g., "A denial reason is required") that the frontend displays inline via ErrorService.parseToHuman().',
    'Validation logic lives in trigger functions rather than table DDL. Simple validations (time_slot bounds, policy_agreed = true, attendee_count range) still use CHECK constraints where possible. Only validations requiring subqueries or cross-table lookups use triggers. Error messages are configurable in metadata.constraint_messages without schema changes.',
    '2025-10-15'
);

-- ============================================================================
-- ADR 3: Evergreen holiday rules for dynamic pricing (2025-10-20)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_requests']::NAME[], ARRAY['facility_fee_amount']::NAME[], 'mottpark-02-holidays-dashboard',
    'Evergreen holiday rules for dynamic pricing (not availability)',
    'accepted',
    'The clubhouse facility fee varies by day type: $150 for weekdays vs $300 for weekends and holidays. Holidays like Thanksgiving (4th Thursday of November) fall on different dates each year. A static date table would require annual updates that staff might forget.',
    'Holiday/pricing dates use algorithmic rules (fixed date, nth weekday, last weekday, relative) stored in a holiday_rules table. The is_holiday_or_weekend() function evaluates these rules to determine the facility fee at approval time — holidays affect PRICING, not availability.',
    'Algorithmic rules automatically apply to any future year without migration. Rule types cover all US federal holiday patterns: fixed dates (July 4), nth weekday (4th Thursday November = Thanksgiving), last weekday (last Monday May = Memorial Day), and relative (day after Thanksgiving). The on_reservation_approved() BEFORE trigger calls is_holiday_or_weekend() to set the facility_fee_amount before payment records are created.',
    'Slightly more complex initial setup. Helper functions (calculate_holiday_date, get_nth_weekday_of_month, get_last_weekday_of_month) handle date arithmetic. New holidays can be added by inserting a rule row — no code changes needed. Residents can still book on holidays; they just pay the higher rate.',
    '2025-10-20'
);

-- ============================================================================
-- ADR 4: Two-phase approval trigger (2025-11-01)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_requests', 'reservation_payments']::NAME[], NULL, 'mottpark-01-reservations-schema',
    'Two-phase approval trigger for fee calculation and payment creation',
    'accepted',
    'After approving a reservation, staff would need to manually calculate the facility fee (based on whether the event date is a weekday or weekend/holiday), create three payment records with correct amounts and due dates, and set review metadata. This is error-prone and adds friction to the approval workflow.',
    'When a reservation status changes to Approved, two triggers fire in sequence: (1) on_reservation_approved() BEFORE trigger calculates is_holiday_or_weekend and facility_fee_amount, sets reviewed_at; (2) create_reservation_payments() AFTER trigger creates three payment records (security deposit $150 due immediately, facility fee due 30 days before event, cleaning fee $75 due 7 days before event).',
    'Splitting into BEFORE and AFTER triggers ensures the fee calculation (which modifies the row) completes before payment records reference the calculated amounts. A single AFTER trigger could not modify the triggering row. Trigger-based creation ensures atomicity — approval and payment setup happen in a single transaction.',
    'The approval action button only changes the status — everything else cascades via triggers. Payment records exist immediately after approval with correct amounts. Staff can still waive individual fees after creation. If approval is reverted, payment records persist (by design, for audit trail).',
    '2025-11-01'
);

-- ============================================================================
-- ADR 5: Separate request and calendar tables (2025-11-15)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_requests', 'public_calendar_events']::NAME[], NULL, 'mottpark-05-public-calendar',
    'Separate request and calendar tables with one-way sync',
    'accepted',
    'Reservation requests contain sensitive data (resident contact info, policy acknowledgments, internal notes) that should not be visible to the general public. However, the community needs to see when the clubhouse is booked.',
    'Reservation requests and public calendar events are stored in separate tables. A trigger syncs approved events one-way from reservation_requests to public_calendar_events.',
    'A separate public table with its own RLS policies provides clean privacy isolation. The alternative (filtered view with column-level security) would be fragile — adding a new sensitive column could accidentally expose data. One-way sync ensures the public table is always a safe subset.',
    'Two tables to maintain. Sync trigger must handle INSERT, UPDATE, and DELETE on the source table. Public calendar events use the same ID as reservation requests for traceability but without a FK constraint (one-way sync means the public table is derivative, not authoritative).',
    '2025-11-15'
);

-- ============================================================================
-- ADR 6: Double-booking constraint on calendar (2025-11-15)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['public_calendar_events']::NAME[], ARRAY['time_slot']::NAME[], 'mottpark-05-public-calendar',
    'Double-booking constraint on calendar, not requests',
    'accepted',
    'Multiple residents may submit overlapping reservation requests simultaneously. Staff need to see all requests to make informed approval decisions.',
    'The GIST exclusion constraint preventing overlapping time slots is on public_calendar_events, not on reservation_requests.',
    'Placing the constraint on the public calendar means overlapping pending requests are allowed, but only one can be approved for a given time slot. The constraint fires at approval time (when the sync trigger inserts into public_calendar_events), giving staff the ability to choose between competing requests rather than enforcing first-come-first-served.',
    'Staff must manually check for conflicts when approving. The approval trigger will fail with a clear constraint violation if a double-booking is attempted. Pending requests can overlap freely.',
    '2025-11-15'
);

-- ============================================================================
-- ADR 7: Master cron job orchestration (2025-12-20)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['reservation_requests']::NAME[], NULL, 'mottpark-12-scheduled-jobs',
    'Master cron job orchestration via single entry point',
    'accepted',
    'The Mott Park system has multiple time-based automated tasks: auto-completing past events, sending payment reminders at various intervals, and notifying managers of upcoming events. These tasks have ordering dependencies (status transitions before payment notifications) and shared logging needs.',
    'All scheduled tasks are orchestrated by a single run_daily_reservation_tasks() function registered as one scheduled job (daily at 8 AM Eastern), rather than individual cron entries per task. It calls five sub-functions in order: (1) auto_complete_past_events, (2) send_payment_reminders_7day, (3) send_payment_due_today, (4) send_payment_overdue_notifications, (5) send_pre_event_reminders.',
    'A single entry point provides centralized logging, ordered execution (status transitions before payment notifications), and simpler debugging. The master function calls sub-functions in sequence, catching and logging errors per step so one failure does not block others. Returns JSONB with success flag, message, and per-task details. No external cron daemon dependency — uses the metadata.scheduled_jobs system.',
    'All automated tasks run at the same scheduled time (8 AM America/Detroit). Individual tasks cannot have different schedules (acceptable for daily operations). Adding a new automated task means adding a function call to the master function. Notification tasks use named templates from metadata.notification_templates (payment_reminder_7day, payment_due_today, payment_overdue, manager_pre_event_reminder).',
    '2025-12-20'
);

-- ============================================================================
-- ADR 8: Virtual entity for manager-streamlined workflow (2026-01-25)
-- ============================================================================

INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status, context, decision, rationale, consequences, decided_date)
VALUES (
    ARRAY['manager_events', 'reservation_requests']::NAME[], NULL, 'mottpark-22-manager-events',
    'Virtual entity for manager-streamlined event creation',
    'accepted',
    'Managers frequently create events on behalf of residents or for community use. The standard request form requires fields irrelevant for staff-created events (policy acknowledgment, requestor address) and requires a separate approval step that is redundant when the creator is the approver.',
    'A manager_events VIEW with INSTEAD OF triggers provides a simplified event creation form that auto-approves, bypassing the request/approval workflow for authorized staff. The VIEW exposes a subset of columns with friendlier aliases (e.g., contact_name instead of requestor_name).',
    'A VIEW-based virtual entity reuses all existing triggers (on_reservation_approved, create_reservation_payments, calendar sync) without duplicating logic. The INSTEAD OF INSERT trigger fills defaults (requestor_id = current_user, policy_agreed = true), inserts as Pending, then immediately updates status to Approved — triggering the full approval cascade. The alternative (a separate RPC) would bypass existing trigger chains.',
    'Manager events appear in the same reservation_requests table as resident submissions. All existing reporting, calendar sync, and payment logic works unchanged. The manager_events entity has its own permissions (manager and admin roles) and metadata configuration with calendar visualization enabled. VIEW columns auto-inherit validations from base table columns with matching names; aliased columns (contact_name, contact_phone) need explicit validation entries.',
    '2026-01-25'
);

COMMIT;
