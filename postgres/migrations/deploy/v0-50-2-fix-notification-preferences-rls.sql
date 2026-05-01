-- Deploy civic_os:v0-50-2-fix-notification-preferences-rls to pg
-- requires: v0-50-1-phone-search-tokens

BEGIN;

-- ============================================================================
-- Fix notification_preferences VIEW missing security_invoker
-- ============================================================================
-- The public.notification_preferences VIEW was created without
-- security_invoker = true, causing it to execute as the view definer
-- (owner) rather than the calling user. This bypassed the RLS policies
-- on metadata.notification_preferences, exposing all users' preferences
-- to any authenticated user via PostgREST.
--
-- The base table has correct RLS policies:
--   - "Users manage own preferences": user_id = current_user_id()
--   - "Admin read all preferences": has_permission('civic_os_users_private', 'read')
--   - "Admin update all preferences": has_permission('civic_os_users_private', 'update')
--
-- Adding security_invoker = true makes the VIEW respect these policies.

ALTER VIEW public.notification_preferences SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';

COMMIT;
