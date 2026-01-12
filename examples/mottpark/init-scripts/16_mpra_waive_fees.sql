-- =============================================================================
-- WAIVE ALL FEES FEATURE + POLICY UPDATE
--
-- 1. Adds "Waive All Fees" button to Reservation Request detail page
-- 2. Auto-waives pending payments when a reservation is cancelled
-- 3. Updates facility policy with checkout requirements
--
-- PREREQUISITE: Run v0-25-1-add-status-key migration first to add status_key
--               column and get_status_id() helper function.
--
-- This script is idempotent and safe to re-run.
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 1: WAIVE ALL FEES ENTITY ACTION
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 Add can_waive_fees column to track button visibility
-- -----------------------------------------------------------------------------
ALTER TABLE reservation_requests
ADD COLUMN IF NOT EXISTS can_waive_fees BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN reservation_requests.can_waive_fees IS
  'Trigger-maintained flag: TRUE when status=Approved AND has pending payments';

-- -----------------------------------------------------------------------------
-- 1.2 Create trigger function to maintain can_waive_fees
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_can_waive_fees()
RETURNS TRIGGER AS $$
DECLARE
  v_approved_status_id INT;
  v_pending_status_id INT;
  v_has_pending BOOLEAN;
  v_target_request_id BIGINT;
BEGIN
  -- Get status IDs using stable status_key (not display_name)
  v_approved_status_id := get_status_id('reservation_request', 'approved');
  v_pending_status_id := get_status_id('reservation_payment', 'pending');

  -- Determine which request to check/update
  IF TG_TABLE_NAME = 'reservation_requests' THEN
    v_target_request_id := NEW.id;
  ELSE
    v_target_request_id := COALESCE(NEW.reservation_request_id, OLD.reservation_request_id);
  END IF;

  -- Check if there are pending payments for this request
  SELECT EXISTS (
    SELECT 1 FROM reservation_payments
    WHERE reservation_request_id = v_target_request_id
      AND status_id = v_pending_status_id
  ) INTO v_has_pending;

  -- Update the column based on trigger source
  IF TG_TABLE_NAME = 'reservation_requests' THEN
    NEW.can_waive_fees := (NEW.status_id = v_approved_status_id AND v_has_pending);
    RETURN NEW;
  ELSE
    -- Called from reservation_payments trigger - update parent record
    UPDATE reservation_requests SET
      can_waive_fees = (status_id = v_approved_status_id AND v_has_pending)
    WHERE id = v_target_request_id;
    RETURN COALESCE(NEW, OLD);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 1.3 Create triggers (drop first if they exist for idempotency)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_reservation_requests_can_waive ON reservation_requests;
CREATE TRIGGER trg_reservation_requests_can_waive
  BEFORE INSERT OR UPDATE OF status_id ON reservation_requests
  FOR EACH ROW EXECUTE FUNCTION update_can_waive_fees();

DROP TRIGGER IF EXISTS trg_reservation_payments_can_waive ON reservation_payments;
CREATE TRIGGER trg_reservation_payments_can_waive
  AFTER INSERT OR UPDATE OF status_id OR DELETE ON reservation_payments
  FOR EACH ROW EXECUTE FUNCTION update_can_waive_fees();

