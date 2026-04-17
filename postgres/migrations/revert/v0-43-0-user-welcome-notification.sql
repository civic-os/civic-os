-- Revert civic_os:v0-43-0-user-welcome-notification from pg

BEGIN;

-- Remove the user_welcome notification template
DELETE FROM metadata.notification_templates WHERE name = 'user_welcome';

-- Restore original column comment
COMMENT ON COLUMN metadata.user_provisioning.send_welcome_email IS
    'When true, the Go worker sends a Keycloak "set password" email after provisioning.';

NOTIFY pgrst, 'reload schema';

COMMIT;
