-- Deploy civic_os:v0-76-11-secure-payment-views to pg
-- requires: v0-76-10-restore-civic-os-users-security-invoker
--
-- Security fix: public.payment_transactions and public.payment_refunds returned EVERY row to ANY
-- caller, including anonymous ones.
--
-- Both views are owned by a superuser (BYPASSRLS) and had no per-caller filter, so the RLS policies on
-- payments.transactions / payments.refunds never applied through them. `authenticated` has SELECT on
-- both views and `web_anon` on payment_transactions, so through PostgREST anyone could read every
-- user's payments (amounts, descriptions, entity references, error messages, and the Stripe
-- provider_client_secret) and every refund.
--
-- security_invoker is NOT used here: the payments schema is deliberately unreachable by API roles
-- (no USAGE for web_anon, no table grants), and the transactions view aggregates payments.refunds,
-- which payment owners cannot read under RLS, so an invoker view would show owners wrong refund
-- totals and effective_status. Instead the views stay definer views and apply the same predicates as
-- the base-table policies:
--
--   payment_transactions  rows where user_id = current_user_id()
--                         OR has_permission('payment_transactions', 'read')
--                         (policies "Users see own payments" / "Payment managers see all payments")
--   payment_refunds       rows where has_permission('payment_refunds', 'read')
--                         (policy "Refund managers see refunds")
--
-- Both predicates call SECURITY DEFINER functions that read the JWT claims, so they work for any
-- caller role. security_barrier = true stops the planner from evaluating a caller-supplied filter
-- (PostgREST ?col=op.value) before the view's own WHERE, which could otherwise leak hidden rows
-- through error messages or timing. Column lists, grants and comments are unchanged.
--
-- Keep these predicates in sync with the policies on payments.transactions / payments.refunds.
-- web_anon keeps SELECT on payment_transactions so anonymous requests that embed the view return
-- no rows instead of failing with "permission denied".

BEGIN;

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
