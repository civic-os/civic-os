-- Revert civic_os:v0-11-0-add-notifications from pg

BEGIN;

-- Drop RLS policies (in case CASCADE doesn't catch them)
DROP POLICY IF EXISTS "Users see validation part results" ON metadata.template_part_validation_results;
DROP POLICY IF EXISTS "Users see own validation results" ON metadata.template_validation_results;
DROP POLICY IF EXISTS "All can view templates" ON metadata.notification_templates;
DROP POLICY IF EXISTS "Admins manage templates" ON metadata.notification_templates;
DROP POLICY IF EXISTS "Users manage own preferences" ON metadata.notification_preferences;
DROP POLICY IF EXISTS "Users can create notifications" ON metadata.notifications;
DROP POLICY IF EXISTS "Users see own notifications" ON metadata.notifications;

-- Drop public views
DROP VIEW IF EXISTS public.notification_preferences CASCADE;
DROP VIEW IF EXISTS public.notification_templates CASCADE;

-- Drop tables (CASCADE removes dependent objects including triggers, indexes, constraints)
DROP TABLE IF EXISTS metadata.template_part_validation_results CASCADE;
DROP TABLE IF EXISTS metadata.template_validation_results CASCADE;
DROP TABLE IF EXISTS metadata.notifications CASCADE;
DROP TABLE IF EXISTS metadata.notification_preferences CASCADE;
DROP TABLE IF EXISTS metadata.notification_templates CASCADE;

-- Drop functions (CASCADE removes dependent triggers)
DROP FUNCTION IF EXISTS cleanup_old_validation_results() CASCADE;
DROP FUNCTION IF EXISTS preview_template_parts(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) CASCADE;
DROP FUNCTION IF EXISTS validate_template_parts(UUID, TEXT, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS enqueue_notification_job() CASCADE;
DROP FUNCTION IF EXISTS create_notification(UUID, VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT[]) CASCADE;
DROP FUNCTION IF EXISTS create_default_notification_preferences() CASCADE;

COMMIT;
