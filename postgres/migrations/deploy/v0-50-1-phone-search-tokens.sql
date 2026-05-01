-- Deploy civic_os:v0-50-1-phone-search-tokens to pg
-- requires: v0-49-1-user-search-modal

BEGIN;

-- ============================================================================
-- 1. CREATE phone_search_tokens() function
-- ============================================================================
-- Pre-computes searchable phone fragments for GIN-indexed tsvector lookup.
-- Accepts phone_number domain (10-digit CHECK enforced by domain).
-- IMMUTABLE STRICT enables use in generated columns.
--
-- For input '3135551234', produces:
--   '3135551234 313 555 1234 5551234 313555'
-- so that searching for any fragment (area code, exchange, last 4, etc.)
-- matches the tsvector.

CREATE OR REPLACE FUNCTION public.phone_search_tokens(p_phone phone_number)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT
    p_phone || ' ' ||
    substring(p_phone, 1, 3) || ' ' ||   -- area code:      313
    substring(p_phone, 4, 3) || ' ' ||   -- exchange:        555
    substring(p_phone, 7, 4) || ' ' ||   -- last 4:          1234
    substring(p_phone, 4, 7) || ' ' ||   -- last 7:          5551234
    substring(p_phone, 1, 6);            -- area+exchange:   313555
$$;


-- ============================================================================
-- 2. DROP civic_os_users VIEW (CASCADE to dependent views)
-- ============================================================================
-- Modifying a VIEW expression requires DROP + CREATE. CASCADE is needed
-- because payment_transactions and payment_refunds JOIN against civic_os_users.

DROP VIEW IF EXISTS public.civic_os_users CASCADE;


-- ============================================================================
-- 3. RECREATE civic_os_users VIEW with phone_search_tokens
-- ============================================================================
-- Changes from v0-49-1:
--   a) Phone field uses phone_search_tokens() for fragment-based search.
--      Safe cast with regex guard since civic_os_users_private.phone is still
--      VARCHAR(255), not phone_number domain. Non-conforming values fall back
--      to raw text (same behavior as before).
--   b) Both branches keep 'english' text config. English stemming does not
--      modify numeric tokens, so phone fragments are unaffected. Keeping
--      'english' ensures name searches work with PostgREST's default
--      text search config (which uses 'english' for websearch_to_tsquery).

CREATE VIEW public.civic_os_users AS
SELECT
  u.id,
  u.display_name,
  u.created_at,
  u.updated_at,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.display_name
    ELSE NULL
  END AS full_name,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.email
    ELSE NULL
  END AS email,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN p.phone
    ELSE NULL
  END AS phone,
  CASE
    WHEN u.id = public.current_user_id()
         OR public.has_permission('civic_os_users_private', 'read')
    THEN to_tsvector('english',
      COALESCE(u.display_name, '') || ' ' ||
      COALESCE(p.display_name, '') || ' ' ||
      COALESCE(replace(replace(p.email::text, '@', ' '), '.', ' '), '') || ' ' ||
      CASE WHEN p.phone ~ '^\d{10}$'
           THEN phone_search_tokens(p.phone::phone_number)
           ELSE COALESCE(p.phone::text, '') END)
    ELSE to_tsvector('english', COALESCE(u.display_name, ''))
  END AS civic_os_text_search
FROM metadata.civic_os_users u
LEFT JOIN metadata.civic_os_users_private p ON p.id = u.id;

ALTER VIEW public.civic_os_users SET (security_invoker = true);

GRANT SELECT ON public.civic_os_users TO web_anon, authenticated;


-- ============================================================================
-- 4. RECREATE payment_transactions VIEW (dropped by CASCADE)
-- ============================================================================
-- Restored from v0-49-1-user-search-modal (verbatim)

CREATE VIEW public.payment_transactions AS
SELECT
    t.id,
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
    COALESCE(r_agg.total_refunded, 0) AS total_refunded,
    COALESCE(r_agg.refund_count, 0) AS refund_count,
    COALESCE(r_agg.pending_count, 0) AS pending_refund_count,
    CASE
        WHEN r_agg.total_refunded >= t.max_refundable THEN 'refunded'
        WHEN r_agg.total_refunded > 0 THEN 'partially_refunded'
        WHEN r_agg.pending_count > 0 THEN 'refund_pending'
        ELSE COALESCE(t.status, 'unpaid')
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
LEFT JOIN public.civic_os_users u ON t.user_id = u.id
LEFT JOIN metadata.entities e ON t.entity_type = e.table_name
LEFT JOIN LATERAL (
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS total_refunded,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS refund_count,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM payments.refunds
    WHERE transaction_id = t.id
) r_agg ON true;

GRANT SELECT ON public.payment_transactions TO authenticated, web_anon;


-- ============================================================================
-- 5. RECREATE payment_refunds VIEW (dropped by CASCADE)
-- ============================================================================
-- Restored from v0-49-1-user-search-modal (verbatim)

CREATE VIEW public.payment_refunds AS
SELECT
    r.id,
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
LEFT JOIN public.civic_os_users u ON r.initiated_by = u.id
LEFT JOIN payments.transactions t ON r.transaction_id = t.id;

GRANT SELECT ON public.payment_refunds TO authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
