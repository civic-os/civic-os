#!/bin/bash
# =============================================================================
# Functional Test: v0-76-9 public views apply row-level security
# =============================================================================
# Public views are owned by a superuser, so a view that is neither security_invoker nor filtered per
# caller ignores the RLS policies on its base table, for reads and for the writes granted through it.
# This test exercises each affected view the way PostgREST does: session user `authenticator`, then
# SET ROLE authenticated / web_anon, with the caller's identity in request.jwt.claims. It never
# queries a view as postgres. For every view it asserts:
#   cross-user read denied, cross-user write denied, own-row read allowed, own-row write allowed
#   (or, for read-only views, that writes are denied outright).
#
# Views covered: notification_preferences, entity_notes, civic_os_users, payment_transactions,
# payment_refunds.
#
# All fixtures are created inside one transaction that is rolled back.
#
# Usage:
#   ./tests/functional/v0-76-9-view-rls-test.sh
#
# Environment overrides (the connecting user must be a superuser, to create fixtures):
#   DATABASE_URL   postgres://postgres:securepassword123@localhost:15432/civic_os_db
# =============================================================================

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://postgres:securepassword123@localhost:15432/civic_os_db}"

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -o /dev/null <<'SQL'
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures (as the superuser)
-- ---------------------------------------------------------------------------
INSERT INTO metadata.civic_os_users (id, display_name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'view rls test A'),
  ('00000000-0000-0000-0000-0000000000c2', 'view rls test B');
INSERT INTO metadata.civic_os_users_private (id, display_name, email, first_name, last_name, phone) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'View A', 'a@example.invalid', 'View', 'A', '5551230001'),
  ('00000000-0000-0000-0000-0000000000c2', 'View B', 'b@example.invalid', 'View', 'B', '5551230002');

-- notification preferences: A and B each have an email row
DELETE FROM metadata.notification_preferences
 WHERE user_id IN ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2');
INSERT INTO metadata.notification_preferences (user_id, channel, enabled, email_address) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'email', true, 'a@example.invalid'),
  ('00000000-0000-0000-0000-0000000000c2', 'email', true, 'b@example.invalid');

-- notes: the editor role holds view_rls_ent:notes read + create; one note by each user
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('view_rls_ent:notes', 'read'), ('view_rls_ent:notes', 'create') ON CONFLICT DO NOTHING;
INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT (SELECT id FROM metadata.roles WHERE role_key = 'editor'), p.id
FROM metadata.permissions p WHERE p.table_name = 'view_rls_ent:notes' ON CONFLICT DO NOTHING;
INSERT INTO metadata.entity_notes (entity_type, entity_id, author_id, content, note_type, is_internal) VALUES
  ('view_rls_ent', '1', '00000000-0000-0000-0000-0000000000c1', 'note by A', 'note', true),
  ('view_rls_ent', '1', '00000000-0000-0000-0000-0000000000c2', 'note by B', 'note', true);

-- payments: B's payment with a partial refund; the editor role may read payments and refunds
INSERT INTO payments.transactions (id, user_id, amount, provider_payment_id, description)
VALUES ('11111111-1111-1111-1111-1111111111c2', '00000000-0000-0000-0000-0000000000c2',
        50, 'pi_view_rls_test', 'view rls test payment');
UPDATE payments.transactions SET status = 'succeeded'
 WHERE id = '11111111-1111-1111-1111-1111111111c2';
INSERT INTO payments.refunds (transaction_id, amount, reason, initiated_by, status)
VALUES ('11111111-1111-1111-1111-1111111111c2', 10, 'customer requested refund',
        '00000000-0000-0000-0000-0000000000c2', 'succeeded');
INSERT INTO metadata.permissions (table_name, permission)
VALUES ('payment_transactions', 'read'), ('payment_refunds', 'read') ON CONFLICT DO NOTHING;
INSERT INTO metadata.permission_roles (role_id, permission_id)
SELECT (SELECT id FROM metadata.roles WHERE role_key = 'editor'), p.id
FROM metadata.permissions p
WHERE p.table_name IN ('payment_transactions', 'payment_refunds') AND p.permission::text = 'read'
ON CONFLICT DO NOTHING;

-- civic_os_users masks private columns itself, so its output is the same with or without the option;
-- assert the option directly so RLS on civic_os_users_private stays the primary barrier.
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'civic_os_users'
      AND c.reloptions @> ARRAY['security_invoker=true']
  ), 'civic_os_users: lost security_invoker (CREATE OR REPLACE VIEW resets view options)';
END $$;

-- ---------------------------------------------------------------------------
-- From here on, behave like a PostgREST request: session user authenticator
-- ---------------------------------------------------------------------------
SET LOCAL SESSION AUTHORIZATION authenticator;
SET LOCAL ROLE authenticated;

