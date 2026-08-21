-- Revert civic_os:v0-70-0-trackable-notifications from pg

BEGIN;

-- Drop RPCs (in public schema for PostgREST exposure)
DROP FUNCTION IF EXISTS public.admin_set_bulk_email_unsubscribe(UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.admin_get_user_bulk_subscriptions(UUID);
DROP FUNCTION IF EXISTS public.set_bulk_email_unsubscribe(TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.get_user_bulk_subscriptions();

-- Drop public VIEWs (PostgREST exposure)
DROP VIEW IF EXISTS public.notification_tracking_stats;
DROP VIEW IF EXISTS public.notification_events;
DROP VIEW IF EXISTS public.notification_settings;
DROP VIEW IF EXISTS public.notification_tracking_tokens;

-- Drop aggregation VIEW
DROP VIEW IF EXISTS metadata.notification_tracking_stats;

-- Drop public VIEWs that depend on the columns we're about to remove
DROP VIEW IF EXISTS public.notification_preferences;
DROP VIEW IF EXISTS public.notification_templates;

-- Drop altered columns
ALTER TABLE metadata.notification_preferences
    DROP COLUMN IF EXISTS bulk_email_unsubscribed_templates;
ALTER TABLE metadata.notification_templates
    DROP COLUMN IF EXISTS is_bulk;

-- Recreate public VIEWs without the removed columns
CREATE OR REPLACE VIEW public.notification_preferences AS
    SELECT * FROM metadata.notification_preferences;
CREATE OR REPLACE VIEW public.notification_templates AS
    SELECT * FROM metadata.notification_templates;

-- Drop new tables (order matters: events references tokens)
DROP TABLE IF EXISTS metadata.notification_events;
DROP TABLE IF EXISTS metadata.notification_settings;
DROP TABLE IF EXISTS metadata.notification_tracking_tokens;

COMMIT;
