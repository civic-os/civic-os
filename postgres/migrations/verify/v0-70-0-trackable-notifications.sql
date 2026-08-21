-- Verify civic_os:v0-70-0-trackable-notifications on pg

BEGIN;

-- Tables exist
SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name = 'notification_tracking_tokens';

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name = 'notification_events';

SELECT 1/COUNT(*) FROM information_schema.tables
WHERE table_schema = 'metadata' AND table_name = 'notification_settings';

-- is_bulk column on notification_templates
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'notification_templates'
  AND column_name = 'is_bulk';

-- bulk_email_unsubscribed_templates column on notification_preferences
SELECT 1/COUNT(*) FROM information_schema.columns
WHERE table_schema = 'metadata' AND table_name = 'notification_preferences'
  AND column_name = 'bulk_email_unsubscribed_templates';

-- Aggregation VIEW exists
SELECT 1/COUNT(*) FROM information_schema.views
WHERE table_schema = 'metadata' AND table_name = 'notification_tracking_stats';

-- RPCs exist
SELECT 1/COUNT(*) FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'get_user_bulk_subscriptions';

SELECT 1/COUNT(*) FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'set_bulk_email_unsubscribe';

SELECT 1/COUNT(*) FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'admin_get_user_bulk_subscriptions';

SELECT 1/COUNT(*) FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'admin_set_bulk_email_unsubscribe';

-- Singleton settings row exists
SELECT 1/COUNT(*) FROM metadata.notification_settings WHERE id = 1;

ROLLBACK;
