-- ============================================================================
-- MOTT PARK RECREATION AREA - CLUBHOUSE RESERVATION SYSTEM
-- ============================================================================
-- Demonstrates: TimeSlot, Status Type System, Multi-Payment Tracking,
--               Public/Private Calendar Visibility, Notification Triggers
-- ============================================================================
-- NOTE: Requires Civic OS v0.15.0+ (Status Type System, time_slot domain, btree_gist)
-- ============================================================================

-- Wrap in transaction for atomic execution
BEGIN;

-- ============================================================================
-- SECTION 1: STATUS TYPE SYSTEM CONFIGURATION
-- ============================================================================

-- Register 'reservation_request' as a valid status entity type
INSERT INTO metadata.status_types (entity_type, description)
VALUES ('reservation_request', 'Status values for Mott Park clubhouse reservation requests')
ON CONFLICT (entity_type) DO NOTHING;

-- Insert statuses for reservation requests
-- Workflow: Pending → Approved/Denied/Cancelled
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal)
VALUES
  ('reservation_request', 'Pending', 'Awaiting review by staff', '#F59E0B', 1, TRUE, FALSE),
  ('reservation_request', 'Approved', 'Reservation confirmed - payments due per schedule', '#22C55E', 2, FALSE, FALSE),
  ('reservation_request', 'Denied', 'Request denied by staff', '#EF4444', 3, FALSE, TRUE),
  ('reservation_request', 'Cancelled', 'Cancelled by manager', '#6B7280', 4, FALSE, TRUE),
  ('reservation_request', 'Completed', 'Event completed - pending deposit refund', '#3B82F6', 5, FALSE, FALSE),
  ('reservation_request', 'Closed', 'All payments settled and deposit refunded', '#8B5CF6', 6, FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- Register 'reservation_payment' as a valid status entity type
INSERT INTO metadata.status_types (entity_type, description)
VALUES ('reservation_payment', 'Status values for reservation payment tracking')
ON CONFLICT (entity_type) DO NOTHING;

-- Insert statuses for reservation payments
INSERT INTO metadata.statuses (entity_type, display_name, description, color, sort_order, is_initial, is_terminal)
VALUES
  ('reservation_payment', 'Pending', 'Payment not yet received', '#F59E0B', 1, TRUE, FALSE),
  ('reservation_payment', 'Paid', 'Payment received', '#22C55E', 2, FALSE, FALSE),
  ('reservation_payment', 'Refunded', 'Payment has been refunded', '#3B82F6', 3, FALSE, TRUE),
  ('reservation_payment', 'Waived', 'Payment waived by staff', '#8B5CF6', 4, FALSE, TRUE)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SECTION 2: HOLIDAY RULES (Evergreen - see supplemental file)
-- ============================================================================
-- IMPORTANT: The holiday_rules table and is_holiday_or_weekend() function
-- are defined in mpra_holidays_dashboard.sql (Part 2).
-- 
-- The evergreen holiday system uses algorithmic rules instead of static dates:
-- - Fixed dates: July 4th, Christmas, etc.
-- - Nth weekday: 4th Thursday of November (Thanksgiving)
-- - Last weekday: Last Monday of May (Memorial Day)
-- - Relative: Day after Thanksgiving
-- - Weekends: All Saturdays and Sundays
--
-- This means holiday pricing automatically works for any future year
-- without requiring annual updates.
-- ============================================================================

-- ============================================================================
-- SECTION 3: RESERVATION PAYMENT TYPES (System lookup)
-- ============================================================================

CREATE TABLE reservation_payment_types (
  id SERIAL PRIMARY KEY,
  display_name VARCHAR(50) NOT NULL UNIQUE,
  code VARCHAR(20) NOT NULL UNIQUE,             -- 'security_deposit', 'facility_fee', 'cleaning_fee'
  base_amount MONEY NOT NULL,                   -- Default amount (may vary for facility_fee)
  is_refundable BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0
);

INSERT INTO reservation_payment_types (display_name, code, base_amount, is_refundable, description, sort_order)
VALUES
  ('Security Deposit', 'security_deposit', 150.00, TRUE, 
   'Refundable deposit due immediately upon approval. Refunded after event if no damages.', 1),
  ('Facility Fee', 'facility_fee', 150.00, FALSE, 
   'Non-refundable rental fee. $150 weekdays, $300 weekends/holidays. Due 30 days before event.', 2),
  ('Cleaning Fee', 'cleaning_fee', 75.00, FALSE, 
   'Non-refundable cleaning fee due prior to event.', 3);

-- ============================================================================
-- SECTION 4: MAIN RESERVATION REQUEST TABLE
-- ============================================================================

CREATE TABLE reservation_requests (
  id BIGSERIAL PRIMARY KEY,
  
  -- Requestor Information (from form + SSO)
  requestor_id UUID NOT NULL DEFAULT current_user_id() 
    REFERENCES metadata.civic_os_users(id) ON DELETE CASCADE,
  requestor_name VARCHAR(200) NOT NULL,         -- Full name (may differ from SSO)
  requestor_address TEXT NOT NULL,              -- Mailing address
  requestor_phone phone_number NOT NULL,        -- Contact phone
  -- Email comes from SSO via requestor_id FK
  organization_name VARCHAR(200),               -- Optional: if representing an organization
  
  -- Event Details
  event_type VARCHAR(200) NOT NULL,             -- Free text: "Birthday Party", "Community Meeting", etc.
  time_slot time_slot NOT NULL,                 -- Start and end date/time
  attendee_count INT NOT NULL,                  -- Approximate number of attendees
  attendee_ages TEXT,                           -- Free text: age description for supervision requirements
  
  -- Event Flags
  is_food_served BOOLEAN NOT NULL DEFAULT FALSE,
  is_public_event BOOLEAN NOT NULL DEFAULT FALSE,  -- Controls calendar visibility
  is_fundraiser BOOLEAN NOT NULL DEFAULT FALSE,
  is_admission_charged BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Policy Agreement
  -- TODO: Static text display on forms is a planned feature. For now, the agreement
  -- text should be displayed above this checkbox via custom form configuration.
  policy_agreed BOOLEAN NOT NULL DEFAULT FALSE,
  policy_agreed_at TIMESTAMPTZ,                 -- When they agreed
  
  -- Status Workflow (uses Status Type System)
  status_id INT NOT NULL DEFAULT get_initial_status('reservation_request')
    REFERENCES metadata.statuses(id),
  
  -- Review/Approval Tracking
  reviewed_by UUID REFERENCES metadata.civic_os_users(id),
  reviewed_at TIMESTAMPTZ,
  denial_reason TEXT,                           -- Required if denied
  cancellation_reason TEXT,                     -- Required if cancelled
  cancelled_by UUID REFERENCES metadata.civic_os_users(id),
  cancelled_at TIMESTAMPTZ,
  
  -- Computed Pricing (set by trigger on approval)
  is_holiday_or_weekend BOOLEAN,                -- Computed: affects facility fee
  facility_fee_amount MONEY,                    -- $150 or $300 based on date
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Display name for List/Detail views (staff-only table now)
  display_name VARCHAR(255) GENERATED ALWAYS AS (
    COALESCE(organization_name, requestor_name) || ' - ' || event_type
  ) STORED,
  
  -- Constraints (simple expressions only - PostgreSQL doesn't allow subqueries in CHECK)
  CONSTRAINT valid_time_slot_bounds
    CHECK (NOT isempty(time_slot) AND lower(time_slot) < upper(time_slot)),
  CONSTRAINT policy_must_be_agreed
    CHECK (policy_agreed = TRUE),
  CONSTRAINT attendee_count_positive
    CHECK (attendee_count > 0 AND attendee_count <= 75)  -- Max capacity per policy
  -- NOTE: denial_reason_required and cancellation_reason_required are enforced via trigger
  -- because CHECK constraints cannot contain subqueries
);

COMMENT ON TABLE reservation_requests IS
  'Primary table for Mott Park Recreation Area clubhouse reservations.
   This is the source of truth for the reservation workflow and feeds the public calendar.
   Status changes trigger notifications to requestors and managers.';

-- CRITICAL: Index all foreign keys
CREATE INDEX idx_reservation_requests_requestor ON reservation_requests(requestor_id);
CREATE INDEX idx_reservation_requests_status ON reservation_requests(status_id);
CREATE INDEX idx_reservation_requests_reviewed_by ON reservation_requests(reviewed_by);
CREATE INDEX idx_reservation_requests_cancelled_by ON reservation_requests(cancelled_by);
CREATE INDEX idx_reservation_requests_time_slot ON reservation_requests USING GIST(time_slot);

-- NOTE: Partial index for calendar queries removed - PostgreSQL doesn't allow subqueries in index predicates
-- The idx_reservation_requests_status index + query optimizer should handle calendar queries efficiently
-- If performance becomes an issue, consider adding a boolean 'is_calendar_visible' column

-- ============================================================================
-- SECTION 5: RESERVATION PAYMENTS TABLE
-- ============================================================================

CREATE TABLE reservation_payments (
  id BIGSERIAL PRIMARY KEY,
  reservation_request_id BIGINT NOT NULL
    REFERENCES reservation_requests(id) ON DELETE CASCADE,
  payment_type_id INT NOT NULL
    REFERENCES reservation_payment_types(id),

  -- Display name (trigger-maintained, cannot use generated column due to MONEY type)
  -- Result: "Security Deposit - $150.00 (Pending)"
  display_name VARCHAR(255),

  -- Amount and Schedule
  amount MONEY NOT NULL,
  due_date DATE,                                -- When payment is due

  -- Payment Status (uses Status Type System for colored badges)
  status_id INT NOT NULL DEFAULT get_initial_status('reservation_payment')
    REFERENCES metadata.statuses(id),

  -- Stripe Integration (links to payments.transactions)
  payment_transaction_id UUID
    REFERENCES payments.transactions(id) ON DELETE SET NULL,

  -- Payment Tracking
  paid_at TIMESTAMPTZ,
  paid_amount MONEY,                            -- Actual amount paid (may differ)

  -- Refund Tracking (for security deposits)
  refund_requested_at TIMESTAMPTZ,
  refund_processed_at TIMESTAMPTZ,
  refund_amount MONEY,
  refund_notes TEXT,                            -- e.g., "Partial refund - cleaning required"

  -- Waiver (for community groups)
  waived_by UUID REFERENCES metadata.civic_os_users(id),
  waived_at TIMESTAMPTZ,
  waiver_reason TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate payment types per reservation
  UNIQUE (reservation_request_id, payment_type_id)
);

COMMENT ON TABLE reservation_payments IS
  'Tracks individual payments for each reservation request.
   Three payment types: Security Deposit ($150 refundable), 
   Facility Fee ($150/$300), Cleaning Fee ($75).
   Each reservation gets all three payment records created on approval.';

-- CRITICAL: Index foreign keys
CREATE INDEX idx_reservation_payments_request ON reservation_payments(reservation_request_id);
CREATE INDEX idx_reservation_payments_type ON reservation_payments(payment_type_id);
CREATE INDEX idx_reservation_payments_transaction ON reservation_payments(payment_transaction_id);
CREATE INDEX idx_reservation_payments_waived_by ON reservation_payments(waived_by);
CREATE INDEX idx_reservation_payments_status ON reservation_payments(status_id);

-- Trigger to maintain display_name
-- Builds: "Security Deposit - $150.00 (Pending)"
-- Cannot use generated column because MONEY type casts are locale-dependent (STABLE)
CREATE OR REPLACE FUNCTION set_payment_display_name()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_type_name TEXT;
  v_status_name TEXT;
BEGIN
  -- Get payment type name
  SELECT display_name INTO v_type_name
  FROM reservation_payment_types
  WHERE id = NEW.payment_type_id;

  -- Get status name
  SELECT display_name INTO v_status_name
  FROM metadata.statuses
  WHERE id = NEW.status_id;

  -- Build display name: "Type - $amount (Status)"
  NEW.display_name := COALESCE(v_type_name, 'Payment') || ' - ' ||
                      NEW.amount::TEXT ||
                      ' (' || COALESCE(v_status_name, 'Unknown') || ')';

  RETURN NEW;
END;
$$;

CREATE TRIGGER set_payment_display_name_trigger
  BEFORE INSERT OR UPDATE OF payment_type_id, status_id, amount ON reservation_payments
  FOR EACH ROW
  EXECUTE FUNCTION set_payment_display_name();

-- ============================================================================
-- SECTION 6: HELPER FUNCTIONS
-- ============================================================================
-- NOTE: Double-booking prevention is handled by the exclusion constraint on
-- public_calendar_events table (see 05_mpra_public_calendar.sql).
-- Multiple overlapping REQUESTS are allowed; only approved events are blocked.

-- NOTE: is_holiday_or_weekend() function is defined in mpra_holidays_dashboard.sql
-- It uses the evergreen holiday_rules system to check dates algorithmically.

-- Calculate facility fee based on event date
CREATE OR REPLACE FUNCTION calculate_facility_fee(event_start TIMESTAMPTZ)
RETURNS MONEY AS $$
BEGIN
  IF is_holiday_or_weekend(event_start::DATE) THEN
    RETURN 300.00::MONEY;
  ELSE
    RETURN 150.00::MONEY;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get event start date from time_slot
CREATE OR REPLACE FUNCTION get_event_start(slot time_slot)
RETURNS TIMESTAMPTZ AS $$
  SELECT lower(slot);
$$ LANGUAGE SQL IMMUTABLE;

-- ============================================================================
-- SECTION 8: TRIGGERS
-- ============================================================================

-- Trigger: Set policy_agreed_at when policy is agreed
CREATE OR REPLACE FUNCTION set_policy_agreed_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.policy_agreed = TRUE AND (OLD IS NULL OR OLD.policy_agreed = FALSE) THEN
    NEW.policy_agreed_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER policy_agreement_timestamp
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION set_policy_agreed_timestamp();

-- Trigger: Validate denial/cancellation reasons (replaces CHECK constraints that can't use subqueries)
CREATE OR REPLACE FUNCTION validate_status_reasons()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_denied_status_id INT;
  v_cancelled_status_id INT;
BEGIN
  -- Get status IDs once
  SELECT id INTO v_denied_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Denied';

  SELECT id INTO v_cancelled_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';

  -- Validate denial_reason is required when status is Denied
  IF NEW.status_id = v_denied_status_id AND NEW.denial_reason IS NULL THEN
    RAISE EXCEPTION 'denial_reason is required when status is Denied'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'denial_reason_required';
  END IF;

  -- Validate cancellation_reason is required when status is Cancelled
  IF NEW.status_id = v_cancelled_status_id AND NEW.cancellation_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason is required when status is Cancelled'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'cancellation_reason_required';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_status_reasons_trigger
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION validate_status_reasons();

-- Trigger: On approval, calculate fees and create payment records
CREATE OR REPLACE FUNCTION on_reservation_approved()
RETURNS TRIGGER AS $$
DECLARE
  v_approved_status_id INT;
  v_event_start TIMESTAMPTZ;
  v_is_holiday BOOLEAN;
  v_facility_fee MONEY;
  v_deposit_type_id INT;
  v_facility_type_id INT;
  v_cleaning_type_id INT;
BEGIN
  -- Get the 'Approved' status ID
  SELECT id INTO v_approved_status_id 
  FROM metadata.statuses 
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';
  
  -- Only proceed if status changed TO Approved
  IF NEW.status_id = v_approved_status_id 
     AND (OLD IS NULL OR OLD.status_id != v_approved_status_id) THEN
    
    -- Calculate pricing
    v_event_start := lower(NEW.time_slot);
    v_is_holiday := is_holiday_or_weekend(v_event_start::DATE);
    v_facility_fee := calculate_facility_fee(v_event_start);
    
    -- Update the reservation with computed pricing
    NEW.is_holiday_or_weekend := v_is_holiday;
    NEW.facility_fee_amount := v_facility_fee;
    NEW.reviewed_at := NOW();
    
    -- Get payment type IDs
    SELECT id INTO v_deposit_type_id FROM reservation_payment_types WHERE code = 'security_deposit';
    SELECT id INTO v_facility_type_id FROM reservation_payment_types WHERE code = 'facility_fee';
    SELECT id INTO v_cleaning_type_id FROM reservation_payment_types WHERE code = 'cleaning_fee';
    
    -- Create payment records (will be inserted after this trigger completes)
    -- We use a separate AFTER trigger for this
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_approval_pricing
  BEFORE UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION on_reservation_approved();

-- AFTER trigger to create payment records
CREATE OR REPLACE FUNCTION create_reservation_payments()
RETURNS TRIGGER AS $$
DECLARE
  v_approved_status_id INT;
  v_event_start DATE;
  v_deposit_type_id INT;
  v_facility_type_id INT;
  v_cleaning_type_id INT;
BEGIN
  -- Get the 'Approved' status ID
  SELECT id INTO v_approved_status_id 
  FROM metadata.statuses 
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';
  
  -- Only proceed if status changed TO Approved
  IF NEW.status_id = v_approved_status_id 
     AND (OLD IS NULL OR OLD.status_id != v_approved_status_id) THEN
    
    v_event_start := (lower(NEW.time_slot))::DATE;
    
    -- Get payment type IDs
    SELECT id INTO v_deposit_type_id FROM reservation_payment_types WHERE code = 'security_deposit';
    SELECT id INTO v_facility_type_id FROM reservation_payment_types WHERE code = 'facility_fee';
    SELECT id INTO v_cleaning_type_id FROM reservation_payment_types WHERE code = 'cleaning_fee';
    
    -- Create Security Deposit payment (due immediately)
    -- Note: status_id uses DEFAULT from get_initial_status('reservation_payment')
    INSERT INTO reservation_payments (
      reservation_request_id, payment_type_id, amount, due_date
    ) VALUES (
      NEW.id, v_deposit_type_id, 150.00::MONEY, CURRENT_DATE
    ) ON CONFLICT (reservation_request_id, payment_type_id) DO NOTHING;

    -- Create Facility Fee payment (due 30 days before event)
    INSERT INTO reservation_payments (
      reservation_request_id, payment_type_id, amount, due_date
    ) VALUES (
      NEW.id, v_facility_type_id, NEW.facility_fee_amount,
      v_event_start - INTERVAL '30 days'
    ) ON CONFLICT (reservation_request_id, payment_type_id) DO NOTHING;

    -- Create Cleaning Fee payment (due before event - 7 days prior)
    INSERT INTO reservation_payments (
      reservation_request_id, payment_type_id, amount, due_date
    ) VALUES (
      NEW.id, v_cleaning_type_id, 75.00::MONEY,
      v_event_start - INTERVAL '7 days'
    ) ON CONFLICT (reservation_request_id, payment_type_id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_create_payments
  AFTER UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION create_reservation_payments();

-- Trigger: Track cancellation metadata
CREATE OR REPLACE FUNCTION on_reservation_cancelled()
RETURNS TRIGGER AS $$
DECLARE
  v_cancelled_status_id INT;
BEGIN
  SELECT id INTO v_cancelled_status_id 
  FROM metadata.statuses 
  WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';
  
  IF NEW.status_id = v_cancelled_status_id 
     AND (OLD IS NULL OR OLD.status_id != v_cancelled_status_id) THEN
    NEW.cancelled_at := NOW();
    NEW.cancelled_by := current_user_id();
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_cancellation_tracking
  BEFORE UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION on_reservation_cancelled();

-- Apply standard timestamp triggers
CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_created_at_trigger
  BEFORE INSERT ON reservation_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_created_at();

CREATE TRIGGER set_updated_at_trigger
  BEFORE INSERT OR UPDATE ON reservation_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- NOTE: holiday_rules triggers are in mpra_holidays_dashboard.sql (Part 2)

-- ============================================================================
-- SECTION 9: GRANTS & PERMISSIONS
-- ============================================================================

-- NOTE: holiday_rules grants are in mpra_holidays_dashboard.sql (Part 2)

-- Payment Types: Read-only lookup table
GRANT SELECT ON reservation_payment_types TO web_anon, authenticated;

-- Reservation Requests: Authenticated users can create, managers/admins can update
GRANT SELECT ON reservation_requests TO web_anon, authenticated;
GRANT INSERT ON reservation_requests TO authenticated;
GRANT UPDATE, DELETE ON reservation_requests TO authenticated;  -- RLS restricts
GRANT USAGE, SELECT ON SEQUENCE reservation_requests_id_seq TO authenticated;

-- Reservation Payments: View own, admins manage all
GRANT SELECT ON reservation_payments TO authenticated;
GRANT INSERT, UPDATE ON reservation_payments TO authenticated;  -- RLS restricts
GRANT USAGE, SELECT ON SEQUENCE reservation_payments_id_seq TO authenticated;

-- ============================================================================
-- SECTION 10: ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Enable RLS
-- NOTE: holiday_rules RLS is in mpra_holidays_dashboard.sql (Part 2)
ALTER TABLE reservation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_payments ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Reservation Requests: Complex visibility rules
-- ---------------------------------------------------------------------------

-- SELECT: Users see own requests OR staff with permission see all
-- NOTE: Public calendar access is via public_calendar_events table (separate entity)
CREATE POLICY "reservation_requests: read own or staff" ON reservation_requests
  FOR SELECT TO authenticated
  USING (
    -- Own requests
    requestor_id = current_user_id()
    -- OR staff with read permission see all
    OR has_permission('reservation_requests', 'read')
  );

-- INSERT: Any authenticated user can create a request (for themselves)
CREATE POLICY "reservation_requests: create own" ON reservation_requests
  FOR INSERT TO authenticated
  WITH CHECK (requestor_id = current_user_id());

-- UPDATE: Only managers can update (approve/deny/cancel)
CREATE POLICY "reservation_requests: manager update" ON reservation_requests
  FOR UPDATE TO authenticated
  USING (has_permission('reservation_requests', 'update'))
  WITH CHECK (has_permission('reservation_requests', 'update'));

-- DELETE: Only admins can delete
CREATE POLICY "reservation_requests: admin delete" ON reservation_requests
  FOR DELETE TO authenticated
  USING (is_admin());

-- ---------------------------------------------------------------------------
-- Reservation Payments: Users see own, managers see all, admins modify
-- ---------------------------------------------------------------------------

CREATE POLICY "reservation_payments: read own or manager" ON reservation_payments
  FOR SELECT TO authenticated
  USING (
    -- Own payments (via reservation)
    EXISTS (
      SELECT 1 FROM reservation_requests rr 
      WHERE rr.id = reservation_request_id 
      AND rr.requestor_id = current_user_id()
    )
    -- OR managers/admins
    OR has_permission('reservation_payments', 'read')
  );

-- Only admins can modify payments (waive, refund, etc.)
CREATE POLICY "reservation_payments: admin modify" ON reservation_payments
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- ============================================================================
-- SECTION 11: METADATA CONFIGURATION
-- ============================================================================

-- Configure entities
-- NOTE: holiday_rules metadata is in mpra_holidays_dashboard.sql (Part 2)
INSERT INTO metadata.entities (table_name, display_name, description, sort_order, search_fields, show_calendar, calendar_property_name)
VALUES
  ('reservation_payment_types', 'Payment Types', 'System lookup: types of payments for reservations', 99, NULL, FALSE, NULL),
  ('reservation_requests', 'Reservation Requests', 'Clubhouse reservation requests and approved bookings', 10,
   NULL, TRUE, 'time_slot'),
  ('reservation_payments', 'Reservation Payments', 'Payment tracking for reservation requests', 20, NULL, FALSE, NULL)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  search_fields = EXCLUDED.search_fields,
  show_calendar = EXCLUDED.show_calendar,
  calendar_property_name = EXCLUDED.calendar_property_name;

-- Configure status_id property for frontend detection (reservation_requests)
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, status_entity_type)
VALUES ('reservation_requests', 'status_id', 'Status', 'Current status of the reservation request', 5, TRUE, FALSE, TRUE, TRUE, 'reservation_request')
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status_entity_type = EXCLUDED.status_entity_type;

-- Configure status_id property for frontend detection (reservation_payments)
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, status_entity_type, filterable)
VALUES ('reservation_payments', 'status_id', 'Status', 'Current payment status', 5, TRUE, FALSE, TRUE, TRUE, 'reservation_payment', TRUE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status_entity_type = EXCLUDED.status_entity_type,
  filterable = EXCLUDED.filterable;

-- Hide internal denormalized columns (used only for display_name generation)
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail)
VALUES
  ('reservation_payments', 'payment_type_name', 'Payment Type Name', 'Internal: denormalized for display_name', 998, FALSE, FALSE, FALSE, FALSE),
  ('reservation_payments', 'status_name', 'Status Name', 'Internal: denormalized for display_name', 999, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = FALSE,
  show_on_create = FALSE,
  show_on_edit = FALSE,
  show_on_detail = FALSE;

-- Configure property display settings for reservation_requests
INSERT INTO metadata.properties (table_name, column_name, display_name, description, sort_order, show_on_list, show_on_create, show_on_edit, show_on_detail, column_width, filterable)
VALUES
  -- Requestor Info Section
  ('reservation_requests', 'requestor_name', 'Your Name', 'Full name of person making the request', 10, TRUE, TRUE, FALSE, TRUE, 2, FALSE),
  ('reservation_requests', 'requestor_address', 'Mailing Address', 'Your mailing address', 11, FALSE, TRUE, FALSE, TRUE, 2, FALSE),
  ('reservation_requests', 'requestor_phone', 'Phone Number', 'Contact phone number', 12, FALSE, TRUE, FALSE, TRUE, 1, FALSE),
  ('reservation_requests', 'requestor_id', 'Requestor', 'User account (from login)', 13, TRUE, FALSE, FALSE, TRUE, 1, TRUE),
  ('reservation_requests', 'organization_name', 'Organization Name', 'If representing an organization (optional)', 14, TRUE, TRUE, FALSE, TRUE, 2, FALSE),
  
  -- Event Details Section
  ('reservation_requests', 'event_type', 'Type of Event', 'Description of your event (e.g., Birthday Party, Community Meeting)', 20, TRUE, TRUE, FALSE, TRUE, 2, FALSE),
  ('reservation_requests', 'time_slot', 'Event Date/Time', 'Start and end date/time for your event', 21, TRUE, TRUE, FALSE, TRUE, 2, FALSE),
  ('reservation_requests', 'attendee_count', 'Approx. Number of Attendees', 'Expected number of guests (max 75)', 22, TRUE, TRUE, FALSE, TRUE, 1, FALSE),
  ('reservation_requests', 'attendee_ages', 'Approx. Ages of Attendees', 'Age range of guests (for supervision requirements)', 23, FALSE, TRUE, FALSE, TRUE, 2, FALSE),
  
  -- Event Flags Section
  ('reservation_requests', 'is_food_served', 'Will Food Be Served?', 'Note: Cooking is not permitted. Food must be catered or prepared off-site.', 30, FALSE, TRUE, FALSE, TRUE, 1, TRUE),
  ('reservation_requests', 'is_public_event', 'Is This a Public Event?', 'Public events will have details shown on the calendar', 31, TRUE, TRUE, FALSE, TRUE, 1, TRUE),
  ('reservation_requests', 'is_fundraiser', 'Is This a Fundraiser?', 'Is this event a fundraising event?', 32, FALSE, TRUE, FALSE, TRUE, 1, TRUE),
  ('reservation_requests', 'is_admission_charged', 'Will You Charge Admission?', 'Will attendees be charged to enter?', 33, FALSE, TRUE, FALSE, TRUE, 1, FALSE),
  
  -- Agreement Section (TODO: Static text feature needed for policy display)
  ('reservation_requests', 'policy_agreed', 'I Agree to the Facility Use Policy',
   'I agree to be responsible for the conduct of our group, for damages to the facility or parkland, and to leave the park in the condition it was found.',
   40, FALSE, TRUE, FALSE, TRUE, 2, FALSE),
  ('reservation_requests', 'policy_agreed_at', 'Policy Agreed At',
   'When the requestor agreed to the facility use policy', 41, FALSE, FALSE, FALSE, TRUE, 1, FALSE),

  -- Review Section (Manager/Admin only - set by workflow, not editable directly)
  ('reservation_requests', 'reviewed_by', 'Reviewed By', 'Staff member who reviewed this request', 50, FALSE, FALSE, FALSE, TRUE, 1, FALSE),
  ('reservation_requests', 'reviewed_at', 'Reviewed At', 'When the request was reviewed', 51, FALSE, FALSE, FALSE, TRUE, 1, FALSE),
  ('reservation_requests', 'denial_reason', 'Denial Reason', 'Reason for denying the request (required if denied)', 52, FALSE, FALSE, TRUE, TRUE, 2, FALSE),
  ('reservation_requests', 'cancellation_reason', 'Cancellation Reason', 'Reason for cancellation (required if cancelled)', 53, FALSE, FALSE, TRUE, TRUE, 2, FALSE),
  ('reservation_requests', 'cancelled_by', 'Cancelled By', 'Staff member who cancelled this reservation', 54, FALSE, FALSE, FALSE, TRUE, 1, FALSE),
  ('reservation_requests', 'cancelled_at', 'Cancelled At', 'When this reservation was cancelled', 55, FALSE, FALSE, FALSE, TRUE, 1, FALSE),
  
  -- Computed Pricing (Read-only)
  ('reservation_requests', 'is_holiday_or_weekend', 'Holiday/Weekend Rate?', 'Whether holiday pricing applies', 60, FALSE, FALSE, FALSE, TRUE, 1, TRUE),
  ('reservation_requests', 'facility_fee_amount', 'Facility Fee', 'Calculated facility fee based on event date', 61, TRUE, FALSE, FALSE, TRUE, 1, FALSE),
  
  -- System fields (hidden from create/edit)
  ('reservation_requests', 'created_at', 'Submitted', 'When the request was submitted', 90, TRUE, FALSE, FALSE, TRUE, 1, FALSE),
  ('reservation_requests', 'updated_at', 'Last Updated', 'When the request was last modified', 91, FALSE, FALSE, FALSE, TRUE, 1, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail,
  column_width = EXCLUDED.column_width,
  filterable = EXCLUDED.filterable;

-- ============================================================================
-- SECTION 12: VALIDATION RULES
-- ============================================================================

-- Attendee count validation
INSERT INTO metadata.validations (table_name, column_name, validation_type, validation_value, error_message, sort_order)
VALUES
  ('reservation_requests', 'attendee_count', 'min', '1', 'At least 1 attendee is required', 1),
  ('reservation_requests', 'attendee_count', 'max', '75', 'Maximum capacity is 75 people per facility policy', 2)
ON CONFLICT (table_name, column_name, validation_type) DO UPDATE SET
  validation_value = EXCLUDED.validation_value,
  error_message = EXCLUDED.error_message;

-- Constraint messages for backend validation
INSERT INTO metadata.constraint_messages (constraint_name, table_name, column_name, error_message)
VALUES
  ('valid_time_slot_bounds', 'reservation_requests', 'time_slot', 'Invalid time slot: end time must be after start time.'),
  ('policy_must_be_agreed', 'reservation_requests', 'policy_agreed', 'You must agree to the Facility and Parkland Use Policy to submit a reservation request.'),
  ('attendee_count_positive', 'reservation_requests', 'attendee_count', 'Number of attendees must be between 1 and 75 (maximum capacity).')
  -- NOTE: Overlap constraint is on public_calendar_events (see 05_mpra_public_calendar.sql)
ON CONFLICT (constraint_name) DO UPDATE SET
  error_message = EXCLUDED.error_message;

-- ============================================================================
-- SECTION 13: NOTIFICATION TEMPLATES
-- ============================================================================

-- Template: New reservation request submitted (notify managers)
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'reservation_request_submitted',
  'Notify managers when a new reservation request is submitted',
  'reservation_requests',
  'New Reservation Request: {{.Entity.event_type}}',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #2563eb;">New Reservation Request</h2>
    <p><strong>Requestor:</strong> {{.Entity.requestor_name}}</p>
    {{if .Entity.organization_name}}<p><strong>Organization:</strong> {{.Entity.organization_name}}</p>{{end}}
    <p><strong>Event Type:</strong> {{.Entity.event_type}}</p>
    <p><strong>Date/Time:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p><strong>Attendees:</strong> {{.Entity.attendee_count}}</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #2563eb; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        Review Request
      </a>
    </p>
  </div>',
  'New Reservation Request

Requestor: {{.Entity.requestor_name}}
{{if .Entity.organization_name}}Organization: {{.Entity.organization_name}}{{end}}
Event Type: {{.Entity.event_type}}
Date/Time: {{formatTimeSlot .Entity.time_slot}}
Attendees: {{.Entity.attendee_count}}

Review at: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Template: Reservation approved
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'reservation_request_approved',
  'Notify requestor when their reservation is approved',
  'reservation_requests',
  'Your Reservation Request Has Been Approved!',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #22C55E;">✓ Reservation Approved</h2>
    <p>Great news! Your reservation request for <strong>{{.Entity.event_type}}</strong> has been approved.</p>
    <h3>Event Details</h3>
    <p><strong>Date/Time:</strong> {{formatTimeSlot .Entity.time_slot}}</p>
    <p><strong>Location:</strong> Mott Park Recreation Area Clubhouse</p>
    <h3>Payment Schedule</h3>
    <ul>
      <li><strong>Security Deposit ($150):</strong> Due immediately</li>
      <li><strong>Facility Fee ({{formatMoney .Entity.facility_fee_amount}}):</strong> Due 30 days before event</li>
      <li><strong>Cleaning Fee ($75):</strong> Due before event</li>
    </ul>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #22C55E; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Reservation & Make Payment
      </a>
    </p>
  </div>',
  'RESERVATION APPROVED

Your reservation request for {{.Entity.event_type}} has been approved!

Event Details:
- Date/Time: {{formatTimeSlot .Entity.time_slot}}
- Location: Mott Park Recreation Area Clubhouse

Payment Schedule:
- Security Deposit ($150): Due immediately
- Facility Fee ({{formatMoney .Entity.facility_fee_amount}}): Due 30 days before event
- Cleaning Fee ($75): Due before event

View and pay at: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Template: Reservation denied
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'reservation_request_denied',
  'Notify requestor when their reservation is denied',
  'reservation_requests',
  'Reservation Request Update',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #EF4444;">Reservation Request Denied</h2>
    <p>We regret to inform you that your reservation request for <strong>{{.Entity.event_type}}</strong> was not approved.</p>
    <p><strong>Reason:</strong> {{.Entity.denial_reason}}</p>
    <p>If you have questions, please contact the Mott Park Recreation Association.</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #6B7280; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Details
      </a>
    </p>
  </div>',
  'RESERVATION REQUEST DENIED

Your reservation request for {{.Entity.event_type}} was not approved.

Reason: {{.Entity.denial_reason}}

If you have questions, please contact the Mott Park Recreation Association.

View details: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- Template: Reservation cancelled
INSERT INTO metadata.notification_templates (name, description, entity_type, subject_template, html_template, text_template)
VALUES (
  'reservation_request_cancelled',
  'Notify requestor when their reservation is cancelled',
  'reservation_requests',
  'Reservation Cancelled',
  '<div style="font-family: Arial, sans-serif;">
    <h2 style="color: #6B7280;">Reservation Cancelled</h2>
    <p>Your reservation for <strong>{{.Entity.event_type}}</strong> has been cancelled.</p>
    <p><strong>Reason:</strong> {{.Entity.cancellation_reason}}</p>
    <p>Any payments made will be refunded according to our refund policy. Security deposits are fully refundable. Facility fees are refundable if cancelled more than 30 days before the event.</p>
    <p>
      <a href="{{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}"
         style="display: inline-block; background-color: #6B7280; color: white;
                padding: 12px 24px; text-decoration: none; border-radius: 4px;">
        View Details
      </a>
    </p>
  </div>',
  'RESERVATION CANCELLED

Your reservation for {{.Entity.event_type}} has been cancelled.

Reason: {{.Entity.cancellation_reason}}

Any payments made will be refunded according to our refund policy.

View details: {{.Metadata.site_url}}/view/reservation_requests/{{.Entity.id}}'
) ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  subject_template = EXCLUDED.subject_template,
  html_template = EXCLUDED.html_template,
  text_template = EXCLUDED.text_template;

-- ============================================================================
-- SECTION 14: NOTIFICATION TRIGGERS
-- ============================================================================

-- Trigger: Notify managers on new request
CREATE OR REPLACE FUNCTION notify_new_reservation_request()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request_data JSONB;
  v_manager_id UUID;
BEGIN
  -- Build request data (pass raw time_slot - Go service handles formatting/timezone)
  SELECT jsonb_build_object(
    'id', NEW.id,
    'requestor_name', NEW.requestor_name,
    'organization_name', NEW.organization_name,
    'event_type', NEW.event_type,
    'time_slot', NEW.time_slot::TEXT,
    'attendee_count', NEW.attendee_count
  ) INTO v_request_data;
  
  -- Notify all users with manager role
  FOR v_manager_id IN 
    SELECT DISTINCT u.id 
    FROM metadata.civic_os_users u
    JOIN metadata.user_roles ur ON u.id = ur.user_id
    JOIN metadata.roles r ON ur.role_id = r.id
    WHERE r.display_name IN ('manager', 'admin')
  LOOP
    PERFORM create_notification(
      p_user_id := v_manager_id,
      p_template_name := 'reservation_request_submitted',
      p_entity_type := 'reservation_requests',
      p_entity_id := NEW.id::text,
      p_entity_data := v_request_data,
      p_channels := ARRAY['email']::TEXT[]
    );
  END LOOP;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_request_created_notification
  AFTER INSERT ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_new_reservation_request();

-- Trigger: Notify requestor on status change
CREATE OR REPLACE FUNCTION notify_reservation_status_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = metadata, public
LANGUAGE plpgsql AS $$
DECLARE
  v_request_data JSONB;
  v_new_status_name TEXT;
  v_template_name TEXT;
BEGIN
  -- Only proceed if status changed
  IF NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN
    RETURN NEW;
  END IF;
  
  -- Get the new status name
  SELECT display_name INTO v_new_status_name
  FROM metadata.statuses
  WHERE id = NEW.status_id AND entity_type = 'reservation_request';
  
  -- Determine which template to use
  v_template_name := CASE v_new_status_name
    WHEN 'Approved' THEN 'reservation_request_approved'
    WHEN 'Denied' THEN 'reservation_request_denied'
    WHEN 'Cancelled' THEN 'reservation_request_cancelled'
    ELSE NULL
  END;
  
  -- Exit if no template for this status
  IF v_template_name IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Build request data (pass raw time_slot - Go service handles formatting/timezone)
  SELECT jsonb_build_object(
    'id', NEW.id,
    'requestor_name', NEW.requestor_name,
    'organization_name', NEW.organization_name,
    'event_type', NEW.event_type,
    'time_slot', NEW.time_slot::TEXT,
    'attendee_count', NEW.attendee_count,
    'facility_fee_amount', NEW.facility_fee_amount::TEXT,
    'denial_reason', NEW.denial_reason,
    'cancellation_reason', NEW.cancellation_reason,
    'status', jsonb_build_object(
      'display_name', v_new_status_name
    )
  ) INTO v_request_data;
  
  -- Send notification to requestor
  PERFORM create_notification(
    p_user_id := NEW.requestor_id,
    p_template_name := v_template_name,
    p_entity_type := 'reservation_requests',
    p_entity_id := NEW.id::text,
    p_entity_data := v_request_data,
    p_channels := ARRAY['email']::TEXT[]
  );
  
  -- TODO: Log status change to Entity Notes when feature is available
  -- For now, the notification record in metadata.notifications serves as an audit log
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_status_change_notification
  AFTER UPDATE ON reservation_requests
  FOR EACH ROW
  EXECUTE FUNCTION notify_reservation_status_change();

-- ============================================================================
-- SECTION 15: SEED DATA
-- ============================================================================

-- NOTE: Holiday rules seed data is in mpra_holidays_dashboard.sql (Part 2)
-- The evergreen holiday system automatically calculates dates for any year.

-- ============================================================================
-- SECTION 16: ROLE PERMISSIONS CONFIGURATION
-- ============================================================================

-- Ensure roles exist (using conditional INSERT since there's no unique constraint on display_name)
INSERT INTO metadata.roles (display_name, description)
SELECT 'manager', 'Can approve/deny/cancel reservation requests and view all details'
WHERE NOT EXISTS (SELECT 1 FROM metadata.roles WHERE display_name = 'manager');

INSERT INTO metadata.roles (display_name, description)
SELECT 'admin', 'Full system access including fee adjustments and holiday management'
WHERE NOT EXISTS (SELECT 1 FROM metadata.roles WHERE display_name = 'admin');

-- =====================================================
-- CREATE PERMISSIONS
-- =====================================================

-- Create permissions for all mott park tables
-- NOTE: holiday_rules permissions are configured in mpra_holidays_dashboard.sql (Part 2)
INSERT INTO metadata.permissions (table_name, permission) VALUES
  ('reservation_payment_types', 'read'),
  ('reservation_requests', 'read'),
  ('reservation_requests', 'create'),
  ('reservation_requests', 'update'),
  ('reservation_requests', 'delete'),
  ('reservation_payments', 'read'),
  ('reservation_payments', 'create'),
  ('reservation_payments', 'update'),
  ('reservation_payments', 'delete')
ON CONFLICT (table_name, permission) DO NOTHING;

-- =====================================================
-- MAP PERMISSIONS TO ROLES
-- =====================================================

-- Grant read permission on payment_types to all authenticated users
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_payment_types'
  AND p.permission = 'read'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant read permission on reservation_requests to staff roles only
-- Regular 'user' role relies on RLS policy (sees own + approved/completed)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'read'
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create permission for reservation_requests to authenticated users
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'create'
  AND r.display_name IN ('user', 'editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant update permission on reservation_requests to managers and admins (approve/deny/cancel)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'update'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant delete permission on reservation_requests to admins only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_requests'
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Grant read permission on reservation_payments to staff roles only
-- Regular 'user' role relies on RLS policy (sees only payments for own reservations)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_payments'
  AND p.permission = 'read'
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant create/update on reservation_payments to editors and managers (mark as paid/waived)
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_payments'
  AND p.permission IN ('create', 'update')
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Grant delete on reservation_payments to admins only
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name = 'reservation_payments'
  AND p.permission = 'delete'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- Grant recurring schedule permissions to editor/manager/admin
INSERT INTO metadata.permission_roles (permission_id, role_id)
SELECT p.id, r.id
FROM metadata.permissions p
CROSS JOIN metadata.roles r
WHERE p.table_name IN ('time_slot_series_groups', 'time_slot_series', 'time_slot_instances')
  AND r.display_name IN ('editor', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- IMPLEMENTATION NOTES
-- ============================================================================

/*
PLANNED FEATURES REQUIRED FOR FULL IMPLEMENTATION:

1. ENTITY NOTES (Status Change Logging) ⚠️
   - Feature Status: Planned, not implemented
   - Current Workaround: Status change notifications are logged in metadata.notifications
   - Desired: Dedicated notes/comments section on detail page showing status history
   - Impact: Managers cannot see full audit trail of status changes on the detail page

2. STATIC TEXT ON FORMS ⚠️
   - Feature Status: Planned, not implemented
   - Current Workaround: policy_agreed boolean with description text
   - Desired: Display full policy text above agreement checkbox
   - Impact: Users must view policy separately; agreement checkbox alone may not suffice

3. ACTION BUTTONS ⚠️
   - Feature Status: Planned, not implemented
   - Current Workaround: Managers update status via edit form
   - Desired: "Approve", "Deny", "Cancel" buttons on detail page
   - Impact: Status changes require navigating to edit mode

4. RECURRING TIME SLOTS ⚠️
   - Feature Status: Planned
   - Impact: Regular community group meetings must create individual requests

PAYMENT SYSTEM NOTES:

The current design fully supports individual credit card payments for each fee:
- Each reservation_payments record has its own payment_transaction_id
- Each links to a separate Stripe PaymentIntent via payments.transactions
- No additional development needed for multi-payment support

The payment_initiation_rpc pattern should be configured per payment type, or
a custom RPC can be created to initiate payment for a specific reservation_payments record.

CALENDAR VISIBILITY NOTES:

- All approved/completed events appear on the public calendar
- is_public_event=TRUE: Full details shown (organization, event type)
- is_public_event=FALSE: Only shows "Private Event" 
- Managers/Admins see full details for all events via display_name_full
- The display_name computed column handles this automatically

PAYMENT SCHEDULE:

1. Security Deposit ($150): Due immediately upon approval
2. Facility Fee ($150 weekday / $300 weekend+holiday): Due 30 days before event
3. Cleaning Fee ($75): Due 7 days before event

All payment records are created automatically when status changes to "Approved".
Manual refunds are processed by staff through the reservation_payments table.
*/

-- Complete transaction
COMMIT;

-- ROLLBACK;