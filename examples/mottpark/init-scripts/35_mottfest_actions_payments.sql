-- =============================================================================
-- MOTT FEST - ENTITY ACTIONS AND PAYMENTS
-- =============================================================================
-- Organizer actions (review, payment recording, festival lifecycle) and the
-- applicant Pay Now path for the three Mott Fest application tables.
--
--   * Private helpers (mottfest_*) take the table name, check it against an
--     allowlist, and are granted to no API role. Thin public RPCs per table
--     call them, so each entity registers its own actions.
--   * Every public RPC is SECURITY DEFINER, authorizes with
--     has_permission('<table>', 'update'), locks the row FOR UPDATE and
--     returns {success, message, refresh}.
--   * Pay Now: inline payment_transaction_id plus one initiation RPC per table
--     that refuses non-payable applications with a friendly message. The card
--     payment record is created on approval, and only for card payers.
--     Deny, Withdraw and Record Payment unlink a still-pending card payment:
--     the frontend opens checkout for a pending payment without calling the
--     initiation RPC, so a linked pending payment would bypass the guard.
--   * sync_mottfest_payment_status() moves Approved -> Paid on a Stripe
--     success and only then; any other status gets a system note.
--
-- Status changes happen only through these actions (status_id is hidden on
-- the create and edit forms). A staff member with update permission can still
-- PATCH status_id through the API or MCP; that gap is accepted (see ADR).
--
-- Requires: 34_mottfest_schema.sql, Civic OS payments module
-- Idempotent: functions are replaced, actions and params are upserted.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. PRIVATE HELPERS (no EXECUTE grant to any API role)
-- =============================================================================

