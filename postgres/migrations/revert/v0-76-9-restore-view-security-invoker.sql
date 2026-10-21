-- Revert civic_os:v0-76-9-restore-view-security-invoker from pg
--
-- WARNING: restores the previous definitions and options, in which these views run with their owner's
-- rights and bypass row-level security on their base tables. Intended only for round-trip migration
-- testing.

BEGIN;

CREATE OR REPLACE VIEW public.payment_transactions AS
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
          WHERE refunds.transaction_id = t.id) r_agg ON true;

CREATE OR REPLACE VIEW public.payment_refunds AS
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
     LEFT JOIN payments.transactions t ON r.transaction_id = t.id;

ALTER VIEW public.payment_transactions RESET (security_barrier);
ALTER VIEW public.payment_refunds RESET (security_barrier);

ALTER VIEW public.civic_os_users RESET (security_invoker);
ALTER VIEW public.entity_notes RESET (security_invoker);
ALTER VIEW public.notification_preferences RESET (security_invoker);

NOTIFY pgrst, 'reload schema';

COMMIT;