-- helper to run a DML statement as the current principal and return the affected row count
CREATE OR REPLACE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- helper: is a cross-user write denied, either rejected outright or matching 0 rows?
CREATE OR REPLACE FUNCTION pg_temp.write_denied(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 0;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;

-- helper: does the statement get rejected (RLS violation or missing privilege)?
CREATE OR REPLACE FUNCTION pg_temp.is_rejected(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN  -- RLS/grant denial, or a non-updatable view
  RETURN true;
END $$;

-- ===========================================================================
-- notification_preferences (base table grants authenticated SELECT and UPDATE only)
-- ===========================================================================
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","roles":["user"]}', true);

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.notification_preferences
          WHERE user_id = '00000000-0000-0000-0000-0000000000c2') = 0,
    'notification_preferences: cross-user READ must be denied';
  ASSERT (SELECT count(*) FROM public.notification_preferences
          WHERE user_id = '00000000-0000-0000-0000-0000000000c1') = 1,
    'notification_preferences: own-row READ must be allowed';

  ASSERT pg_temp.write_denied($q$UPDATE public.notification_preferences SET enabled = false
          WHERE user_id = '00000000-0000-0000-0000-0000000000c2'$q$),
    'notification_preferences: cross-user UPDATE must be denied';
  ASSERT pg_temp.write_denied($q$UPDATE public.notification_preferences SET email_address = 'x@example.invalid'
          WHERE user_id = '00000000-0000-0000-0000-0000000000c2'$q$),
    'notification_preferences: cross-user email_address UPDATE must be denied';
  ASSERT pg_temp.write_denied($q$DELETE FROM public.notification_preferences
          WHERE user_id = '00000000-0000-0000-0000-0000000000c2'$q$),
    'notification_preferences: cross-user DELETE must be denied';
  ASSERT pg_temp.is_rejected($q$INSERT INTO public.notification_preferences (user_id, channel, enabled)
          VALUES ('00000000-0000-0000-0000-0000000000c2', 'sms', true)$q$),
    'notification_preferences: INSERT for another user must be rejected';

  -- own-row write allowed: the settings page toggles a preference with an UPDATE by channel
  ASSERT pg_temp.rows_affected($q$UPDATE public.notification_preferences SET enabled = false
          WHERE user_id = '00000000-0000-0000-0000-0000000000c1' AND channel = 'email'$q$) = 1,
    'notification_preferences: own-row UPDATE must be allowed';
  -- an UPDATE filtered only by channel must still touch just the caller's own row
  ASSERT pg_temp.rows_affected($q$UPDATE public.notification_preferences SET enabled = true
          WHERE channel = 'email'$q$) = 1,
    'notification_preferences: an unfiltered channel UPDATE must affect only the caller''s own row';
END $$;

-- ===========================================================================
-- entity_notes
-- ===========================================================================
-- Plain user without notes permissions
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.entity_notes) = 0,
    'entity_notes: READ without notes:read must be denied';
  ASSERT pg_temp.is_rejected($q$INSERT INTO public.entity_notes (entity_type, entity_id, author_id, content, note_type)
          VALUES ('view_rls_ent', '1', '00000000-0000-0000-0000-0000000000c1', 'x', 'note')$q$),
    'entity_notes: INSERT without notes:create must be rejected';
  ASSERT pg_temp.write_denied($q$UPDATE public.entity_notes SET content = 'x'$q$),
    'entity_notes: UPDATE without notes permissions must be denied';
  ASSERT pg_temp.write_denied($q$DELETE FROM public.entity_notes$q$),
    'entity_notes: DELETE without notes permissions must be denied';
END $$;

-- Editor (notes:read + notes:create) acting as user A
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","roles":["editor"]}', true);

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.entity_notes WHERE entity_type = 'view_rls_ent') = 2,
    'entity_notes: READ with notes:read must be allowed';
  ASSERT pg_temp.rows_affected($q$INSERT INTO public.entity_notes (entity_type, entity_id, author_id, content, note_type)
          VALUES ('view_rls_ent', '1', '00000000-0000-0000-0000-0000000000c1', 'second note by A', 'note')$q$) = 1,
    'entity_notes: own INSERT with notes:create must be allowed';
  ASSERT pg_temp.write_denied($q$UPDATE public.entity_notes SET content = 'edited'
          WHERE content = 'note by B'$q$),
    'entity_notes: UPDATE of another author''s note must be denied';
  ASSERT pg_temp.write_denied($q$DELETE FROM public.entity_notes WHERE content = 'note by B'$q$),
    'entity_notes: DELETE of another author''s note must be denied';
  ASSERT pg_temp.rows_affected($q$UPDATE public.entity_notes SET content = 'edited by A', updated_at = now()
          WHERE content = 'note by A'$q$) = 1,
    'entity_notes: UPDATE of own note must be allowed';
  ASSERT pg_temp.rows_affected($q$DELETE FROM public.entity_notes WHERE content = 'edited by A'$q$) = 1,
    'entity_notes: DELETE of own note must be allowed';
