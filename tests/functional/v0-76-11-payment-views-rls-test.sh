#!/bin/bash
# =============================================================================
# Functional Test: v0-76-11 payment views apply per-caller visibility
# =============================================================================
# public.payment_transactions and public.payment_refunds are superuser-owned views. Before
# v0-76-11 they returned every row to every caller, including anonymous ones, exposing all users'
# payments and the Stripe provider_client_secret. This test asserts, as the API roles:
#   - web_anon sees no payments
#   - a user sees none of another user's payments or refunds
#   - the payer sees their own payment (incl. provider_client_secret for the checkout modal) with
#     refund totals and effective_status still computed correctly
#   - a role holding payment_transactions:read / payment_refunds:read sees everything
# Runs in one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-76-11-payment-views-rls-test.sh
#
# Environment overrides:
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'payment view test A'),
  ('00000000-0000-0000-0000-0000000000a2', 'payment view test B');

-- B's payment with a 10.00 partial refund
INSERT INTO payments.transactions (id, user_id, amount, provider_payment_id, provider_client_secret, description)
VALUES ('11111111-1111-1111-1111-1111111111a2', '00000000-0000-0000-0000-0000000000a2',
        50, 'pi_view_test', 'pi_view_test_secret', 'payment view test');
UPDATE payments.transactions SET status = 'succeeded'
WHERE id = '11111111-1111-1111-1111-1111111111a2';
INSERT INTO payments.refunds (transaction_id, amount, reason, initiated_by, status)
VALUES ('11111111-1111-1111-1111-1111111111a2', 10, 'customer requested refund',
        '00000000-0000-0000-0000-0000000000a2', 'succeeded');

-- The editor role may read all payments and refunds in this test
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('payment_transactions', 'read'), ('payment_refunds', 'read')
ON CONFLICT DO NOTHING;
INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT (SELECT id FROM metadata.roles WHERE role_key = 'editor'), p.id
FROM metadata.permissions p
WHERE p.table_name IN ('payment_transactions', 'payment_refunds') AND p.permission::text = 'read'
ON CONFLICT DO NOTHING;

SET LOCAL ROLE web_anon;
SELECT set_config('request.jwt.claims', '{}', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.payment_transactions;
  ASSERT n = 0, format('web_anon can read %s payment(s) through payment_transactions', n);
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;

-- User A (not the payer, no permissions)
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","roles":["user"]}', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.payment_transactions;
  ASSERT n = 0, format('a non-payer can read %s payment(s) through payment_transactions', n);
  SELECT count(*) INTO n FROM public.payment_refunds;
  ASSERT n = 0, format('a user without payment_refunds:read can read %s refund(s)', n);
END $$;

-- User B (the payer)
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","roles":["user"]}', true);

DO $$
DECLARE pay public.payment_transactions; n int;
BEGIN
  SELECT * INTO pay FROM public.payment_transactions;
  ASSERT pay.id = '11111111-1111-1111-1111-1111111111a2', 'the payer must see their own payment';
  ASSERT pay.provider_client_secret = 'pi_view_test_secret', 'the payer needs provider_client_secret for checkout';
  ASSERT pay.total_refunded = 10 AND pay.refund_count = 1 AND pay.effective_status = 'partially_refunded',
    format('refund aggregates must stay correct for the payer (refunded=%s count=%s status=%s)',
           pay.total_refunded, pay.refund_count, pay.effective_status);
  SELECT count(*) INTO n FROM public.payment_refunds;
  ASSERT n = 0, 'refund detail rows stay restricted to payment_refunds:read, as in the base-table policy';
END $$;

-- Editor holding payment_transactions:read and payment_refunds:read
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","roles":["editor"]}', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.payment_transactions;
  ASSERT n >= 1, 'a role with payment_transactions:read must see payments';
  SELECT count(*) INTO n FROM public.payment_refunds;
  ASSERT n >= 1, 'a role with payment_refunds:read must see refunds';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: payment_transactions and payment_refunds expose rows only to their owners and permitted roles"
else
  echo "FAIL: a payment view exposed rows to the wrong caller (see error above)"
  exit 1
fi
