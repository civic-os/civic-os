-- Verify civic_os:v0-76-11-secure-payment-views
--
-- Accepts either hardening method (this change's security_barrier + in-view caller filter, or a
-- later switch to security_invoker) so the check also holds on a fully deployed database.

BEGIN;

SELECT 1/COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'payment_transactions'
  AND (c.reloptions @> ARRAY['security_invoker=true']
       OR (c.reloptions @> ARRAY['security_barrier=true']
           AND pg_get_viewdef(c.oid) LIKE '%has_permission(%payment_transactions%'));

SELECT 1/COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'payment_refunds'
  AND (c.reloptions @> ARRAY['security_invoker=true']
       OR (c.reloptions @> ARRAY['security_barrier=true']
           AND pg_get_viewdef(c.oid) LIKE '%has_permission(%payment_refunds%'));

ROLLBACK;
