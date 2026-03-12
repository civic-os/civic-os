-- Verify civic_os:v0-35-0-admin-notification-prefs on pg

BEGIN;

-- Verify admin RPCs exist and are executable by authenticated role
SELECT has_function_privilege('authenticated', 'admin_get_user_notification_preferences(uuid)', 'execute');
SELECT has_function_privilege('authenticated', 'admin_update_notification_preference(uuid, text, boolean, boolean)', 'execute');

-- Verify managed_users view has notification columns
SELECT email_notif_enabled, sms_notif_enabled, sms_opted_out
FROM public.managed_users
LIMIT 0;

-- Verify RLS policies exist on notification_preferences
SELECT 1 FROM pg_policies
WHERE tablename = 'notification_preferences' AND policyname = 'Admin read all preferences';

SELECT 1 FROM pg_policies
WHERE tablename = 'notification_preferences' AND policyname = 'Admin update all preferences';

-- Verify authenticated has SELECT, UPDATE on notification_preferences
SELECT has_table_privilege('authenticated', 'metadata.notification_preferences', 'select');
SELECT has_table_privilege('authenticated', 'metadata.notification_preferences', 'update');

ROLLBACK;
