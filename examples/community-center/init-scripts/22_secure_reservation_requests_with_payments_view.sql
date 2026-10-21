-- 22_secure_reservation_requests_with_payments_view.sql
-- Community Center example: public.reservation_requests_with_payments (script 10) was a plain view
-- over reservation_requests and payments.transactions. Views run with their owner's rights (a
-- superuser), so it ignored RLS on both tables.
--
-- It is now security_invoker, so RLS on reservation_requests applies to the caller, and the payment
-- columns come from the caller-filtered public.payment_transactions view instead of reading
-- payments.transactions directly (API roles have no access to the payments schema).
--
-- Supersedes the definition in 10_payment_integration.sql (migration-first: that script is left as
-- shipped). Column list and grants are unchanged. Safe to re-run.

BEGIN;

CREATE OR REPLACE VIEW public.reservation_requests_with_payments
WITH (security_invoker = true) AS
SELECT
  rr.id,
  rr.resource_id,
  rr.requested_by,
  rr.time_slot,
  rr.status_id,
  rr.purpose,
  rr.attendee_count,
  rr.notes,
  rr.reviewed_by,
  rr.reviewed_at,
  rr.denial_reason,
  rr.reservation_id,
  rr.payment_transaction_id,
  rr.created_at,
  rr.updated_at,
  rr.display_name,

  -- Resource info (embedded)
  res.display_name AS resource_name,
  res.hourly_rate AS resource_hourly_rate,

  -- Calculated cost
  public.calculate_reservation_cost(rr.resource_id, rr.time_slot) AS calculated_cost,

  -- Payment status (if payment exists and is visible to the caller)
  p.status AS payment_status,
  p.amount AS payment_amount,
  p.currency AS payment_currency,
  p.provider_payment_id,
  p.error_message AS payment_error_message,

  -- Payment required flag
  CASE
    WHEN res.hourly_rate IS NULL THEN FALSE
    WHEN res.hourly_rate::numeric <= 0 THEN FALSE
    ELSE TRUE
  END AS payment_required

FROM public.reservation_requests rr
JOIN public.resources res ON rr.resource_id = res.id
LEFT JOIN public.payment_transactions p ON rr.payment_transaction_id = p.id;

COMMIT;
