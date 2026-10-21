-- Verify civic_os:v0-76-9-restore-view-security-invoker
--
-- Each view must be protected by security_invoker, or (payment views) by security_barrier plus an
-- in-view permission filter; either method satisfies the check so it also holds on a fully deployed
-- database after later hardening.

BEGIN;

SELECT 1/COUNT(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'notification_preferences'
  AND c.reloptions @> ARRAY['security_invoker=true'];

SELECT 1/COUNT(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'entity_notes'
  AND c.reloptions @> ARRAY['security_invoker=true'];

SELECT 1/COUNT(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'civic_os_users'
  AND c.reloptions @> ARRAY['security_invoker=true'];

SELECT 1/COUNT(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'payment_transactions'
  AND (c.reloptions @> ARRAY['security_invoker=true']
       OR (c.reloptions @> ARRAY['security_barrier=true']
           AND pg_get_viewdef(c.oid) LIKE '%has_permission(%payment_transactions%'));

SELECT 1/COUNT(*)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'payment_refunds'
  AND (c.reloptions @> ARRAY['security_invoker=true']
       OR (c.reloptions @> ARRAY['security_barrier=true']
           AND pg_get_viewdef(c.oid) LIKE '%has_permission(%payment_refunds%'));

ROLLBACK;