-- -----------------------------------------------------------------------------
-- 1.4 Create the waive RPC function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.waive_all_reservation_payments(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_waived_status_id INT;
  v_pending_status_id INT;
  v_approved_status_id INT;
  v_request RECORD;
  v_waived_count INT;
BEGIN
  -- Get status IDs using stable status_key (not display_name)
  v_waived_status_id := get_status_id('reservation_payment', 'waived');
  v_pending_status_id := get_status_id('reservation_payment', 'pending');
  v_approved_status_id := get_status_id('reservation_request', 'approved');

  -- Verify request exists and is Approved
  SELECT * INTO v_request FROM reservation_requests WHERE id = p_entity_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  IF v_request.status_id != v_approved_status_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Can only waive fees for approved reservations');
  END IF;

  -- Check permission (manager or admin)
  IF NOT ('manager' = ANY(public.get_user_roles()) OR public.is_admin()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only managers can waive fees');
  END IF;

  -- Waive all pending payments
  UPDATE reservation_payments SET
    status_id = v_waived_status_id,
    waived_by = current_user_id(),
    waived_at = NOW(),
    waiver_reason = 'Fees waived by Manager'
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_pending_status_id;

  GET DIAGNOSTICS v_waived_count = ROW_COUNT;

  IF v_waived_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'No pending payments to waive');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', format('%s payment(s) waived successfully', v_waived_count),
    'refresh', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.waive_all_reservation_payments(BIGINT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 1.5 Update cancel_reservation_request to auto-waive pending payments
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_reservation_request(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request RECORD;
  v_cancelled_status_id INT;
  v_pending_request_status_id INT;
  v_approved_status_id INT;
  v_waived_status_id INT;
  v_pending_payment_status_id INT;
  v_paid_status_id INT;
  v_paid_payments INT;
  v_waived_payments INT;
BEGIN
  -- Get status IDs using stable status_key (not display_name)
  v_cancelled_status_id := get_status_id('reservation_request', 'cancelled');
  v_pending_request_status_id := get_status_id('reservation_request', 'pending');
  v_approved_status_id := get_status_id('reservation_request', 'approved');
  v_waived_status_id := get_status_id('reservation_payment', 'waived');
  v_pending_payment_status_id := get_status_id('reservation_payment', 'pending');
  v_paid_status_id := get_status_id('reservation_payment', 'paid');

  -- Fetch request with lock
  SELECT * INTO v_request
  FROM reservation_requests
  WHERE id = p_entity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Reservation request not found');
  END IF;

  -- Check current status is Approved or Pending
  IF v_request.status_id NOT IN (v_pending_request_status_id, v_approved_status_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only pending or approved requests can be cancelled');
  END IF;

  -- Check user has manager or admin role
  IF NOT (public.has_permission('reservation_requests', 'update') AND
          ('manager' = ANY(public.get_user_roles()) OR public.is_admin())) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You do not have permission to cancel requests');
  END IF;

  -- Check for paid payments that may need refund
  SELECT COUNT(*) INTO v_paid_payments
  FROM reservation_payments
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_paid_status_id;

  -- Update the request status
  UPDATE reservation_requests SET
    status_id = v_cancelled_status_id,
    cancelled_by = current_user_id(),
    cancelled_at = NOW()
  WHERE id = p_entity_id;

  -- Auto-waive all pending payments
  UPDATE reservation_payments SET
    status_id = v_waived_status_id,
    waived_by = current_user_id(),
    waived_at = NOW(),
    waiver_reason = 'Reservation cancelled'
  WHERE reservation_request_id = p_entity_id
    AND status_id = v_pending_payment_status_id;

  GET DIAGNOSTICS v_waived_payments = ROW_COUNT;

  -- Build response message
  IF v_paid_payments > 0 AND v_waived_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. %s pending payment(s) waived. Note: %s paid payment(s) may require refund processing.', v_waived_payments, v_paid_payments),
      'refresh', true
    );
  ELSIF v_paid_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. Note: %s payment(s) may require refund processing.', v_paid_payments),
      'refresh', true
    );
  ELSIF v_waived_payments > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', format('Request cancelled. %s pending payment(s) waived. The requestor will be notified.', v_waived_payments),
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

-- -----------------------------------------------------------------------------
-- 1.6 Register the entity action
-- -----------------------------------------------------------------------------
INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description, rpc_function,
  icon, button_style, sort_order,
  requires_confirmation, confirmation_message,
  visibility_condition,
  default_success_message, refresh_after_action, show_on_detail
) VALUES (
  'reservation_requests',
  'waive_all_fees',
  'Waive All Fees',
  'Waive all pending payments for this reservation',
  'waive_all_reservation_payments',
  'money_off',
  'secondary',
  50,
  TRUE,
  'Are you sure you want to waive all pending fees for this reservation?',
  '{"field": "can_waive_fees", "operator": "eq", "value": true}'::jsonb,
  'Fees waived successfully',
  TRUE,
  TRUE
) ON CONFLICT (table_name, action_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  rpc_function = EXCLUDED.rpc_function,
  icon = EXCLUDED.icon,
  button_style = EXCLUDED.button_style,
  requires_confirmation = EXCLUDED.requires_confirmation,
  confirmation_message = EXCLUDED.confirmation_message,
  visibility_condition = EXCLUDED.visibility_condition,
  refresh_after_action = EXCLUDED.refresh_after_action;

-- -----------------------------------------------------------------------------
-- 1.7 Grant action to manager role only
-- -----------------------------------------------------------------------------
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reservation_requests'
  AND ea.action_name = 'waive_all_fees'
  AND r.display_name = 'manager'
ON CONFLICT DO NOTHING;

-- Also grant to admin for consistency
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM metadata.entity_actions ea
CROSS JOIN metadata.roles r
WHERE ea.table_name = 'reservation_requests'
  AND ea.action_name = 'waive_all_fees'
  AND r.display_name = 'admin'
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 1.8 Initialize can_waive_fees for existing records
-- -----------------------------------------------------------------------------
UPDATE reservation_requests rr SET
  can_waive_fees = (
    rr.status_id = get_status_id('reservation_request', 'approved')
    AND EXISTS (
      SELECT 1 FROM reservation_payments rp
      WHERE rp.reservation_request_id = rr.id
        AND rp.status_id = get_status_id('reservation_payment', 'pending')
    )
  );

-- -----------------------------------------------------------------------------
-- 1.9 Hide can_waive_fees from UI (internal use only)
-- -----------------------------------------------------------------------------
INSERT INTO metadata.properties (table_name, column_name, show_on_list, show_on_detail, show_on_create, show_on_edit)
VALUES ('reservation_requests', 'can_waive_fees', FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (table_name, column_name) DO UPDATE SET
  show_on_list = FALSE, show_on_detail = FALSE, show_on_create = FALSE, show_on_edit = FALSE;


-- =============================================================================
-- PART 2: UPDATE FACILITY POLICY WITH CHECKOUT REQUIREMENTS
-- =============================================================================

UPDATE metadata.static_text
SET content = '## Mott Park Recreation Area Facility and Parkland Use Policy

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

### Checkout Requirements

Before leaving the facility, you must:

1. **Vacuum all floors** - A vacuum is provided in the utility closet.

2. **Remove all trash** - Take all garbage bags to the dumpsters located in the parking lot.

3. **Turn off all lights** - Ensure all interior and exterior lights are switched off.

**Failure to complete checkout requirements may result in forfeiture of your security deposit.**

### Fees

| Fee Type | Amount | Due |
|----------|--------|-----|
| Security Deposit | $150 | Upon approval |
| Facility Fee (Weekday) | $150 | 30 days before event |
| Facility Fee (Weekend/Holiday) | $300 | 30 days before event |
| Cleaning Fee | $75 | 30 days before event |

### Cancellation Policy

- **More than 30 days before event**: Full refund of all fees
- **Less than 30 days before event**: Security deposit refunded; facility and cleaning fees forfeited

### Liability

The person signing this reservation request assumes full responsibility for:
- The conduct of all guests and attendees
- Any damage to the facility or grounds
- Ensuring compliance with all rules and regulations

**The security deposit will be refunded within 14 days after the event if no damages are found.**

---'
WHERE table_name = 'reservation_requests'
  AND content LIKE '## Mott Park Recreation Area Facility and Parkland Use Policy%'
  AND show_on_create = TRUE;


-- =============================================================================
-- PART 3: RELOAD SCHEMA CACHE
-- =============================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