END $$;

-- ===========================================================================
-- civic_os_users (read-only view that masks private columns)
-- ===========================================================================
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","roles":["user"]}', true);

DO $$
DECLARE own public.civic_os_users; other public.civic_os_users;
BEGIN
  SELECT * INTO own FROM public.civic_os_users WHERE id = '00000000-0000-0000-0000-0000000000c1';
  SELECT * INTO other FROM public.civic_os_users WHERE id = '00000000-0000-0000-0000-0000000000c2';
  ASSERT own.email = 'a@example.invalid', 'civic_os_users: own private columns must be readable';
  ASSERT other.display_name = 'view rls test B', 'civic_os_users: public display name must stay visible';
  ASSERT other.email IS NULL AND other.phone IS NULL AND other.first_name IS NULL
         AND other.last_name IS NULL AND other.full_name IS NULL,
    'civic_os_users: another user''s private columns must be NULL';
  ASSERT pg_temp.is_rejected($q$UPDATE public.civic_os_users SET display_name = 'x'
          WHERE id = '00000000-0000-0000-0000-0000000000c2'$q$),
    'civic_os_users: writes through the view must be rejected';
  ASSERT pg_temp.is_rejected($q$DELETE FROM public.civic_os_users
          WHERE id = '00000000-0000-0000-0000-0000000000c2'$q$),
    'civic_os_users: deletes through the view must be rejected';
END $$;

-- ===========================================================================
-- payment_transactions / payment_refunds
-- ===========================================================================
-- Another user (A): sees nothing, cannot write
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.payment_transactions) = 0,
    'payment_transactions: cross-user READ must be denied';
  ASSERT (SELECT count(*) FROM public.payment_refunds) = 0,
    'payment_refunds: READ without payment_refunds:read must be denied';
  ASSERT pg_temp.is_rejected($q$UPDATE public.payment_transactions SET description = 'x'$q$),
    'payment_transactions: writes must be rejected';
  ASSERT pg_temp.is_rejected($q$DELETE FROM public.payment_transactions$q$),
    'payment_transactions: deletes must be rejected';
  ASSERT pg_temp.is_rejected($q$UPDATE public.payment_refunds SET reason = 'x'$q$),
    'payment_refunds: writes must be rejected';
END $$;

-- The payer (B): own read allowed, refund aggregates correct, still no writes
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated","roles":["user"]}', true);

DO $$
DECLARE pay public.payment_transactions;
BEGIN
  SELECT * INTO pay FROM public.payment_transactions;
  ASSERT pay.id = '11111111-1111-1111-1111-1111111111c2', 'payment_transactions: own-row READ must be allowed';
  ASSERT pay.total_refunded = 10 AND pay.refund_count = 1 AND pay.effective_status = 'partially_refunded',
    format('payment_transactions: refund aggregates must stay correct for the payer (refunded=%s count=%s status=%s)',
           pay.total_refunded, pay.refund_count, pay.effective_status);
  ASSERT (SELECT count(*) FROM public.payment_refunds) = 0,
    'payment_refunds: refund rows stay restricted to payment_refunds:read, as in the base-table policy';
  ASSERT pg_temp.is_rejected($q$UPDATE public.payment_transactions SET description = 'x'$q$),
    'payment_transactions: the payer cannot write through the view';
END $$;

-- Role holding payment_transactions:read and payment_refunds:read
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","roles":["editor"]}', true);

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.payment_transactions) >= 1,
    'payment_transactions: a role with payment_transactions:read must see payments';
  ASSERT (SELECT count(*) FROM public.payment_refunds) >= 1,
    'payment_refunds: a role with payment_refunds:read must see refunds';
END $$;

-- ===========================================================================
-- Anonymous (web_anon)
-- ===========================================================================
RESET ROLE;
SET LOCAL ROLE web_anon;
SELECT set_config('request.jwt.claims', '{}', true);

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.payment_transactions) = 0,
    'payment_transactions: anonymous READ must be denied';
  ASSERT (SELECT count(*) FROM public.civic_os_users
          WHERE id = '00000000-0000-0000-0000-0000000000c2' AND (email IS NOT NULL OR phone IS NOT NULL)) = 0,
    'civic_os_users: anonymous callers must not see private columns';
  ASSERT pg_temp.is_rejected($q$UPDATE public.payment_transactions SET description = 'x'$q$),
    'payment_transactions: anonymous writes must be rejected';
END $$;

ROLLBACK;
SQL
then
  echo "PASS: public views enforce row-level security (reads and writes, as authenticator -> authenticated/web_anon)"
else
  echo "FAIL: a public view bypassed row-level security (see error above)"
  exit 1
fi
