-- Deploy civic_os:v0-76-9-restore-view-security-invoker to pg
-- requires: v0-76-8-payment-checkout-translations
--
-- Restore row-level security on public views that sit over RLS-protected tables.
--
-- A VIEW runs with its owner's privileges. Civic OS views are owned by a superuser (BYPASSRLS), so a
-- view without security_invoker (or its own per-caller filter) ignores every policy on its base table,
-- for reads and for the writes granted through it. CREATE OR REPLACE VIEW (and DROP + CREATE) also
-- resets view options, which silently undid security_invoker on several views in earlier migrations.
--
-- security_invoker = true restored (the caller's own privileges and RLS apply again; `authenticated`
-- already holds the base-table grants these views need):
--   notification_preferences  v0-50-2 set it, v0-70-0 CREATE OR REPLACE VIEW reset it
--   entity_notes              never set since v0-16-0, which documented that RLS handles permissions
--   civic_os_users            v0-55-2 and v0-65-0 set it, v0-65-2 CREATE OR REPLACE VIEW reset it
--                             (the view also masks private columns with CASE as defense in depth)
--
-- Per-caller filter in the view body + security_barrier (security_invoker is not usable here):
--   payment_transactions, payment_refunds
--   The payments schema is deliberately unreachable by API roles (no USAGE, no table grants) and
--   payment_transactions aggregates payments.refunds, which payers cannot read under RLS, so an invoker
--   view would show payers wrong refund totals and effective_status. The views stay definer views and
--   apply the same predicates as the base-table policies:
--     payment_transactions  user_id = current_user_id() OR has_permission('payment_transactions', 'read')
--     payment_refunds       has_permission('payment_refunds', 'read')
--   security_barrier = true keeps caller-supplied PostgREST filters from running before the view's own
--   WHERE. Column lists, grants and comments are unchanged; web_anon keeps SELECT on
--   payment_transactions so anonymous requests that embed it return no rows instead of failing.
--   Keep these predicates in sync with the policies on payments.transactions / payments.refunds.
--
-- Every later CREATE OR REPLACE VIEW on these views must repeat WITH (security_invoker = true) (or the
-- security_barrier + filter above). CI checks this (tests/functional/view-security-guard-test.sh).

BEGIN;

ALTER VIEW public.notification_preferences SET (security_invoker = true);
ALTER VIEW public.entity_notes SET (security_invoker = true);
ALTER VIEW public.civic_os_users SET (security_invoker = true);

CREATE OR REPLACE VIEW public.payment_transactions
WITH (security_barrier = true) AS
SELECT t.id,
    t.user_id,
    u.display_name AS user_display_name,
    u.full_name AS user_full_name,
    u.email AS user_email,
    t.amount,
    t.processing_fee,
    t.total_amount,
    t.max_refundable,
    t.fee_percent,
    t.fee_flat_cents,
    t.fee_refundable,
    t.currency,
    t.status,
    t.provider_payment_id,
    COALESCE(r_agg.total_refunded, 0::numeric) AS total_refunded,
    COALESCE(r_agg.refund_count, 0::bigint) AS refund_count,
    COALESCE(r_agg.pending_count, 0::bigint) AS pending_refund_count,
        CASE
            WHEN r_agg.total_refunded >= t.max_refundable THEN 'refunded'::text
            WHEN r_agg.total_refunded > 0::numeric THEN 'partially_refunded'::text
            WHEN r_agg.pending_count > 0 THEN 'refund_pending'::text
            ELSE COALESCE(t.status, 'unpaid'::text)
        END AS effective_status,
    t.error_message,
    t.provider,
    t.provider_client_secret,
    t.description,
    t.display_name,
    t.created_at,
    t.updated_at,
    t.entity_type,
    t.entity_id,
    COALESCE(e.display_name, t.entity_type) AS entity_display_name
   FROM payments.transactions t
     LEFT JOIN civic_os_users u ON t.user_id = u.id
     LEFT JOIN entities e ON t.entity_type = e.table_name
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(refunds.amount) FILTER (WHERE refunds.status = 'succeeded'::text), 0::numeric) AS total_refunded,
            count(*) FILTER (WHERE refunds.status = 'succeeded'::text) AS refund_count,
            count(*) FILTER (WHERE refunds.status = 'pending'::text) AS pending_count
           FROM payments.refunds
          WHERE refunds.transaction_id = t.id) r_agg ON true
  WHERE t.user_id = metadata.current_user_id()
     OR metadata.has_permission('payment_transactions', 'read');

CREATE OR REPLACE VIEW public.payment_refunds
WITH (security_barrier = true) AS
SELECT r.id,
    r.transaction_id,
    r.amount,
    r.reason,
    r.initiated_by,
    u.display_name AS initiated_by_name,
    r.provider_refund_id,
    r.status,
    r.error_message,
    r.created_at,
    r.processed_at,
    t.amount AS payment_amount,
    t.description AS payment_description,
    t.provider_payment_id
   FROM payments.refunds r
     LEFT JOIN civic_os_users u ON r.initiated_by = u.id
     LEFT JOIN payments.transactions t ON r.transaction_id = t.id
  WHERE metadata.has_permission('payment_refunds', 'read');

NOTIFY pgrst, 'reload schema';

COMMIT;
