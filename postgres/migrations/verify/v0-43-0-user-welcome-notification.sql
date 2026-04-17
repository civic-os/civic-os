-- Verify civic_os:v0-43-0-user-welcome-notification on pg

BEGIN;

-- Verify the user_welcome template exists
SELECT 1/COUNT(*) FROM metadata.notification_templates WHERE name = 'user_welcome';

-- Verify send_welcome_sms column exists
SELECT send_welcome_sms FROM metadata.user_provisioning LIMIT 0;

ROLLBACK;
