-- Verify civic_os:v0-11-0-add-notifications on pg

BEGIN;

-- ===========================================================================
-- Verify Tables Exist with Correct Structure
-- ===========================================================================

-- Verify notification_templates table structure
SELECT id, name, description, subject_template, html_template, text_template,
       sms_template, entity_type, created_at, updated_at
FROM metadata.notification_templates
WHERE FALSE;

-- Verify notification_preferences table structure
SELECT user_id, channel, enabled, email_address, phone_number, created_at, updated_at
FROM metadata.notification_preferences
WHERE FALSE;

-- Verify notifications table structure
SELECT id, user_id, template_name, entity_type, entity_id, entity_data,
       channels, status, sent_at, error_message, channels_sent, channels_failed, created_at
FROM metadata.notifications
WHERE FALSE;

-- Verify template_validation_results table structure
SELECT id, subject_template, html_template, text_template, sms_template,
       status, created_at, completed_at
FROM metadata.template_validation_results
WHERE FALSE;

-- Verify template_part_validation_results table structure
SELECT id, validation_id, part_name, valid, error_message, created_at
FROM metadata.template_part_validation_results
WHERE FALSE;


-- ===========================================================================
-- Verify Indexes Exist
-- ===========================================================================

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notification_templates' AND indexname = 'idx_notification_templates_name';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notification_preferences' AND indexname = 'idx_notification_preferences_user_id';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND indexname = 'idx_notifications_user_id';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND indexname = 'idx_notifications_status';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND indexname = 'idx_notifications_created_at';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND indexname = 'idx_notifications_entity';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND indexname = 'idx_notifications_template';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'template_validation_results' AND indexname = 'idx_template_validation_results_status';

SELECT 1/(COUNT(*))::int FROM pg_indexes
WHERE schemaname = 'metadata' AND tablename = 'template_part_validation_results' AND indexname = 'idx_part_validation_results_validation_id';


-- ===========================================================================
-- Verify Functions Exist
-- ===========================================================================

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'create_default_notification_preferences';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'create_notification';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'enqueue_notification_job';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'validate_template_parts';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'preview_template_parts';

SELECT 1/(COUNT(*))::int FROM pg_proc
WHERE proname = 'cleanup_old_validation_results';


-- ===========================================================================
-- Verify Triggers Exist
-- ===========================================================================

SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'create_default_notification_preferences_trigger';

SELECT 1/(COUNT(*))::int FROM pg_trigger
WHERE tgname = 'enqueue_notification_job_trigger';


-- ===========================================================================
-- Verify Row Level Security is Enabled
-- ===========================================================================

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'notification_preferences' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'notification_templates' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'template_validation_results' AND rowsecurity = true;

SELECT 1/(COUNT(*))::int FROM pg_tables
WHERE schemaname = 'metadata' AND tablename = 'template_part_validation_results' AND rowsecurity = true;


-- ===========================================================================
-- Verify RLS Policies Exist
-- ===========================================================================

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND policyname = 'Users see own notifications';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'notifications' AND policyname = 'Users can create notifications';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'notification_preferences' AND policyname = 'Users manage own preferences';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'notification_templates' AND policyname = 'Admins manage templates';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'notification_templates' AND policyname = 'All can view templates';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'template_validation_results' AND policyname = 'Users see own validation results';

SELECT 1/(COUNT(*))::int FROM pg_policies
WHERE schemaname = 'metadata' AND tablename = 'template_part_validation_results' AND policyname = 'Users see validation part results';


-- ===========================================================================
-- Verify Constraints
-- ===========================================================================

-- Verify notifications.status constraint
DO $$
BEGIN
  ASSERT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname = 'valid_status'
      AND conrelid = 'metadata.notifications'::regclass
  ), 'notifications.status constraint missing';
END $$;

-- Verify notifications.channels constraint
DO $$
BEGIN
  ASSERT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname = 'valid_channels'
      AND conrelid = 'metadata.notifications'::regclass
  ), 'notifications.channels constraint missing';
END $$;

-- Verify notification_preferences.channel constraint
DO $$
BEGIN
  ASSERT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname = 'valid_channel'
      AND conrelid = 'metadata.notification_preferences'::regclass
  ), 'notification_preferences.channel constraint missing';
END $$;


-- ===========================================================================
-- Test Functions Actually Work
-- ===========================================================================

-- Test cleanup_old_validation_results() can be called
DO $$
BEGIN
  PERFORM cleanup_old_validation_results();
END $$;

-- Note: We cannot test create_notification(), validate_template_parts(), or preview_template_parts()
-- here because they require:
-- 1. Valid user IDs (civic_os_users)
-- 2. Valid template names (notification_templates)
-- 3. Running River workers to process jobs
-- These will be tested in integration tests after workers are deployed.

ROLLBACK;
