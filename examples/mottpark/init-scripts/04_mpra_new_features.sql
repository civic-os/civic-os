-- ============================================================================
-- MOTT PARK RECREATION AREA - NEW FEATURES INTEGRATION
-- Part 4: Action Buttons, Static Text, Entity Notes, Recurring Schedules
-- ============================================================================
-- Run AFTER Parts 1-3
-- Requires Civic OS v0.19.0+ (all features)
-- ============================================================================

-- Wrap in transaction for atomic execution
BEGIN;

-- ============================================================================
-- SECTION 1: ENTITY ACTION BUTTONS
-- Approve, Deny, Cancel buttons on reservation request detail pages
-- ============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 RPC Functions for Actions
-- -----------------------------------------------------------------------------

-- APPROVE: Change status to Approved, calculate fees, create payment records
CREATE OR REPLACE FUNCTION public.approve_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_approved_status_id INT;
  v_facility_fee MONEY;
BEGIN
  -- Get approved status ID
  SELECT id INTO v_approved_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Approved';

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Pending
  IF v_request.status_id != (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be approved');
  END IF;

  -- Check user has manager or admin role
  IF NOT (public.has_permission('reservation_requests', 'update') AND 
          ('manager' = ANY(public.get_user_roles()) OR public.is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to approve requests');
  END IF;

  -- Calculate facility fee based on date
  v_facility_fee := calculate_facility_fee(lower(v_request.time_slot));

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_approved_status_id,
    reviewed_by = current_user_id(),
    reviewed_at = NOW(),
    facility_fee_amount = v_facility_fee
  WHERE id = p_entity_id;

  -- Payment records are created by the existing on_reservation_approved trigger

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Request approved! Facility fee: %s. Payment records have been created.', v_facility_fee::TEXT),
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_reservation_request(BIGINT) TO authenticated;

-- DENY: Change status to Denied
CREATE OR REPLACE FUNCTION public.deny_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_denied_status_id INT;
BEGIN
  -- Get denied status ID
  SELECT id INTO v_denied_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Denied';

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Pending
  IF v_request.status_id != (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending requests can be denied');
  END IF;

  -- Check user has manager or admin role
  IF NOT (public.has_permission('reservation_requests', 'update') AND 
          ('manager' = ANY(public.get_user_roles()) OR public.is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to deny requests');
  END IF;

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_denied_status_id,
    reviewed_by = current_user_id(),
    reviewed_at = NOW()
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Request has been denied. The requestor will be notified.',
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.deny_reservation_request(BIGINT) TO authenticated;

-- CANCEL: Change status to Cancelled
CREATE OR REPLACE FUNCTION public.cancel_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_cancelled_status_id INT;
  v_pending_payments INT;
BEGIN
  -- Get cancelled status ID
  SELECT id INTO v_cancelled_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Cancelled';

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Approved or Pending
  IF v_request.status_id NOT IN (
    SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name IN ('Pending', 'Approved')
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending or approved requests can be cancelled');
  END IF;

  -- Check user has manager or admin role
  IF NOT (public.has_permission('reservation_requests', 'update') AND 
          ('manager' = ANY(public.get_user_roles()) OR public.is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to cancel requests');
  END IF;

  -- Check for pending payments that may need refund
  SELECT COUNT(*) INTO v_pending_payments
  FROM reservation_payments rp
  JOIN metadata.statuses s ON rp.status_id = s.id
  WHERE rp.reservation_request_id = p_entity_id
    AND s.entity_type = 'reservation_payment'
    AND s.display_name = 'Paid';

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_cancelled_status_id,
    cancelled_by = current_user_id(),
    cancelled_at = NOW()
  WHERE id = p_entity_id;

  -- Build response message
  IF v_pending_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. Note: %s payment(s) may require refund processing.', v_pending_payments),
      'refresh', true
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Request has been cancelled. The requestor will be notified.',
      'refresh', true
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_reservation_request(BIGINT) TO authenticated;

-- MARK COMPLETED: Transition from Approved to Completed (for post-event)
CREATE OR REPLACE FUNCTION public.complete_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_completed_status_id INT;
BEGIN
  -- Get completed status ID
  SELECT id INTO v_completed_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Completed';

  -- Fetch request
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Approved
  IF v_request.status_id != (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only approved requests can be marked as completed');
  END IF;

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_completed_status_id
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Event marked as completed. Please complete the post-event assessment.',
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_reservation_request(BIGINT) TO authenticated;

-- CLOSE: Final status after deposit refund processed
CREATE OR REPLACE FUNCTION public.close_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  v_request RECORD;
  v_closed_status_id INT;
  v_deposit_status TEXT;
BEGIN
  -- Get closed status ID
  SELECT id INTO v_closed_status_id
  FROM metadata.statuses
  WHERE entity_type = 'reservation_request' AND display_name = 'Closed';

  -- Fetch request
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Completed
  IF v_request.status_id != (SELECT id FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Completed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only completed requests can be closed');
  END IF;

  -- Check deposit status
  SELECT s.display_name INTO v_deposit_status
  FROM reservation_payments rp
  JOIN reservation_payment_types rpt ON rp.payment_type_id = rpt.id
  JOIN metadata.statuses s ON rp.status_id = s.id
  WHERE rp.reservation_request_id = p_entity_id
    AND rpt.code = 'security_deposit';

  IF v_deposit_status = 'Paid' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Security deposit must be refunded or waived before closing. Please process the deposit first.'
    );
  END IF;

  -- Update the request
  UPDATE reservation_requests SET
    status_id = v_closed_status_id
  WHERE id = p_entity_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Reservation closed successfully.',
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_reservation_request(BIGINT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 1.2 Register Action Buttons in Metadata
-- -----------------------------------------------------------------------------

INSERT INTO metadata.entity_actions (
  table_name,
  action_name,
  display_name,
  description,
  rpc_function,
  icon,
  button_style,
  sort_order,
  requires_confirmation,
  confirmation_message,
  visibility_condition,
  enabled_condition,
  disabled_tooltip,
  refresh_after_action
) VALUES
  -- APPROVE button
  (
    'reservation_requests',
    'approve',
    'Approve',
    'Approve this reservation request',
    'approve_reservation_request',
    'check_circle',
    'success',
    10,
    TRUE,
    'Are you sure you want to approve this reservation request? This will create payment records for the requestor.',
    -- Visible when status is Pending (hide after approval/denial)
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id) 
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending'),
    -- Enabled when status is Pending
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id) 
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Pending'),
    'Only pending requests can be approved',
    TRUE
  ),
  
  -- NOTE: DENY and CANCEL buttons removed because they require denial_reason/cancellation_reason
  -- which the RPC functions would need to collect via a modal form (not supported yet)

  -- MARK COMPLETED button
  (
    'reservation_requests',
    'complete',
    'Mark Completed',
    'Mark this event as completed (post-event)',
    'complete_reservation_request',
    'task_alt',
    'accent',
    40,
    TRUE,
    'Mark this event as completed? This should be done after the event has concluded.',
    -- Visible when status is Approved
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id) 
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved'),
    -- Enabled when status is Approved
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id) 
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Approved'),
    'Only approved requests can be marked completed',
    TRUE
  ),
  
  -- CLOSE button
  (
    'reservation_requests',
    'close',
    'Close',
    'Close this reservation (after deposit processed)',
    'close_reservation_request',
    'lock',
    'secondary',
    50,
    TRUE,
    'Close this reservation? Ensure the security deposit has been refunded or waived first.',
    -- Visible when status is Completed
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id) 
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Completed'),
    -- Enabled when status is Completed
    (SELECT jsonb_build_object('field', 'status_id', 'operator', 'eq', 'value', id) 
     FROM metadata.statuses WHERE entity_type = 'reservation_request' AND display_name = 'Completed'),
    'Only completed requests can be closed',
    TRUE
  )
ON CONFLICT (table_name, action_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  rpc_function = EXCLUDED.rpc_function,
  icon = EXCLUDED.icon,
  button_style = EXCLUDED.button_style,
  visibility_condition = EXCLUDED.visibility_condition,
  enabled_condition = EXCLUDED.enabled_condition;

-- -----------------------------------------------------------------------------
-- 1.3 Grant Action Permissions to Roles
-- -----------------------------------------------------------------------------

-- Grant all actions to manager and admin roles
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reservation_requests'
  AND r.display_name IN ('manager', 'admin')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SECTION 2: STATIC TEXT BLOCKS
-- Policy display on create/detail pages
-- ============================================================================

-- Full Facility Use Policy on CREATE form
INSERT INTO metadata.static_text (
  table_name, 
  content, 
  sort_order, 
  column_width,
  show_on_detail, 
  show_on_create, 
  show_on_edit
) VALUES (
  'reservation_requests',
  '## Mott Park Recreation Area Facility and Parkland Use Policy

### Facility Rules

By submitting this reservation request, you acknowledge and agree to the following:

1. **No Alcohol** - Per City of Flint ordinance, no alcoholic beverages are permitted on the premises.

2. **No Cooking** - Only warming of food is permitted. All food must be catered or prepared off-site.

3. **No Open Flames** - Candles, grills, and other open flames are prohibited.

4. **No Smoking** - Smoking and vaping are prohibited within 20 feet of the building.

5. **Music Curfew** - All music must end by 10:00 PM.

6. **Vacancy Requirement** - All guests must vacate the premises by 11:00 PM.

7. **No Pets** - Only service animals are permitted.

8. **Capacity Limit** - Maximum occupancy is 75 persons.

### Fees

| Fee Type | Amount | Due |
|----------|--------|-----|
| Security Deposit | $150 | Upon approval |
| Facility Fee (Weekday) | $150 | 30 days before event |
| Facility Fee (Weekend/Holiday) | $300 | 30 days before event |
| Cleaning Fee | $75 | 7 days before event |

### Cancellation Policy

- **More than 30 days before event**: Full refund of all fees
- **Less than 30 days before event**: Security deposit refunded; facility and cleaning fees forfeited

### Liability

The person signing this reservation request assumes full responsibility for:
- The conduct of all guests and attendees
- Any damage to the facility or grounds
- Ensuring compliance with all rules and regulations

**The security deposit will be refunded within 14 days after the event if no damages are found.**

---',
  1,     -- Sort order: FIRST (before all form fields)
  2,     -- Column width: full width
  FALSE, -- Don't show on detail (we have a shorter version there)
  TRUE,  -- Show on create
  FALSE  -- Don't show on edit
);

-- Shorter reminder on DETAIL page
INSERT INTO metadata.static_text (
  table_name, 
  content, 
  sort_order, 
  column_width,
  show_on_detail, 
  show_on_create, 
  show_on_edit
) VALUES (
  'reservation_requests',
  '### Important Reminders

- 🚫 No alcohol, cooking, or open flames
- 🎵 Music ends at 10 PM, guests leave by 11 PM
- 👥 Maximum 75 people
- 🐕 Service animals only

*The person who submitted this request is responsible for their group''s conduct and any damages.*',
  999,   -- Sort order: LAST (after all fields)
  2,     -- Column width: full width
  TRUE,  -- Show on detail
  FALSE, -- Don't show on create
  FALSE  -- Don't show on edit
);

-- "Before You Submit" guidance at top of create form
INSERT INTO metadata.static_text (
  table_name, 
  content, 
  sort_order, 
  column_width,
  show_on_detail, 
  show_on_create, 
  show_on_edit
) VALUES (
  'reservation_requests',
  '### Before You Submit

Please have the following information ready:
- Your preferred date and time (at least 10 days in advance)
- Estimated number of attendees (maximum 75)
- Purpose/type of event
- Contact phone number

**Processing Time**: Requests are typically reviewed within 2-3 business days.',
  0,     -- Sort order: VERY FIRST
  2,     -- Column width: full width
  FALSE, -- Don't show on detail
  TRUE,  -- Show on create
  FALSE  -- Don't show on edit
);

-- ============================================================================
-- SECTION 3: ENTITY NOTES SYSTEM
-- Enable notes for status change audit trail and manager comments
-- ============================================================================

-- Enable notes for reservation_requests
UPDATE metadata.entities
SET enable_notes = TRUE
WHERE table_name = 'reservation_requests';

-- Grant notes permissions to roles
-- Users can read notes on their own requests
-- Managers can read all notes and create notes
-- Admins have full access

-- Create virtual permissions for notes
DO $$
DECLARE
  v_manager_id SMALLINT;
  v_admin_id SMALLINT;
  v_user_id SMALLINT;
BEGIN
  SELECT id INTO v_manager_id FROM metadata.roles WHERE display_name = 'manager';
  SELECT id INTO v_admin_id FROM metadata.roles WHERE display_name = 'admin';
  SELECT id INTO v_user_id FROM metadata.roles WHERE display_name = 'user';

  -- Manager: read and create notes
  PERFORM set_role_permission(v_manager_id, 'reservation_requests:notes', 'read', TRUE);
  PERFORM set_role_permission(v_manager_id, 'reservation_requests:notes', 'create', TRUE);
  
  -- Admin: read and create notes
  PERFORM set_role_permission(v_admin_id, 'reservation_requests:notes', 'read', TRUE);
  PERFORM set_role_permission(v_admin_id, 'reservation_requests:notes', 'create', TRUE);
  
  -- User: read notes only (on their own requests - RLS handles this)
  PERFORM set_role_permission(v_user_id, 'reservation_requests:notes', 'read', TRUE);
END $$;

-- -----------------------------------------------------------------------------
-- 3.1 System Notes Trigger for Status Changes
-- -----------------------------------------------------------------------------

-- Create trigger function for status change notes
CREATE OR REPLACE FUNCTION add_reservation_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_old_status TEXT;
  v_new_status TEXT;
  v_note_content TEXT;
  v_actor_name TEXT;
BEGIN
  -- Get status display names
  SELECT display_name INTO v_old_status FROM metadata.statuses WHERE id = OLD.status_id;
  SELECT display_name INTO v_new_status FROM metadata.statuses WHERE id = NEW.status_id;
  
  -- Get actor name
  SELECT display_name INTO v_actor_name
  FROM metadata.civic_os_users
  WHERE id = current_user_id();

  -- Build note content based on the transition
  CASE v_new_status
    WHEN 'Approved' THEN
      v_note_content := format('**Status changed to Approved** by %s. Facility fee: %s', 
        COALESCE(v_actor_name, 'System'), 
        NEW.facility_fee_amount::TEXT);
    WHEN 'Denied' THEN
      v_note_content := format('**Status changed to Denied** by %s.%s', 
        COALESCE(v_actor_name, 'System'),
        CASE WHEN NEW.denial_reason IS NOT NULL 
          THEN E'\n\n**Reason:** ' || NEW.denial_reason 
          ELSE '' 
        END);
    WHEN 'Cancelled' THEN
      v_note_content := format('**Status changed to Cancelled** by %s.%s', 
        COALESCE(v_actor_name, 'System'),
        CASE WHEN NEW.cancellation_reason IS NOT NULL 
          THEN E'\n\n**Reason:** ' || NEW.cancellation_reason 
          ELSE '' 
        END);
    WHEN 'Completed' THEN
      v_note_content := format('**Event completed.** Marked by %s. Post-event assessment pending.', 
        COALESCE(v_actor_name, 'System'));
    WHEN 'Closed' THEN
      v_note_content := format('**Reservation closed** by %s. All processing complete.', 
        COALESCE(v_actor_name, 'System'));
    ELSE
      v_note_content := format('**Status changed** from %s to %s by %s', 
        v_old_status, v_new_status, COALESCE(v_actor_name, 'System'));
  END CASE;

  -- Create system note
  PERFORM create_entity_note(
    p_entity_type := 'reservation_requests'::NAME,
    p_entity_id := NEW.id::TEXT,
    p_content := v_note_content,
    p_note_type := 'system',
    p_author_id := current_user_id()
  );

  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS reservation_status_change_note_trigger ON reservation_requests;
CREATE TRIGGER reservation_status_change_note_trigger
  AFTER UPDATE OF status_id ON reservation_requests
  FOR EACH ROW
  WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
  EXECUTE FUNCTION add_reservation_status_change_note();

-- -----------------------------------------------------------------------------
-- 3.2 System Notes for Payment Status Changes
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION add_payment_status_change_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata, public
AS $$
DECLARE
  v_payment_type TEXT;
  v_note_content TEXT;
  v_actor_name TEXT;
  v_new_status TEXT;
BEGIN
  -- Get payment type name
  SELECT display_name INTO v_payment_type
  FROM reservation_payment_types
  WHERE id = NEW.payment_type_id;

  -- Get actor name
  SELECT display_name INTO v_actor_name
  FROM metadata.civic_os_users
  WHERE id = current_user_id();

  -- Get the new status display name
  SELECT display_name INTO v_new_status
  FROM metadata.statuses
  WHERE id = NEW.status_id;

  -- Build note content based on the status change
  CASE v_new_status
    WHEN 'Paid' THEN
      v_note_content := format('**%s payment received** (%s)', v_payment_type, NEW.amount::TEXT);
    WHEN 'Refunded' THEN
      v_note_content := format('**%s refunded** (%s) by %s', v_payment_type, NEW.amount::TEXT, COALESCE(v_actor_name, 'System'));
    WHEN 'Waived' THEN
      v_note_content := format('**%s waived** by %s', v_payment_type, COALESCE(v_actor_name, 'System'));
    ELSE
      RETURN NEW; -- Don't create note for other status changes
  END CASE;

  -- Create system note on the parent reservation request
  PERFORM create_entity_note(
    p_entity_type := 'reservation_requests'::NAME,
    p_entity_id := NEW.reservation_request_id::TEXT,
    p_content := v_note_content,
    p_note_type := 'system',
    p_author_id := current_user_id()
  );

  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS payment_status_change_note_trigger ON reservation_payments;
CREATE TRIGGER payment_status_change_note_trigger
  AFTER UPDATE OF status_id ON reservation_payments
  FOR EACH ROW
  WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
  EXECUTE FUNCTION add_payment_status_change_note();

-- ============================================================================
-- SECTION 4: RECURRING TIME SLOTS
-- Enable recurring schedules for community groups
-- ============================================================================

-- Enable recurring on reservation_requests entity
UPDATE metadata.entities SET
  supports_recurring = TRUE,
  recurring_property_name = 'time_slot'
WHERE table_name = 'reservation_requests';

-- Grant series management permissions to editor, manager, admin roles
DO $$
DECLARE
  v_role_id SMALLINT;
BEGIN
  FOR v_role_id IN
    SELECT id FROM metadata.roles WHERE display_name IN ('editor', 'manager', 'admin')
  LOOP
    -- Series groups (containers)
    PERFORM set_role_permission(v_role_id, 'time_slot_series_groups', 'read', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_series_groups', 'create', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_series_groups', 'update', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_series_groups', 'delete', TRUE);

    -- Series (RRULE definitions)
    PERFORM set_role_permission(v_role_id, 'time_slot_series', 'read', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_series', 'create', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_series', 'update', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_series', 'delete', TRUE);

    -- Instances (junction to entities)
    PERFORM set_role_permission(v_role_id, 'time_slot_instances', 'read', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_instances', 'create', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_instances', 'update', TRUE);
    PERFORM set_role_permission(v_role_id, 'time_slot_instances', 'delete', TRUE);
  END LOOP;
END $$;

-- ============================================================================
-- SECTION 5: UPDATE PROPERTY METADATA
-- Ensure proper display configuration for new features
-- ============================================================================

-- Hide internal tracking fields from forms but show on detail
UPDATE metadata.properties SET
  show_on_create = FALSE,
  show_on_edit = FALSE,
  show_on_detail = TRUE
WHERE table_name = 'reservation_requests'
  AND column_name IN ('reviewed_by', 'reviewed_at', 'cancelled_by', 'cancelled_at', 
                       'facility_fee_amount', 'request_age_days', 'days_until_event', 
                       'needs_attention');

-- Make denial_reason and cancellation_reason visible on detail but not editable directly
-- (they're set by the action buttons)
UPDATE metadata.properties SET
  show_on_create = FALSE,
  show_on_edit = FALSE,
  show_on_detail = TRUE
WHERE table_name = 'reservation_requests'
  AND column_name IN ('denial_reason', 'cancellation_reason');

-- ============================================================================
-- SECTION 6: PAYMENT INITIATION FOR RESERVATION_PAYMENTS
-- Each of the 3 payment types gets its own "Pay Now" button
-- ============================================================================

-- Payment initiation RPC for individual reservation payments
CREATE OR REPLACE FUNCTION public.initiate_reservation_payment(p_entity_id BIGINT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_payment RECORD;
  v_request RECORD;
  v_payment_type_name TEXT;
  v_idempotency_status TEXT;
  v_description TEXT;
BEGIN
  -- 1. Fetch payment record with lock
  SELECT rp.*, rpt.display_name as type_name, rpt.code as type_key, s.display_name as status_display
  INTO v_payment
  FROM public.reservation_payments rp
  JOIN public.reservation_payment_types rpt ON rp.payment_type_id = rpt.id
  JOIN metadata.statuses s ON rp.status_id = s.id
  WHERE rp.id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment record not found: %', p_entity_id;
  END IF;

  -- 2. Fetch parent reservation request for authorization and description
  SELECT rr.*
  INTO v_request
  FROM public.reservation_requests rr
  WHERE rr.id = v_payment.reservation_request_id;

  -- 3. Authorize: Only requestor can pay (match by user ID)
  IF v_request.requestor_id != current_user_id() AND NOT is_admin() THEN
    RAISE EXCEPTION 'You can only make payments for your own reservations';
  END IF;

  -- 4. Validate payment is payable (use status_display from joined statuses table)
  IF v_payment.status_display != 'Pending' THEN
    RAISE EXCEPTION 'This payment has already been processed (status: %)', v_payment.status_display;
  END IF;

  IF v_payment.status_display = 'Waived' THEN
    RAISE EXCEPTION 'This payment has been waived and does not require payment';
  END IF;

  -- 5. Check for existing payment (idempotency)
  v_idempotency_status := payments.check_existing_payment(v_payment.payment_transaction_id);

  IF v_idempotency_status = 'reuse' THEN
    RETURN v_payment.payment_transaction_id;  -- Payment in progress
  END IF;

  IF v_idempotency_status = 'duplicate' THEN
    RAISE EXCEPTION 'Payment already succeeded for this record';
  END IF;
  -- v_idempotency_status = 'create_new', proceed

  -- 6. Build description for Stripe
  v_description := format('%s - %s (%s)',
    v_payment.type_name,
    v_request.event_type,
    to_char(lower(v_request.time_slot), 'Mon DD, YYYY')
  );

  -- 7. Create and link payment using helper
  RETURN payments.create_and_link_payment(
    'reservation_payments',          -- Entity table
    'id',                             -- Entity PK column
    p_entity_id,                      -- Entity PK value
    'payment_transaction_id',         -- Payment FK column
    v_payment.amount::NUMERIC,        -- Amount (convert from MONEY)
    v_description                     -- Description for Stripe
  );
END;
$$;

COMMENT ON FUNCTION public.initiate_reservation_payment IS
'Initiate Stripe payment for a specific reservation payment record.
Each reservation has 3 payment records (deposit, facility, cleaning).
Users click "Pay Now" on each individual payment to process it.';

GRANT EXECUTE ON FUNCTION public.initiate_reservation_payment(BIGINT) TO authenticated;

-- Configure payment initiation for reservation_payments entity
UPDATE metadata.entities
SET
  payment_initiation_rpc = 'initiate_reservation_payment',
  payment_capture_mode = 'immediate'
WHERE table_name = 'reservation_payments';

-- Configure payment_transaction_id property display
INSERT INTO metadata.properties (
  table_name, column_name,
  display_name, description,
  sort_order,
  show_on_list, show_on_create, show_on_edit, show_on_detail
) VALUES (
  'reservation_payments', 'payment_transaction_id',
  'Payment', 'Stripe payment transaction',
  20,
  TRUE, FALSE, FALSE, TRUE
) ON CONFLICT (table_name, column_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  show_on_list = EXCLUDED.show_on_list,
  show_on_create = EXCLUDED.show_on_create,
  show_on_edit = EXCLUDED.show_on_edit,
  show_on_detail = EXCLUDED.show_on_detail;

-- ============================================================================
-- NOTIFY POSTGREST TO RELOAD SCHEMA
-- ============================================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

/*
-- Verify action buttons registered
SELECT table_name, action_name, display_name, button_style, icon
FROM metadata.entity_actions
WHERE table_name = 'reservation_requests'
ORDER BY sort_order;

-- Verify action permissions
SELECT ea.action_name, r.display_name as role
FROM metadata.entity_action_roles ear
JOIN metadata.entity_actions ea ON ear.entity_action_id = ea.id
JOIN metadata.roles r ON ear.role_id = r.id
WHERE ea.table_name = 'reservation_requests'
ORDER BY ea.sort_order, r.display_name;

-- Verify static text blocks
SELECT id, LEFT(content, 50) || '...' as content_preview, sort_order, 
       show_on_create, show_on_detail, show_on_edit
FROM metadata.static_text
WHERE table_name = 'reservation_requests'
ORDER BY sort_order;

-- Verify notes enabled
SELECT table_name, enable_notes, supports_recurring, recurring_property_name
FROM metadata.entities
WHERE table_name = 'reservation_requests';

-- Test recurring series creation (example)
-- SELECT create_recurring_series(
--   p_group_name := 'Monthly Board Meeting',
--   p_group_description := 'MPRA Board of Directors monthly meeting',
--   p_group_color := '#6366F1',
--   p_entity_table := 'reservation_requests',
--   p_entity_template := jsonb_build_object(
--     'requestor_name', 'MPRA Board',
--     'event_type', 'Board Meeting',
--     'attendee_count', 15,
--     'is_public_event', FALSE
--   ),
--   p_rrule := 'FREQ=MONTHLY;BYDAY=2TU;COUNT=12',  -- 2nd Tuesday of each month
--   p_dtstart := '2025-01-14T19:00:00'::timestamptz,
--   p_duration := 'PT2H',
--   p_timezone := 'America/Detroit',
--   p_time_slot_property := 'time_slot',
--   p_expand_now := TRUE,
--   p_skip_conflicts := TRUE
-- );
*/

-- Complete transaction
COMMIT;

-- ROLLBACK;