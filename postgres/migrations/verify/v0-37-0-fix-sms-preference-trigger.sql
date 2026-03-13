-- Verify civic_os:v0-37-0-fix-sms-preference-trigger

-- Verify trigger fires on UPDATE OF phone (not just INSERT)
SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'create_default_notification_preferences_trigger'
  AND tgtype & 16 = 16;  -- bit 4 = UPDATE event