-- Allowlist: application table -> status entity_type. NULL for anything else.
CREATE OR REPLACE FUNCTION public.mottfest_entity_type(p_table TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'vendor_application'      THEN 'vendor_application'
    WHEN 'food_truck_application'  THEN 'food_truck_application'
    WHEN 'sponsorship_application' THEN 'sponsorship_application'
  END;
$$;

CREATE OR REPLACE FUNCTION public.mottfest_money_text(p_amount NUMERIC)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT to_char(COALESCE(p_amount, 0), 'FM$999,999,990.00');
$$;

-- Lock one application row and return the fields every action needs.
-- Returns NULL o_status_key when the row does not exist.
CREATE OR REPLACE FUNCTION public.mottfest_lock_application(
  p_table TEXT,
  p_id BIGINT,
  OUT o_status_key TEXT,
  OUT o_status_name TEXT,
  OUT o_applicant_id UUID,
  OUT o_amount_due NUMERIC,
  OUT o_paid_amount NUMERIC,
  OUT o_pref_key TEXT,
  OUT o_pref_name TEXT,
  OUT o_txn_id UUID,
  OUT o_festival_id BIGINT,
  OUT o_name TEXT
)
LANGUAGE plpgsql
SET search_path = public, metadata
AS $$
DECLARE
  v_status_id INT;
  v_pref_id INT;
BEGIN
  IF mottfest_entity_type(p_table) IS NULL THEN
    RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END IF;

  EXECUTE format(
    'SELECT status_id, applicant_id, amount_due::numeric, paid_amount::numeric,
            preferred_payment_method_id, payment_transaction_id, festival_id, display_name
       FROM public.%I WHERE id = $1 FOR UPDATE', p_table)
  INTO v_status_id, o_applicant_id, o_amount_due, o_paid_amount,
       v_pref_id, o_txn_id, o_festival_id, o_name
  USING p_id;

  IF v_status_id IS NULL THEN
    RETURN;
  END IF;

  SELECT s.status_key, s.display_name INTO o_status_key, o_status_name
  FROM metadata.statuses s WHERE s.id = v_status_id;

  SELECT s.status_key, s.display_name INTO o_pref_key, o_pref_name
  FROM metadata.statuses s WHERE s.id = v_pref_id;
END;
$$;

-- Common authorization for organizer actions.
CREATE OR REPLACE FUNCTION public.mottfest_require_reviewer(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, metadata
AS $$
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT has_permission(p_table, 'update') THEN
    RAISE EXCEPTION 'You do not have permission to manage Mott Fest applications.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- True when the linked payment is still open (the frontend would resume it).
CREATE OR REPLACE FUNCTION public.mottfest_payment_is_open(p_txn UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, payments
AS $$
  SELECT p_txn IS NOT NULL AND EXISTS (
    SELECT 1 FROM payments.transactions t
    WHERE t.id = p_txn AND t.status IN ('pending_intent', 'pending'));
$$;

-- Create the Stripe payment record for a card payer and link it to the row.
-- The applicant owns the transaction, so it is theirs even when an organizer
-- triggers its creation (approval, Enable Online Payment).
CREATE OR REPLACE FUNCTION public.mottfest_create_card_payment(
  p_table TEXT, p_id BIGINT, p_applicant UUID, p_amount NUMERIC,
  p_name TEXT, p_festival_id BIGINT)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_label TEXT;
  v_festival TEXT;
BEGIN
  v_label := CASE p_table
    WHEN 'vendor_application'      THEN 'booth vendor fee'
    WHEN 'food_truck_application'  THEN 'food truck fee'
    WHEN 'sponsorship_application' THEN 'sponsorship'
  END;
  IF v_label IS NULL THEN
    RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END IF;

  SELECT f.display_name INTO v_festival FROM festival f WHERE f.id = p_festival_id;

  RETURN payments.create_and_link_payment(
    p_table::NAME, 'id', p_id, 'payment_transaction_id',
    p_amount,
    format('%s %s - %s', COALESCE(v_festival, 'Mott Fest'), v_label, p_name),
    p_applicant);
END;
$$;

-- Approve / Waive Fee & Approve / Deny / Withdraw.
CREATE OR REPLACE FUNCTION public.mottfest_review(
  p_table TEXT, p_id BIGINT, p_action TEXT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_et TEXT := mottfest_entity_type(p_table);
  a RECORD;
  v_new TEXT;
  v_tier TEXT;
  v_unlink BOOLEAN;
  v_msg TEXT;
  v_due DATE;
  v_capacity INT;
  v_committed INT;
BEGIN
  IF v_et IS NULL THEN
    RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END IF;
  PERFORM mottfest_require_reviewer(p_table);

  SELECT * INTO a FROM mottfest_lock_application(p_table, p_id);
  IF a.o_status_key IS NULL THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;

  p_reason := NULLIF(btrim(p_reason), '');
  v_unlink := mottfest_payment_is_open(a.o_txn_id);

  CASE p_action
  WHEN 'approve', 'waive' THEN
    IF a.o_status_key <> 'pending' THEN
      RAISE EXCEPTION 'Only pending applications can be approved (this one is %).', a.o_status_name;
    END IF;
    IF p_action = 'waive' AND p_table <> 'vendor_application' THEN
      RAISE EXCEPTION 'Fees can only be waived for booth vendors.';
    END IF;

    IF p_table = 'sponsorship_application' THEN
      SELECT c.category_key INTO v_tier
      FROM sponsorship_application s JOIN metadata.categories c ON c.id = s.tier_id
      WHERE s.id = p_id;
    END IF;

    v_new := CASE
      WHEN p_action = 'waive' THEN 'waived'
      WHEN v_tier = 'in_kind' THEN 'in_kind'
      ELSE 'approved'
    END;

    -- Card payers get their payment record now, before the status change, so
    -- the approval email already sees it.
    IF v_new = 'approved' AND a.o_pref_key = 'credit_card' AND a.o_amount_due > 0
       AND payments.check_existing_payment(a.o_txn_id) = 'create_new' THEN
      PERFORM mottfest_create_card_payment(p_table, p_id, a.o_applicant_id,
        a.o_amount_due, a.o_name, a.o_festival_id);
    END IF;

    IF p_action = 'waive' THEN
      UPDATE vendor_application
      SET status_id = get_status_id(v_et, v_new),
          waiver_reason = p_reason,
          reviewed_by = current_user_id(),
          reviewed_at = NOW()
      WHERE id = p_id;
    ELSE
      EXECUTE format(
        'UPDATE public.%I SET status_id = $2, reviewed_by = $3, reviewed_at = NOW() WHERE id = $1',
        p_table)
      USING p_id, get_status_id(v_et, v_new), current_user_id();
    END IF;

    SELECT f.payment_due_date INTO v_due FROM festival f WHERE f.id = a.o_festival_id;
    v_msg := CASE v_new
      WHEN 'waived'  THEN format('Approved with the fee waived for %s.', a.o_name)
      WHEN 'in_kind' THEN format('In-kind sponsorship from %s approved. Nothing is due.', a.o_name)
      ELSE format('%s approved. %s is due by %s%s.', a.o_name,
        mottfest_money_text(a.o_amount_due), to_char(v_due, 'FMMonth FMDD, YYYY'),
        CASE WHEN a.o_pref_key = 'credit_card' AND a.o_amount_due > 0
             THEN ' (online card payment ready)' ELSE '' END)
    END;

    -- Capacity warning (booths and trucks only; sponsorships have no cap)
    IF p_table IN ('vendor_application', 'food_truck_application') THEN
      SELECT CASE WHEN p_table = 'vendor_application' THEN f.vendor_capacity ELSE f.food_truck_capacity END
      INTO v_capacity FROM festival f WHERE f.id = a.o_festival_id;
      IF v_capacity IS NOT NULL THEN
        EXECUTE format(
          'SELECT count(*) FROM public.%I WHERE festival_id = $1 AND status_id = ANY($2)', p_table)
        INTO v_committed
        USING a.o_festival_id, ARRAY[get_status_id(v_et, 'approved'), get_status_id(v_et, 'paid'),
                                     get_status_id(v_et, 'waived')];
        IF v_committed > v_capacity THEN
          v_msg := v_msg || format(' Warning: %s approved for %s %s.', v_committed, v_capacity, CASE WHEN v_capacity = 1 THEN 'spot' ELSE 'spots' END);
        END IF;
      END IF;
    END IF;

  WHEN 'deny' THEN
    IF a.o_status_key NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'Only pending or approved applications can be denied (this one is %).', a.o_status_name;
    END IF;
    IF p_reason IS NULL THEN
      RAISE EXCEPTION 'A denial reason is required.';
    END IF;
    EXECUTE format(
      'UPDATE public.%I SET status_id = $2, denial_reason = $3, reviewed_by = $4, reviewed_at = NOW(),
              payment_transaction_id = CASE WHEN $5 THEN NULL ELSE payment_transaction_id END
        WHERE id = $1', p_table)
    USING p_id, get_status_id(v_et, 'denied'), p_reason, current_user_id(), v_unlink;
    v_msg := format('%s denied. The reason will be emailed to the applicant.', a.o_name);

  WHEN 'withdraw' THEN
    IF a.o_status_key NOT IN ('pending', 'approved', 'paid', 'waived', 'in_kind') THEN
      RAISE EXCEPTION 'This application cannot be withdrawn (it is %).', a.o_status_name;
    END IF;
    IF p_reason IS NULL THEN
      RAISE EXCEPTION 'A withdrawal reason is required.';
    END IF;
    EXECUTE format(
      'UPDATE public.%I SET status_id = $2, withdrawal_reason = $3,
              payment_transaction_id = CASE WHEN $4 THEN NULL ELSE payment_transaction_id END
        WHERE id = $1', p_table)
    USING p_id, get_status_id(v_et, 'withdrawn'), p_reason, v_unlink;
    v_msg := format('%s withdrawn.%s', a.o_name,
      CASE WHEN a.o_status_key = 'paid' THEN ' Any refund is handled outside the system.' ELSE '' END);

  ELSE
    RAISE EXCEPTION 'Unknown review action: %', p_action;
  END CASE;

  RETURN jsonb_build_object('success', TRUE, 'message', v_msg, 'refresh', TRUE);
END;
$$;

-- Record a check, cash, money order or CashApp payment: Approved -> Paid.
CREATE OR REPLACE FUNCTION public.mottfest_record_payment(
  p_table TEXT, p_id BIGINT, p_payment_method_id INT,
  p_payment_date DATE DEFAULT NULL, p_payment_reference TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_et TEXT := mottfest_entity_type(p_table);
  a RECORD;
  v_method_key TEXT;
  v_method_name TEXT;
BEGIN
  IF v_et IS NULL THEN
    RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END IF;
  PERFORM mottfest_require_reviewer(p_table);

  SELECT * INTO a FROM mottfest_lock_application(p_table, p_id);
  IF a.o_status_key IS NULL THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;
  IF a.o_status_key <> 'approved' THEN
    RAISE EXCEPTION 'Only approved applications can be marked paid (this one is %).', a.o_status_name;
  END IF;

  SELECT s.status_key, s.display_name INTO v_method_key, v_method_name
  FROM metadata.statuses s
  WHERE s.id = p_payment_method_id AND s.entity_type = 'payment_method';
  IF v_method_key IS NULL THEN
    RAISE EXCEPTION 'Choose how the applicant paid.';
  END IF;
  IF v_method_key = 'credit_card' THEN
    RAISE EXCEPTION 'Card payments are recorded automatically when the applicant pays online. Choose the method they used.';
  END IF;

  EXECUTE format(
    'UPDATE public.%I
        SET status_id = $2, payment_method_id = $3, payment_date = $4,
            paid_amount = amount_due, payment_reference = $5,
            payment_transaction_id = CASE WHEN $6 THEN NULL ELSE payment_transaction_id END
      WHERE id = $1', p_table)
  USING p_id, get_status_id(v_et, 'paid'), p_payment_method_id,
        COALESCE(p_payment_date, (NOW() AT TIME ZONE 'America/Detroit')::DATE),
        NULLIF(btrim(p_payment_reference), ''),
        mottfest_payment_is_open(a.o_txn_id);

  RETURN jsonb_build_object('success', TRUE, 'refresh', TRUE,
    'message', format('Payment of %s by %s recorded for %s.',
                      mottfest_money_text(a.o_amount_due), v_method_name,
                      rtrim(a.o_name, '.')));  -- "Flint Honey Co." must not end in ".."
END;
$$;

-- Switch an approved non-card payer to online card payment.
CREATE OR REPLACE FUNCTION public.mottfest_enable_online_payment(p_table TEXT, p_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, metadata, payments
AS $$
DECLARE
  a RECORD;
BEGIN
  IF mottfest_entity_type(p_table) IS NULL THEN
    RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END IF;
  PERFORM mottfest_require_reviewer(p_table);

  SELECT * INTO a FROM mottfest_lock_application(p_table, p_id);
  IF a.o_status_key IS NULL THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;
  IF a.o_status_key <> 'approved' THEN
    RAISE EXCEPTION 'Online payment can only be enabled for approved, unpaid applications (this one is %).', a.o_status_name;
  END IF;
  IF a.o_pref_key = 'credit_card' THEN
    RAISE EXCEPTION 'This applicant already pays online by card.';
  END IF;
  IF a.o_amount_due <= 0 THEN
    RAISE EXCEPTION 'No payment is due for this application.';
  END IF;

  EXECUTE format('UPDATE public.%I SET preferred_payment_method_id = $2 WHERE id = $1', p_table)
  USING p_id, get_status_id('payment_method', 'credit_card');

  IF payments.check_existing_payment(a.o_txn_id) = 'create_new' THEN
    PERFORM mottfest_create_card_payment(p_table, p_id, a.o_applicant_id,
      a.o_amount_due, a.o_name, a.o_festival_id);
  END IF;

  RETURN jsonb_build_object('success', TRUE, 'refresh', TRUE,
    'message', format('%s can now pay %s online. They will be emailed a payment link.',
                      a.o_name, mottfest_money_text(a.o_amount_due)));
END;
$$;

-- Pay Now backstop. The applicant may start a card payment, and so may staff
-- who hold update permission on the table and payment_transactions read: the
-- card payment belongs to the applicant, and the checkout reads it back through
-- payment_transactions, so a payer who cannot read it gets "Payment not found".
-- Organizers without payment read are pointed to Record Payment. Everything
-- else is refused with a friendly message.
CREATE OR REPLACE FUNCTION public.mottfest_initiate_payment(p_table TEXT, p_id BIGINT)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, metadata, payments
AS $$
DECLARE
  a RECORD;
  v_state TEXT;
BEGIN
  IF mottfest_entity_type(p_table) IS NULL THEN
    RAISE EXCEPTION 'Not a Mott Fest application table: %', p_table;
  END IF;
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Sign in to pay.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO a FROM mottfest_lock_application(p_table, p_id);
  IF a.o_status_key IS NULL THEN
    RAISE EXCEPTION 'Application not found.';
  END IF;
  IF a.o_applicant_id IS DISTINCT FROM current_user_id() THEN
    IF NOT has_permission(p_table, 'update') THEN
      RAISE EXCEPTION 'You can only pay for your own applications.' USING ERRCODE = '42501';
    ELSIF NOT has_permission('payment_transactions', 'read') THEN
      RAISE EXCEPTION 'Only the applicant can pay online. To record a payment you received, use Record Payment.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  CASE a.o_status_key
    WHEN 'pending'   THEN RAISE EXCEPTION 'This application isn''t approved for payment yet.';
    WHEN 'waived'    THEN RAISE EXCEPTION 'No payment is due — your fee was waived.';
    WHEN 'in_kind'   THEN RAISE EXCEPTION 'No payment is due for in-kind sponsorships.';
    WHEN 'paid'      THEN RAISE EXCEPTION 'This application is already paid.';
    WHEN 'denied', 'withdrawn' THEN RAISE EXCEPTION 'This application is closed.';
    WHEN 'approved'  THEN NULL;
    ELSE RAISE EXCEPTION 'This application can''t be paid online.';
  END CASE;

  IF a.o_pref_key IS DISTINCT FROM 'credit_card' THEN
    RAISE EXCEPTION 'You chose to pay by % — contact us to pay online.',
      COALESCE(a.o_pref_name, 'another method');
  END IF;
  IF a.o_amount_due <= 0 THEN
    RAISE EXCEPTION 'No payment is due for this application.';
  END IF;

  v_state := payments.check_existing_payment(a.o_txn_id);
  IF v_state = 'reuse' THEN
    RETURN a.o_txn_id;
  ELSIF v_state = 'duplicate' THEN
    RAISE EXCEPTION 'This application is already paid.';
  END IF;

  RETURN mottfest_create_card_payment(p_table, p_id, a.o_applicant_id,
    a.o_amount_due, a.o_name, a.o_festival_id);
END;
$$;

-- =============================================================================
-- 2. PUBLIC REVIEW AND PAYMENT RPCs (thin wrappers per table)
-- =============================================================================

-- Booth vendors
CREATE OR REPLACE FUNCTION public.approve_vendor_application(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('vendor_application', p_entity_id, 'approve'); $$;

CREATE OR REPLACE FUNCTION public.waive_and_approve_vendor_application(p_entity_id BIGINT, p_waiver_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('vendor_application', p_entity_id, 'waive', p_waiver_reason); $$;

CREATE OR REPLACE FUNCTION public.deny_vendor_application(p_entity_id BIGINT, p_denial_reason TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('vendor_application', p_entity_id, 'deny', p_denial_reason); $$;

CREATE OR REPLACE FUNCTION public.withdraw_vendor_application(p_entity_id BIGINT, p_withdrawal_reason TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('vendor_application', p_entity_id, 'withdraw', p_withdrawal_reason); $$;

CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_entity_id BIGINT, p_payment_method_id INT,
  p_payment_date DATE DEFAULT NULL, p_payment_reference TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_record_payment('vendor_application', p_entity_id, p_payment_method_id, p_payment_date, p_payment_reference); $$;

CREATE OR REPLACE FUNCTION public.enable_online_payment_vendor_application(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_enable_online_payment('vendor_application', p_entity_id); $$;

CREATE OR REPLACE FUNCTION public.initiate_vendor_application_payment(p_entity_id BIGINT)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_initiate_payment('vendor_application', p_entity_id); $$;

-- Food trucks
CREATE OR REPLACE FUNCTION public.approve_food_truck_application(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('food_truck_application', p_entity_id, 'approve'); $$;

CREATE OR REPLACE FUNCTION public.deny_food_truck_application(p_entity_id BIGINT, p_denial_reason TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('food_truck_application', p_entity_id, 'deny', p_denial_reason); $$;

CREATE OR REPLACE FUNCTION public.withdraw_food_truck_application(p_entity_id BIGINT, p_withdrawal_reason TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('food_truck_application', p_entity_id, 'withdraw', p_withdrawal_reason); $$;

CREATE OR REPLACE FUNCTION public.record_food_truck_payment(p_entity_id BIGINT, p_payment_method_id INT,
  p_payment_date DATE DEFAULT NULL, p_payment_reference TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_record_payment('food_truck_application', p_entity_id, p_payment_method_id, p_payment_date, p_payment_reference); $$;

CREATE OR REPLACE FUNCTION public.enable_online_payment_food_truck_application(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_enable_online_payment('food_truck_application', p_entity_id); $$;

CREATE OR REPLACE FUNCTION public.initiate_food_truck_application_payment(p_entity_id BIGINT)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_initiate_payment('food_truck_application', p_entity_id); $$;

-- Sponsorships
CREATE OR REPLACE FUNCTION public.approve_sponsorship(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('sponsorship_application', p_entity_id, 'approve'); $$;

CREATE OR REPLACE FUNCTION public.deny_sponsorship(p_entity_id BIGINT, p_denial_reason TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('sponsorship_application', p_entity_id, 'deny', p_denial_reason); $$;

CREATE OR REPLACE FUNCTION public.withdraw_sponsorship(p_entity_id BIGINT, p_withdrawal_reason TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_review('sponsorship_application', p_entity_id, 'withdraw', p_withdrawal_reason); $$;

CREATE OR REPLACE FUNCTION public.record_sponsorship_payment(p_entity_id BIGINT, p_payment_method_id INT,
  p_payment_date DATE DEFAULT NULL, p_payment_reference TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_record_payment('sponsorship_application', p_entity_id, p_payment_method_id, p_payment_date, p_payment_reference); $$;

CREATE OR REPLACE FUNCTION public.enable_online_payment_sponsorship(p_entity_id BIGINT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_enable_online_payment('sponsorship_application', p_entity_id); $$;

CREATE OR REPLACE FUNCTION public.initiate_sponsorship_payment(p_entity_id BIGINT)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public, metadata, payments
AS $$ SELECT mottfest_initiate_payment('sponsorship_application', p_entity_id); $$;

-- Options for the Record Payment method param: every payment method except
-- Credit Card (card payments are recorded by the Stripe sync).
CREATE OR REPLACE FUNCTION public.get_manual_payment_methods(p_id BIGINT, p_depends_on JSONB DEFAULT '{}'::JSONB)
RETURNS TABLE(id BIGINT, display_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, metadata
AS $$
  SELECT s.id::BIGINT, s.display_name::TEXT
  FROM metadata.statuses s
  WHERE s.entity_type = 'payment_method' AND s.status_key <> 'credit_card'
  ORDER BY s.sort_order, s.display_name;
$$;

-- =============================================================================
-- 3. FESTIVAL LIFECYCLE RPCs
-- =============================================================================

CREATE OR REPLACE FUNCTION public.mottfest_lock_festival(
  p_id BIGINT, OUT o_status_key TEXT, OUT o_status_name TEXT, OUT o_name TEXT,
  OUT o_open_at TIMESTAMPTZ, OUT o_close_at TIMESTAMPTZ)
LANGUAGE plpgsql
SET search_path = public, metadata
AS $$
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT has_permission('festival', 'update') THEN
    RAISE EXCEPTION 'You do not have permission to manage festivals.' USING ERRCODE = '42501';
  END IF;

  SELECT s.status_key, s.display_name, f.display_name, f.applications_open_at, f.applications_close_at
  INTO o_status_key, o_status_name, o_name, o_open_at, o_close_at
  FROM festival f JOIN metadata.statuses s ON s.id = f.status_id
  WHERE f.id = p_id
  FOR UPDATE OF f;

  IF o_status_key IS NULL THEN
    RAISE EXCEPTION 'Festival not found.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_festival(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  f RECORD;
  v_other TEXT;
  v_msg TEXT;
BEGIN
  SELECT * INTO f FROM mottfest_lock_festival(p_entity_id);
  IF f.o_status_key NOT IN ('planning', 'closed') THEN
    RAISE EXCEPTION 'Only Planning or Closed festivals can be opened (this one is %).', f.o_status_name;
  END IF;

  SELECT x.display_name INTO v_other FROM festival x
  WHERE x.status_id = get_status_id('festival', 'open') AND x.id <> p_entity_id
  LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION '% is already open. Close its applications first.', v_other;
  END IF;

  UPDATE festival SET status_id = get_status_id('festival', 'open') WHERE id = p_entity_id;

  v_msg := format('Applications are open for %s.', f.o_name);
  IF NOW() NOT BETWEEN f.o_open_at AND f.o_close_at THEN
    v_msg := v_msg || format(' Note: the application window (%s to %s) does not include today, so applicants cannot submit until you change it.',
      to_char(f.o_open_at AT TIME ZONE 'America/Detroit', 'FMMon FMDD, YYYY'),
      to_char(f.o_close_at AT TIME ZONE 'America/Detroit', 'FMMon FMDD, YYYY'));
  END IF;

  RETURN jsonb_build_object('success', TRUE, 'message', v_msg, 'refresh', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_festival(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  f RECORD;
BEGIN
  SELECT * INTO f FROM mottfest_lock_festival(p_entity_id);
  IF f.o_status_key <> 'open' THEN
    RAISE EXCEPTION 'Only an Open festival can be closed (this one is %).', f.o_status_name;
  END IF;

  UPDATE festival SET status_id = get_status_id('festival', 'closed') WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', TRUE, 'refresh', TRUE,
    'message', format('Applications are closed for %s. Organizers can still enter late applications.', f.o_name));
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_festival(p_entity_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, metadata
AS $$
DECLARE
  f RECORD;
  v_pending INT;
  v_unpaid INT;
BEGIN
  SELECT * INTO f FROM mottfest_lock_festival(p_entity_id);
  IF f.o_status_key <> 'closed' THEN
    RAISE EXCEPTION 'Only a Closed festival can be marked completed (this one is %).', f.o_status_name;
  END IF;

  SELECT
    (SELECT count(*) FROM vendor_application WHERE festival_id = p_entity_id AND status_id = get_status_id('vendor_application', 'pending'))
  + (SELECT count(*) FROM food_truck_application WHERE festival_id = p_entity_id AND status_id = get_status_id('food_truck_application', 'pending'))
  + (SELECT count(*) FROM sponsorship_application WHERE festival_id = p_entity_id AND status_id = get_status_id('sponsorship_application', 'pending')),
    (SELECT count(*) FROM vendor_application WHERE festival_id = p_entity_id AND status_id = get_status_id('vendor_application', 'approved'))
  + (SELECT count(*) FROM food_truck_application WHERE festival_id = p_entity_id AND status_id = get_status_id('food_truck_application', 'approved'))
  + (SELECT count(*) FROM sponsorship_application WHERE festival_id = p_entity_id AND status_id = get_status_id('sponsorship_application', 'approved'))
  INTO v_pending, v_unpaid;

  IF v_pending + v_unpaid > 0 THEN
    RAISE EXCEPTION 'Resolve % pending and % unpaid applications first (approve/deny, record payment, or withdraw).',
      v_pending, v_unpaid;
  END IF;

  UPDATE festival SET status_id = get_status_id('festival', 'completed') WHERE id = p_entity_id;

  RETURN jsonb_build_object('success', TRUE, 'refresh', TRUE,
    'message', format('%s is marked completed.', f.o_name));
END;
$$;

-- =============================================================================
-- 4. STRIPE SYNC: payments.transactions -> application rows
-- =============================================================================
-- Finds the application through the transaction's own entity_type/entity_id,
-- so a webhook that lands after Deny/Withdraw unlinked the payment still
-- reaches the row. Only Approved moves to Paid; anything else keeps its
-- status and gets a system note for the organizers.

CREATE OR REPLACE FUNCTION public.sync_mottfest_payment_status()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, metadata, payments
AS $$
DECLARE
  v_et TEXT;
  v_id BIGINT;
  a RECORD;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_et := mottfest_entity_type(NEW.entity_type);
  IF v_et IS NULL OR NEW.entity_id IS NULL OR NEW.entity_id !~ '^[0-9]+$' THEN
    RETURN NEW;
  END IF;
  v_id := NEW.entity_id::BIGINT;

  SELECT * INTO a FROM mottfest_lock_application(NEW.entity_type, v_id);
  IF a.o_status_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'succeeded' THEN
    IF a.o_status_key = 'approved' THEN
      EXECUTE format(
        'UPDATE public.%I SET status_id = $2, payment_method_id = $3, payment_date = $4,
                paid_amount = $5::money, payment_transaction_id = $6 WHERE id = $1', NEW.entity_type)
      USING v_id, get_status_id(v_et, 'paid'), get_status_id('payment_method', 'credit_card'),
            (NOW() AT TIME ZONE 'America/Detroit')::DATE, NEW.amount, NEW.id;
    ELSE
      -- Race (withdrawn, denied, already paid by check): keep the status,
      -- keep any existing payment record, and flag it for a person.
      EXECUTE format(
        'UPDATE public.%I
            SET payment_transaction_id = COALESCE(payment_transaction_id, $2),
                paid_amount = COALESCE(paid_amount, $3::money),
                payment_date = CASE WHEN paid_amount IS NULL THEN $4 ELSE payment_date END,
                payment_method_id = CASE WHEN paid_amount IS NULL THEN $5 ELSE payment_method_id END
          WHERE id = $1', NEW.entity_type)
      USING v_id, NEW.id, NEW.amount, (NOW() AT TIME ZONE 'America/Detroit')::DATE,
            get_status_id('payment_method', 'credit_card');

      INSERT INTO metadata.entity_notes (entity_type, entity_id, author_id, content, note_type, is_internal)
      VALUES (NEW.entity_type, v_id::TEXT, NULL,
        format('Online payment of %s received while status was %s — review for refund or reinstatement.',
               mottfest_money_text(NEW.amount), a.o_status_name),
        'system', TRUE);
    END IF;

  ELSIF NEW.status IN ('failed', 'canceled') THEN
    IF a.o_status_key = 'approved' AND a.o_txn_id = NEW.id THEN
      EXECUTE format('UPDATE public.%I SET payment_transaction_id = NULL WHERE id = $1', NEW.entity_type)
      USING v_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_mottfest_payment_status_trigger ON payments.transactions;
CREATE TRIGGER sync_mottfest_payment_status_trigger
  AFTER UPDATE OF status ON payments.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_mottfest_payment_status();

-- =============================================================================
-- 5. FUNCTION PRIVILEGES
-- =============================================================================

REVOKE ALL ON FUNCTION public.mottfest_entity_type(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_money_text(NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_lock_application(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_require_reviewer(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_payment_is_open(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_create_card_payment(TEXT, BIGINT, UUID, NUMERIC, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_review(TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_record_payment(TEXT, BIGINT, INT, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_enable_online_payment(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_initiate_payment(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mottfest_lock_festival(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_mottfest_payment_status() FROM PUBLIC;

DO $$
DECLARE
  v_sig TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'approve_vendor_application(bigint)',
    'waive_and_approve_vendor_application(bigint, text)',
    'deny_vendor_application(bigint, text)',
    'withdraw_vendor_application(bigint, text)',
    'record_vendor_payment(bigint, integer, date, text)',
    'enable_online_payment_vendor_application(bigint)',
    'initiate_vendor_application_payment(bigint)',
    'approve_food_truck_application(bigint)',
    'deny_food_truck_application(bigint, text)',
    'withdraw_food_truck_application(bigint, text)',
    'record_food_truck_payment(bigint, integer, date, text)',
    'enable_online_payment_food_truck_application(bigint)',
    'initiate_food_truck_application_payment(bigint)',
    'approve_sponsorship(bigint)',
    'deny_sponsorship(bigint, text)',
    'withdraw_sponsorship(bigint, text)',
    'record_sponsorship_payment(bigint, integer, date, text)',
    'enable_online_payment_sponsorship(bigint)',
    'initiate_sponsorship_payment(bigint)',
    'get_manual_payment_methods(bigint, jsonb)',
    'open_festival(bigint)',
    'close_festival(bigint)',
    'complete_festival(bigint)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', v_sig);
  END LOOP;
END $$;

-- =============================================================================
-- 6. PAY NOW WIRING
-- =============================================================================

UPDATE metadata.entities SET payment_initiation_rpc = 'initiate_vendor_application_payment'
WHERE table_name = 'vendor_application';
UPDATE metadata.entities SET payment_initiation_rpc = 'initiate_food_truck_application_payment'
WHERE table_name = 'food_truck_application';
UPDATE metadata.entities SET payment_initiation_rpc = 'initiate_sponsorship_payment'
WHERE table_name = 'sponsorship_application';

-- =============================================================================
-- 7. ENTITY ACTIONS
-- =============================================================================

-- {field: status_id, operator: in, value: [ids]} for the given status keys
CREATE OR REPLACE FUNCTION pg_temp.mf_status_in(p_et TEXT, p_keys TEXT[])
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('field', 'status_id', 'operator', 'in',
    'value', jsonb_agg(public.get_status_id(p_et, k) ORDER BY ord))
  FROM unnest(p_keys) WITH ORDINALITY AS u(k, ord);
$$;

-- Approved and not paying by card (Enable Online Payment)
CREATE OR REPLACE FUNCTION pg_temp.mf_approved_non_card(p_et TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('and', jsonb_build_array(
    pg_temp.mf_status_in(p_et, ARRAY['approved']),
    jsonb_build_object('field', 'preferred_payment_method_id', 'operator', 'neq',
                       'value', public.get_status_id('payment_method', 'credit_card'))));
$$;

CREATE TEMP TABLE mf_actions (
  table_name NAME, action_name TEXT, display_name TEXT, description TEXT, rpc_function NAME,
  icon TEXT, button_style TEXT, sort_order INT, confirmation_message TEXT,
  condition JSONB, disabled_tooltip TEXT
) ON COMMIT DROP;

INSERT INTO mf_actions VALUES
  -- Festivals
  ('festival', 'open_applications', 'Open Applications', 'Start accepting applications for this festival',
   'open_festival', 'lock_open', 'success', 10,
   'Open applications for this festival? Applicants can submit during the application window.',
   pg_temp.mf_status_in('festival', ARRAY['planning', 'closed']), 'Only Planning or Closed festivals can be opened'),
  ('festival', 'close_applications', 'Close Applications', 'Stop accepting applications',
   'close_festival', 'lock', 'warning', 20,
   'Close applications? Applicants will no longer be able to submit.',
   pg_temp.mf_status_in('festival', ARRAY['open']), 'Only an Open festival can be closed'),
  ('festival', 'mark_completed', 'Mark Completed', 'Mark this festival as over',
   'complete_festival', 'event_available', 'primary', 30,
   'Mark this festival completed?',
   pg_temp.mf_status_in('festival', ARRAY['closed']), 'Only a Closed festival can be completed'),

  -- Booth vendors
  ('vendor_application', 'approve', 'Approve', 'Approve this application',
   'approve_vendor_application', 'check_circle', 'success', 10,
   'Approve this application? The applicant will be emailed the booth fee and due date.',
   pg_temp.mf_status_in('vendor_application', ARRAY['pending']), 'Only pending applications can be approved'),
  ('vendor_application', 'waive_and_approve', 'Waive Fee & Approve', 'Approve with no fee due',
   'waive_and_approve_vendor_application', 'money_off', 'accent', 15,
   'Approve with no fee due?',
   pg_temp.mf_status_in('vendor_application', ARRAY['pending']), 'Only pending applications can be approved'),
  ('vendor_application', 'record_payment', 'Record Payment', 'Record a check, cash, money order or CashApp payment',
   'record_vendor_payment', 'payments', 'success', 20,
   'Record a payment received outside the system? The application is marked Paid and the applicant is emailed a receipt.',
   pg_temp.mf_status_in('vendor_application', ARRAY['approved']), 'Only approved, unpaid applications'),
  ('vendor_application', 'enable_online_payment', 'Enable Online Payment', 'Switch this applicant to online card payment',
   'enable_online_payment_vendor_application', 'credit_card', 'secondary', 25,
   'Switch this applicant to online card payment? They''ll be emailed a payment link.',
   pg_temp.mf_approved_non_card('vendor_application'), 'Only approved applicants paying by another method'),
  ('vendor_application', 'deny', 'Deny', 'Deny this application',
   'deny_vendor_application', 'block', 'error', 30,
   'Deny this application? The reason will be emailed to the applicant.',
   pg_temp.mf_status_in('vendor_application', ARRAY['pending', 'approved']), 'Only pending or approved applications'),
  ('vendor_application', 'withdraw', 'Withdraw', 'Withdraw this application',
   'withdraw_vendor_application', 'undo', 'warning', 40,
   'Withdraw this application? Payments are not refunded through the system.',
   pg_temp.mf_status_in('vendor_application', ARRAY['pending', 'approved', 'paid', 'waived']), 'This application is already closed'),

  -- Food trucks
  ('food_truck_application', 'approve', 'Approve', 'Approve this application',
   'approve_food_truck_application', 'check_circle', 'success', 10,
   'Approve this application? The applicant will be emailed the food truck fee and due date.',
   pg_temp.mf_status_in('food_truck_application', ARRAY['pending']), 'Only pending applications can be approved'),
  ('food_truck_application', 'record_payment', 'Record Payment', 'Record a check, cash, money order or CashApp payment',
   'record_food_truck_payment', 'payments', 'success', 20,
   'Record a payment received outside the system? The application is marked Paid and the applicant is emailed a receipt.',
   pg_temp.mf_status_in('food_truck_application', ARRAY['approved']), 'Only approved, unpaid applications'),
  ('food_truck_application', 'enable_online_payment', 'Enable Online Payment', 'Switch this applicant to online card payment',
   'enable_online_payment_food_truck_application', 'credit_card', 'secondary', 25,
   'Switch this applicant to online card payment? They''ll be emailed a payment link.',
   pg_temp.mf_approved_non_card('food_truck_application'), 'Only approved applicants paying by another method'),
  ('food_truck_application', 'deny', 'Deny', 'Deny this application',
   'deny_food_truck_application', 'block', 'error', 30,
   'Deny this application? The reason will be emailed to the applicant.',
   pg_temp.mf_status_in('food_truck_application', ARRAY['pending', 'approved']), 'Only pending or approved applications'),
  ('food_truck_application', 'withdraw', 'Withdraw', 'Withdraw this application',
   'withdraw_food_truck_application', 'undo', 'warning', 40,
   'Withdraw this application? Payments are not refunded through the system.',
   pg_temp.mf_status_in('food_truck_application', ARRAY['pending', 'approved', 'paid']), 'This application is already closed'),

  -- Sponsorships
  ('sponsorship_application', 'approve', 'Approve', 'Approve this sponsorship (in-kind gifts become In-Kind)',
   'approve_sponsorship', 'check_circle', 'success', 10,
   'Approve this sponsorship? In-kind gifts are marked In-Kind; other sponsors are emailed the amount and due date.',
   pg_temp.mf_status_in('sponsorship_application', ARRAY['pending']), 'Only pending sponsorships can be approved'),
  ('sponsorship_application', 'record_payment', 'Record Payment', 'Record a check, cash, money order or CashApp payment',
   'record_sponsorship_payment', 'payments', 'success', 20,
   'Record a payment received outside the system? The application is marked Paid and the applicant is emailed a receipt.',
   pg_temp.mf_status_in('sponsorship_application', ARRAY['approved']), 'Only approved, unpaid sponsorships'),
  ('sponsorship_application', 'enable_online_payment', 'Enable Online Payment', 'Switch this sponsor to online card payment',
   'enable_online_payment_sponsorship', 'credit_card', 'secondary', 25,
   'Switch this sponsor to online card payment? They''ll be emailed a payment link.',
   pg_temp.mf_approved_non_card('sponsorship_application'), 'Only approved sponsors paying by another method'),
  ('sponsorship_application', 'deny', 'Deny', 'Deny this sponsorship',
   'deny_sponsorship', 'block', 'error', 30,
   'Deny this sponsorship? The reason will be emailed to the sponsor.',
   pg_temp.mf_status_in('sponsorship_application', ARRAY['pending', 'approved']), 'Only pending or approved sponsorships'),
  ('sponsorship_application', 'withdraw', 'Withdraw', 'Withdraw this sponsorship',
   'withdraw_sponsorship', 'undo', 'warning', 40,
   'Withdraw this sponsorship? Payments are not refunded through the system.',
   pg_temp.mf_status_in('sponsorship_application', ARRAY['pending', 'approved', 'paid', 'in_kind']), 'This sponsorship is already closed');

INSERT INTO metadata.entity_actions (
  table_name, action_name, display_name, description, rpc_function, icon, button_style,
  sort_order, requires_confirmation, confirmation_message, visibility_condition,
  enabled_condition, disabled_tooltip, refresh_after_action, show_on_detail)
SELECT table_name, action_name, display_name, description, rpc_function, icon, button_style,
       sort_order, confirmation_message IS NOT NULL, confirmation_message, condition,
       condition, disabled_tooltip, TRUE, TRUE
FROM mf_actions
ON CONFLICT (table_name, action_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  rpc_function = EXCLUDED.rpc_function,
  icon = EXCLUDED.icon,
  button_style = EXCLUDED.button_style,
  sort_order = EXCLUDED.sort_order,
  requires_confirmation = EXCLUDED.requires_confirmation,
  confirmation_message = EXCLUDED.confirmation_message,
  visibility_condition = EXCLUDED.visibility_condition,
  enabled_condition = EXCLUDED.enabled_condition,
  disabled_tooltip = EXCLUDED.disabled_tooltip,
  refresh_after_action = EXCLUDED.refresh_after_action,
  show_on_detail = EXCLUDED.show_on_detail;

-- Action params
CREATE TEMP TABLE mf_params (
  table_name NAME, action_name TEXT, param_name TEXT, display_name TEXT, param_type TEXT,
  required BOOLEAN, sort_order INT, placeholder TEXT, join_table NAME, join_column NAME,
  options_source_rpc NAME
) ON COMMIT DROP;

INSERT INTO mf_params
SELECT t.table_name, p.action_name, p.param_name, p.display_name, p.param_type,
       p.required, p.sort_order, p.placeholder, p.join_table, p.join_column, p.options_source_rpc
FROM (VALUES ('vendor_application'::NAME), ('food_truck_application'), ('sponsorship_application')) AS t(table_name)
CROSS JOIN (VALUES
  ('deny', 'p_denial_reason', 'Denial Reason', 'text', TRUE, 10,
   'This is emailed to the applicant', NULL::NAME, NULL::NAME, NULL::NAME),
  ('withdraw', 'p_withdrawal_reason', 'Withdrawal Reason', 'text', TRUE, 10,
   'This is emailed to the applicant', NULL, NULL, NULL),
  ('record_payment', 'p_payment_method_id', 'Payment Method', 'foreign_key', TRUE, 10,
   NULL, 'statuses', 'id', 'get_manual_payment_methods'),
  ('record_payment', 'p_payment_date', 'Payment Date (blank = today)', 'date', FALSE, 20,
   NULL, NULL, NULL, NULL),
  ('record_payment', 'p_payment_reference', 'Check # or Reference', 'text_short', FALSE, 30,
   'Optional', NULL, NULL, NULL)
) AS p(action_name, param_name, display_name, param_type, required, sort_order, placeholder,
       join_table, join_column, options_source_rpc)
UNION ALL
SELECT 'vendor_application', 'waive_and_approve', 'p_waiver_reason', 'Waiver Reason', 'text',
       FALSE, 10, 'Optional; kept on the record', NULL, NULL, NULL;

INSERT INTO metadata.entity_action_params (
  entity_action_id, param_name, display_name, param_type, required, sort_order,
  placeholder, join_table, join_column, options_source_rpc)
SELECT ea.id, p.param_name, p.display_name, p.param_type, p.required, p.sort_order,
       p.placeholder, p.join_table, p.join_column, p.options_source_rpc
FROM mf_params p
JOIN metadata.entity_actions ea ON ea.table_name = p.table_name AND ea.action_name = p.action_name
ON CONFLICT (entity_action_id, param_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  param_type = EXCLUDED.param_type,
  required = EXCLUDED.required,
  sort_order = EXCLUDED.sort_order,
  placeholder = EXCLUDED.placeholder,
  join_table = EXCLUDED.join_table,
  join_column = EXCLUDED.join_column,
  options_source_rpc = EXCLUDED.options_source_rpc;

-- Every Mott Fest action: Mott Fest Admin and Admin only
INSERT INTO metadata.entity_action_roles (entity_action_id, role_id)
SELECT ea.id, r.id
FROM mf_actions a
JOIN metadata.entity_actions ea ON ea.table_name = a.table_name AND ea.action_name = a.action_name
CROSS JOIN metadata.roles r
WHERE r.role_key IN ('mottfest_admin', 'admin')
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- SCHEMA DECISIONS (outside the transaction; direct INSERT because
-- create_schema_decision() requires a JWT admin context)
-- =============================================================================

CREATE OR REPLACE FUNCTION pg_temp.mottfest_adr(
  p_entity_types NAME[], p_property_names NAME[], p_title TEXT,
  p_context TEXT, p_decision TEXT, p_rationale TEXT, p_consequences TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO metadata.schema_decisions (entity_types, property_names, migration_id, title, status,
    context, decision, rationale, consequences, decided_date)
  SELECT p_entity_types, p_property_names, '35_mottfest_actions_payments', p_title, 'accepted',
    p_context, p_decision, p_rationale, p_consequences, CURRENT_DATE
  WHERE NOT EXISTS (
    SELECT 1 FROM metadata.schema_decisions
    WHERE migration_id = '35_mottfest_actions_payments' AND title = p_title);
$$;

SELECT pg_temp.mottfest_adr(
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['status_id', 'reviewed_by', 'reviewed_at', 'denial_reason', 'withdrawal_reason', 'waiver_reason']::NAME[],
  'Mott Fest review actions run through shared, allowlisted helpers',
  'Three application tables share the same review workflow (approve, deny, withdraw, record payment, enable online payment). Writing the logic three times invites drift; one function taking a table name invites SQL injection and privilege surprises.',
  'Private helpers (mottfest_review, mottfest_record_payment, mottfest_enable_online_payment, mottfest_initiate_payment) take the table name, accept only the three application tables (mottfest_entity_type allowlist) and quote it with format(%I). They are granted to no API role. Thin SECURITY DEFINER RPCs per table call them and are registered as entity actions. Every RPC authorizes with has_permission(<table>, ''update''), locks the row FOR UPDATE and sets reviewed_by/reviewed_at on review.',
  'One implementation keeps the three pipelines identical. Per-table wrappers keep action registration and PostgREST signatures per entity. has_permission keeps authorization in the RBAC tables instead of role names, unlike the older clubhouse RPCs.',
  'A new application table needs an allowlist entry, the shared columns and its own wrappers. Fixes to the workflow land in one place.');

SELECT pg_temp.mottfest_adr(
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application', 'festival']::NAME[],
  ARRAY['status_id']::NAME[],
  'Mott Fest status changes go through entity actions only; direct API edits are an accepted gap',
  'Applications and festivals move through statuses with side effects (payment records, emails, reviewer stamps). The UI hides status_id on create and edit, but organizers hold update permission on the tables for corrections, so PostgREST and the MCP update_record tool can still write status_id directly.',
  'Status changes are made only through the registered entity actions (RPCs). No trigger blocks a direct status_id write by a user with update permission.',
  'Blocking direct writes needs a trigger that tells action RPCs from other callers (a session flag), which every correction path would then have to know about. Only trusted organizers hold update permission, and the notification and note triggers fire on any status change, so a direct edit still emails the applicant and leaves an audit note.',
  'A direct status_id edit skips the RPC checks (allowed transitions, reviewer stamps, payment record creation, unlinking open card payments). Organizers are told to use the action buttons; MCP clients are told to prefer execute_action. Revisit if a non-organizer role ever gets update permission.');

SELECT pg_temp.mottfest_adr(
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['payment_transaction_id', 'preferred_payment_method_id', 'amount_due']::NAME[],
  'Pay Now uses an inline payment link guarded by a per-table initiation RPC',
  'The frontend shows Pay Now on every record of an entity with payment_initiation_rpc whose payment has not succeeded; payment_show_condition is planned but not built. Only approved card payers with an amount due should be able to pay online. The frontend also opens checkout directly, without calling the RPC, when the linked payment is still pending.',
  'Each application table keeps payment_transaction_id inline and registers its own SECURITY DEFINER initiation RPC. The RPC lets the owner (applicant_id IS NOT DISTINCT FROM current_user_id()) pay, or staff holding both update permission on the table and payment_transactions read (the checkout reads the applicant-owned payment back through payment_transactions, so any other payer would get "Payment not found"; organizers without that read are pointed to Record Payment), and refuses pending, non-card, waived, in-kind, paid, denied and withdrawn applications with a friendly message. The card payment record is created on approval, or by Enable Online Payment, and only for card payers, owned by the applicant. Deny, Withdraw and Record Payment unlink a still-open card payment so checkout cannot be resumed past the guard.',
  'This is the clubhouse guard model without a child payment table: one row per application, one place to look, and the RPC is the single gate. Unlinking closes the resume path the frontend takes without the RPC; the transaction keeps entity_type and entity_id, so nothing is lost from the audit trail.',
  'Pay Now still renders on non-payable rows and refuses when clicked; help text explains when it works. When payment_show_condition ships, hide the button with it and keep the RPC as the backstop. A Stripe intent that was already open in a browser can still complete after an unlink; the Stripe sync handles that case.');

SELECT pg_temp.mottfest_adr(
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['status_id', 'paid_amount', 'payment_date', 'payment_method_id', 'payment_transaction_id']::NAME[],
  'Mott Fest Stripe sync moves only Approved applications to Paid',
  'A Stripe success can arrive after an organizer has withdrawn or denied the application, or recorded a check payment, because the applicant opened checkout before the change.',
  'sync_mottfest_payment_status() (AFTER UPDATE OF status ON payments.transactions) finds the application through the transaction''s entity_type and entity_id, not through the link, so it also reaches rows whose link was cleared. On success it moves Approved to Paid with method Credit Card. Any other status is left alone: the payment is linked and recorded only where no payment is recorded yet, and a system note asks an organizer to refund or reinstate. On failure or cancel the link of an Approved row is cleared for a retry.',
  'Automatically reinstating a withdrawn applicant, or overwriting a recorded check payment, would undo an organizer decision silently. A note keeps the money visible without changing the decision.',
  'Organizers check system notes for late online payments and refund through Stripe by hand. The note is inserted directly (no author) because webhooks run without a user.');

SELECT pg_temp.mottfest_adr(
  ARRAY['vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['payment_method_id']::NAME[],
  'Record Payment offers every payment method except Credit Card',
  'Organizers record check, cash, money order and CashApp payments by hand. Card payments arrive through Stripe and must match a transaction.',
  'The Record Payment action''s method param uses options_source_rpc get_manual_payment_methods(p_id, p_depends_on), which returns the payment_method statuses except credit_card. mottfest_record_payment also refuses Credit Card.',
  'A hand-recorded card payment would have no Stripe transaction behind it and would confuse reconciliation.',
  'A new manual payment method is a new payment_method status and appears automatically. An organizer who took a card payment outside Stripe records it as the closest manual method and notes it in the reference.');

SELECT pg_temp.mottfest_adr(
  ARRAY['festival', 'vendor_application', 'food_truck_application', 'sponsorship_application']::NAME[],
  ARRAY['status_id']::NAME[],
  'Festival lifecycle actions guard opening and completion',
  'Only one festival may accept applications at a time, and a festival should not be closed out while applications still need a decision or a payment.',
  'open_festival (Planning or Closed to Open) refuses while another festival is Open, backed by the festival_one_open partial unique index, and warns when the application window does not include today. close_festival moves Open to Closed. complete_festival moves Closed to Completed only when no application for that festival is Pending or Approved-unpaid, and names the counts otherwise.',
  'The index is the hard guarantee; the RPC turns a constraint error into a readable message. The completion guard makes "Completed" mean every application is resolved, which the summary views rely on.',
  'Reopening a closed festival is the same Open action. A completed festival cannot be reopened through actions; an admin edits the status if that is ever needed.');
