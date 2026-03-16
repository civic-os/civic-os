-- Verify civic_os:v0-38-4-fix-admin-notif-pref-permission
-- Check that the function source references 'update' not 'read'

SELECT 1 FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'admin_get_user_notification_preferences'
  AND pg_get_functiondef(p.oid) LIKE '%civic_os_users_private%update%';
